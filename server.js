"use strict";
const express = require("express");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const path = require("node:path");
const {promisify} = require("node:util");
const {createClient} = require("@libsql/client");
const C = require("./config");
const M = require("./mpesa");

const PROD = process.env.NODE_ENV === "production";
const PORT = +process.env.PORT || 3000;
const GID = process.env.GOOGLE_CLIENT_ID || "";
const APP_SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString("hex"); /* only signs short-lived Google setup tokens */
const SESSION_MS = 14 * 24 * 3600 * 1000;
const scrypt = promisify(crypto.scrypt);

/* ---------- Database (Turso / libSQL: SQLite over the network) ----------
   Production: set TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN. Local development and tests: no Turso variables needed,
   it uses the local file DB_PATH (default smd.db), exactly like before. Every call is async, so every use is awaited. */
const DB_URL = process.env.TURSO_DATABASE_URL || "file:" + (process.env.DB_PATH || path.join(__dirname, "smd.db"));
const db = createClient({url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined});
const plain = (r) => (r ? {...r} : undefined); /* library rows -> ordinary mutable objects */
const q = (sql) => ({
  get: async (...a) => plain((await db.execute({sql, args: a})).rows[0]),
  all: async (...a) => (await db.execute({sql, args: a})).rows.map(plain),
  run: async (...a) => { const r = await db.execute({sql, args: a}); return {changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid}; }
});
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('sender','shipper')), veh TEXT, area TEXT, pw TEXT, google INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resets(uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ch TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shops(uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, area TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(uid,area,name COLLATE NOCASE));
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, shop TEXT NOT NULL,
  src TEXT NOT NULL, dst TEXT NOT NULL, land TEXT NOT NULL, drop_ TEXT NOT NULL, pp TEXT, dp TEXT, item TEXT NOT NULL, w INTEGER NOT NULL, spd TEXT NOT NULL,
  rn TEXT NOT NULL, rp TEXT NOT NULL, price INTEGER NOT NULL, step INTEGER NOT NULL DEFAULT 0,
  shipper INTEGER REFERENCES users(id) ON DELETE SET NULL, sname TEXT, sphone TEXT, veh TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS d_open ON deliveries(step, shipper, src);
CREATE INDEX IF NOT EXISTS d_owner ON deliveries(owner);
CREATE INDEX IF NOT EXISTS d_ship ON deliveries(shipper);
`;
const SCHEMA2 = `
CREATE UNIQUE INDEX IF NOT EXISTS u_idnum ON users(id_type, id_number) WHERE id_number IS NOT NULL;
CREATE TABLE IF NOT EXISTS email_codes(uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ch TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_shops(id INTEGER PRIMARY KEY, area TEXT NOT NULL, name TEXT NOT NULL, recommended INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cs_uni ON catalog_shops(area, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS catalog_items(id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL REFERENCES catalog_shops(id) ON DELETE CASCADE, name TEXT NOT NULL, unit TEXT NOT NULL, price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS ci_uni ON catalog_items(shop_id, name COLLATE NOCASE, unit COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS id_docs(uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(uid, kind));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
/* One 1-5 star rating per completed delivery, given by the sender. Plain columns (no foreign keys) so a shipper's rating survives the sender deleting their account. */
CREATE TABLE IF NOT EXISTS ratings(delivery_id TEXT PRIMARY KEY, shipper INTEGER NOT NULL, owner INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS r_ship ON ratings(shipper);
/* Browser push subscriptions of shippers (one row per device) */
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, uid INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ps_uid ON push_subs(uid);
/* Admin-set delivery fee for one pair of places (a|b stored in sorted order, so Likoni->Mombasa and Mombasa->Likoni share one fee) */
CREATE TABLE IF NOT EXISTS fees(a TEXT NOT NULL, b TEXT NOT NULL, fee INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL, uid INTEGER NOT NULL, phone TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiating', checkout_id TEXT UNIQUE, merchant_id TEXT, result_code INTEGER, result_desc TEXT, receipt TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pay_del ON payments(delivery_id);
CREATE UNIQUE INDEX IF NOT EXISTS pay_active ON payments(delivery_id) WHERE status IN ('initiating','pending');
`;
/* Adds a column to an older database; harmless if it is already there. Returns true only when the column was just added. */
async function addCol(table, col, def) {
  try { await db.execute("ALTER TABLE " + table + " ADD COLUMN " + col + " " + def); return true; }
  catch (e) { if (/duplicate column/i.test(String(e.message))) return false; throw e; }
}
/* Accounts that already existed before email verification / shipper approval are grandfathered: email counted as verified, shippers as approved. */
async function migrate() {
  if (await addCol("users", "email_verified", "INTEGER NOT NULL DEFAULT 0")) await db.execute("UPDATE users SET email_verified=1");
  for (const [c, d] of [["is_admin", "INTEGER NOT NULL DEFAULT 0"], ["status", "TEXT NOT NULL DEFAULT 'approved'"], ["id_type", "TEXT"], ["id_number", "TEXT"], ["dob", "TEXT"], ["address", "TEXT"], ["reject_reason", "TEXT"], ["reviewed_at", "INTEGER"], ["is_owner", "INTEGER NOT NULL DEFAULT 0"]]) await addCol("users", c, d);
  if (await addCol("deliveries", "notified", "INTEGER NOT NULL DEFAULT 0")) await db.execute("UPDATE deliveries SET notified=1"); /* old jobs are never announced */
  for (const [c, d] of [["items", "TEXT"], ["goods", "INTEGER NOT NULL DEFAULT 0"], ["custom", "TEXT NOT NULL DEFAULT ''"], ["ship_ok", "INTEGER"], ["own_ok", "INTEGER"],
    /* pay: 'cod' (pay on delivery) or 'mpesa'. pay_state: 'na' | 'awaiting' (M-Pesa chosen, not yet paid: hidden from the job board) | 'paid' */
    ["pay", "TEXT NOT NULL DEFAULT 'cod'"], ["pay_state", "TEXT NOT NULL DEFAULT 'na'"], ["receipt", "TEXT"]]) await addCol("deliveries", c, d);
}

/* Sample shops and goods so the app is usable on day one. Seeded once only (flag kept in the meta table); the admin replaces them in the app (Shops tab). */
async function seedCatalog() {
  if (await q("SELECT v FROM meta WHERE k='seeded'").get()) return;
  const G = [["Sugar", "1 kg", 220], ["Maize flour (unga)", "2 kg", 190], ["Rice", "1 kg", 200], ["Cooking oil", "1 litre", 330], ["Milk", "500 ml", 65], ["Bread", "1 loaf", 70], ["Eggs", "1 tray (30)", 480]];
  const H = [["Paracetamol 500mg", "strip of 10", 40], ["Bandage roll", "1 roll", 60], ["Hand sanitiser", "100 ml", 150], ["ORS sachet", "1 sachet", 30]];
  /* One transaction: either everything is seeded or nothing is. INSERT OR IGNORE + lookups make a repeat after a half-finished earlier run harmless. */
  const now = Date.now(), stmts = [];
  for (const sh of C.SHOPS) {
    stmts.push({sql: "INSERT INTO catalog_shops(area,name,recommended,active,created) SELECT ?,?,1,1,? WHERE NOT EXISTS (SELECT 1 FROM catalog_shops WHERE area=? AND name=? COLLATE NOCASE)", args: [sh.a, sh.n, now, sh.a, sh.n]});
    for (const [n, u, p] of /pharmacy/i.test(sh.n) ? H : G)
      stmts.push({sql: "INSERT INTO catalog_items(shop_id,name,unit,price,active) SELECT id,?,?,?,1 FROM catalog_shops WHERE area=? AND name=? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM catalog_items i WHERE i.shop_id=catalog_shops.id AND i.name=?)", args: [n, u, p, sh.a, sh.n, n]});
  }
  stmts.push({sql: "INSERT INTO meta(k,v) SELECT 'seeded','1' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k='seeded')", args: []});
  await db.batch(stmts, "write");
}

/* Route fees set by the admin, cached in memory (reloaded after every change). Key = "A|B" (sorted). */
let FEES = {};
async function loadFees() {
  const o = {};
  for (const r of await q("SELECT a,b,fee FROM fees").all()) if (Object.hasOwn(C.AREAS, r.a) && Object.hasOwn(C.AREAS, r.b)) o[C.feeKey(r.a, r.b)] = r.fee;
  FEES = o;
}
const feeFor = (f, t) => (Object.hasOwn(FEES, C.feeKey(f, t)) ? FEES[C.feeKey(f, t)] : null);

/* Admins are the verified accounts whose email is listed in ADMIN_EMAIL (comma-separated). Nobody can become admin from inside the app. */
const ADMINS = (process.env.ADMIN_EMAIL || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
async function syncAdmins() {
  if (!ADMINS.length) return;
  await q("UPDATE users SET is_admin=0 WHERE is_admin=1").run();
  for (const e of ADMINS) await q("UPDATE users SET is_admin=1 WHERE email=? AND email_verified=1").run(e);
}

/* Runs once at start-up (before the server listens). Tables first, then column upgrades, then the indexes/tables that depend on those columns. */
async function initDb() {
  if (DB_URL.startsWith("file:")) await db.executeMultiple("PRAGMA journal_mode=WAL;"); /* local file only; the remote database manages this itself */
  try { await db.execute("PRAGMA foreign_keys=ON"); } catch (e) { console.error("note: could not set foreign_keys:", e.message); } /* not fatal: dependent rows are also removed explicitly in code */
  await db.executeMultiple(SCHEMA);
  await migrate();
  await db.executeMultiple(SCHEMA2);
  await addCol("catalog_shops", "owner_uid", "INTEGER"); /* set when a shop owner runs this shop */
  await seedCatalog();
  await syncAdmins();
  await loadFees();
}

/* ---------- Helpers ---------- */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const emailOk = (e) => typeof e === "string" && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const norm = (p) => String(p).replace(/[\s\-()]/g, "");
const phoneOk = (p) => typeof p === "string" && p.length <= 20 && /^(\+?254|0)[17]\d{8}$/.test(norm(p));
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
function str(v, min, max, label) { /* trimmed string without control characters */
  if (typeof v !== "string") bad(label + " is required.");
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (t.length < min || t.length > max) bad(label + (min ? " must be " + min + "-" + max + " characters." : " is too long."));
  return t;
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return "s1$" + salt.toString("base64") + "$" + h.toString("base64");
}
const DUMMY = hashPw("dummy-password-for-timing"); /* equalises timing when the account does not exist */
async function checkPw(pw, stored) {
  const [, s, h] = String(stored).split("$"); if (!h) return false;
  const exp = Buffer.from(h, "base64");
  const got = await scrypt(pw, Buffer.from(s, "base64"), exp.length, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return crypto.timingSafeEqual(got, exp);
}
const pwOk = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200; /* stricter than the 6 in the prototype */

/* Persistent per-key lockout (5 failures -> 60 s) */
async function locked(k) { const f = await q("SELECT until FROM fails WHERE k=?").get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
async function fail(k) { /* one atomic statement: the 5th failure resets the counter and starts the 60 s lock */
  await q("INSERT INTO fails(k,n,until) VALUES(?,1,0) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN n+1>=5 THEN 0 ELSE n+1 END, until = CASE WHEN n+1>=5 THEN ? ELSE 0 END").run(k, Date.now() + 60000);
}
const clear = (k) => q("DELETE FROM fails WHERE k=?").run(k);
const guard = async (k) => { const l = await locked(k); if (l) bad("Too many attempts. Try again in " + l + "s.", 429); };

/* ---------- Sessions (opaque random token in an HttpOnly cookie; only its hash is stored) ---------- */
const COOKIE = "smd_sid";
function readCookie(req) { const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "=")); return m ? m.slice(COOKIE.length + 1) : ""; }
async function login(res, uid) {
  const t = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions(th,uid,exp) VALUES(?,?,?)").run(sha(t), uid, Date.now() + SESSION_MS);
  res.cookie(COOKIE, t, {httpOnly: true, sameSite: "strict", secure: PROD, path: "/", maxAge: SESSION_MS});
}
async function auth(req, res, next) {
  try {
    const t = readCookie(req); req.user = null;
    if (t) {
      const r = await q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=? AND s.exp>? AND u.email_verified=1").get(sha(t), Date.now());
      if (r) { if (r.is_admin) r.role = "admin"; else if (r.is_owner) r.role = "owner"; req.user = r; }
    }
    next();
  } catch (e) { next(e); }
}
const need = (role) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, "Please log in."));
  if (role && req.user.role !== role) return next(new HttpError(403, "Not allowed for your account type."));
  next();
};
const DOC_KINDS = ["front", "back", "selfie"];
const docsNeeded = (idType) => (idType === "Passport" ? ["front", "selfie"] : DOC_KINDS); /* a passport has no back side */
const docsOf = async (uid) => (await q("SELECT kind FROM id_docs WHERE uid=?").all(uid)).map((d) => d.kind);
async function pub(u) {
  const o = {email: u.email, name: u.name, phone: u.phone, role: u.is_admin ? "admin" : u.is_owner ? "owner" : u.role, veh: u.veh || "", area: u.area || ""};
  if (o.role === "shipper") /* a shipper's own verification state (status: draft -> pending -> approved | rejected) */
    Object.assign(o, {status: u.status, rejectReason: u.reject_reason || "", idType: u.id_type || "", idNumber: u.id_number || "", dob: u.dob || "", address: u.address || "", docs: await docsOf(u.id)});
  if (o.role === "shipper" && u.status === "approved") o.rating = await stats(u.id);
  return o;
}
/* A shipper's work rating: average stars, how many ratings, and how many deliveries finished */
async function stats(id) {
  const r = await q("SELECT (SELECT ROUND(AVG(stars),1) FROM ratings WHERE shipper=?) avg, (SELECT COUNT(*) FROM ratings WHERE shipper=?) cnt, (SELECT COUNT(*) FROM deliveries WHERE shipper=? AND step=2) done").get(id, id, id);
  return {avg: r.avg == null ? null : Number(r.avg), count: Number(r.cnt), done: Number(r.done)};
}
const approved = (req, res, next) => (req.user.status === "approved" ? next() : next(new HttpError(403, "Your shipper account is waiting for admin approval.")));

/* ---------- Delivery mapping (field names match the original UI) ---------- */
const pin = (s) => (s ? JSON.parse(s) : null);
function mapD(d, view) { /* view: s = sender (owner), j = open job board, m = shipper's own job */
  const o = {id: d.id, shop: d.shop, from: d.src, to: d.dst, land: d.land, drop: d.drop_, pp: pin(d.pp), dp: pin(d.dp), it: d.item, w: d.w, s: d.spd, price: d.price, goods: d.goods || 0, total: d.price + (d.goods || 0), items: d.items ? JSON.parse(d.items) : [], custom: d.custom || "", step: d.step, at: d.at, shipOk: !!d.ship_ok, ownOk: !!d.own_ok, pay: d.pay, payState: d.pay_state, deferMin: C.DEFER_MIN};
  if (view === "s" || view === "m") { o.receipt = d.receipt || ""; o.laterOk = d.pay_state === "awaiting" && laterOk(d); }
  if (view === "s") { o.rating = Number(d.rstars) || 0; Object.assign(o, {rn: d.rn, rp: d.rp, shipper: d.shipper ? true : "", shipperName: d.sname || "", shipperPhone: d.sphone || "", veh: d.veh || ""}); }
  if (view === "m") Object.assign(o, {rn: d.rn, rp: d.rp, sn: d.oname, sp: d.ophone, shipper: true});
  if (view === "j") Object.assign(o, {drop: "", dp: null}); /* exact drop-off is revealed only to the shipper who accepts */
  return o; /* the job board never exposes sender or recipient identity */
}
function pinIn(p) {
  if (p == null) return null;
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(lat > C.BOX.latMin && lat < C.BOX.latMax && lng > C.BOX.lngMin && lng < C.BOX.lngMax)) bad("Pin is outside our service area.");
  return JSON.stringify({lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6});
}

/* ---------- Google ID-token verification (RS256 against Google's published keys) ---------- */
let jwks = {keys: [], at: 0};
async function googleKeys() {
  if (jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", {signal: AbortSignal.timeout(5000)});
  jwks = {keys: (await r.json()).keys || [], at: Date.now()}; return jwks.keys;
}
async function verifyGoogle(tok) {
  try {
    const p = String(tok).split("."); if (p.length !== 3) return null;
    const h = JSON.parse(Buffer.from(p[0], "base64url")); if (h.alg !== "RS256") return null;
    const jwk = (await googleKeys()).find((k) => k.kid === h.kid); if (!jwk) return null;
    if (!crypto.verify("RSA-SHA256", Buffer.from(p[0] + "." + p[1]), crypto.createPublicKey({key: jwk, format: "jwk"}), Buffer.from(p[2], "base64url"))) return null;
    const c = JSON.parse(Buffer.from(p[1], "base64url"));
    if (c.aud !== GID || (c.iss !== "accounts.google.com" && c.iss !== "https://accounts.google.com") || c.exp < Date.now() / 1000 || c.email_verified !== true || !emailOk(c.email)) return null;
    return c;
  } catch (e) { return null; }
}
const signSetup = (o) => { const b = b64(o); return b + "." + crypto.createHmac("sha256", APP_SECRET).update(b).digest("base64url"); };
function readSetup(t) {
  const [b, s] = String(t).split("."); if (!b || !s) return null;
  const e = crypto.createHmac("sha256", APP_SECRET).update(b).digest();
  const g = Buffer.from(s, "base64url"); if (g.length !== e.length || !crypto.timingSafeEqual(g, e)) return null;
  const o = JSON.parse(Buffer.from(b, "base64url")); return o.exp > Date.now() ? o : null;
}

/* Email delivery. Preferred: SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM; works with Gmail app passwords, Brevo, Mailgun, SES...).
   Fallback: a webhook (MAIL_WEBHOOK_URL, or the older RESET_WEBHOOK_URL) that receives {email, to, subject, text, kind, code}.
   Codes are only ever printed to the console when NODE_ENV is not production. Delivery problems are logged, never shown to the user. */
let smtp = null;
async function sendMail({to, subject, text, kind, code}) {
  try {
    if (process.env.SMTP_HOST) {
      smtp = smtp || require("nodemailer").createTransport({host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: process.env.SMTP_SECURE === "1" || +process.env.SMTP_PORT === 465,
        auth: process.env.SMTP_USER ? {user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || ""} : undefined, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000});
      await smtp.sendMail({from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text});
    } else if (process.env.MAIL_WEBHOOK_URL || process.env.RESET_WEBHOOK_URL) {
      await fetch(process.env.MAIL_WEBHOOK_URL || process.env.RESET_WEBHOOK_URL, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({email: to, to, subject, text, kind, code}), signal: AbortSignal.timeout(5000)});
    } else if (!PROD) console.log("[dev] " + (kind === "verify" ? "verification code for " + to + ": " + code : kind === "reset" ? "password reset code for " + to + ": " + code : "email to " + to + ": " + subject));
    else console.error("No mail provider configured (set SMTP_HOST or MAIL_WEBHOOK_URL): cannot send '" + subject + "'.");
  } catch (e) { console.error("mail delivery failed:", e.message); }
}
const sendReset = (email, code) => sendMail({to: email, kind: "reset", code, subject: "Your SMD password reset code",
  text: "Your Send Me Deliveries password reset code is " + code + ".\nIt expires in 15 minutes. If you did not ask for this, ignore this email."});
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

/* Email verification: 6-digit code, hashed at rest, 10-minute expiry, 5 tries, one email per minute per account */
async function issueEmailCode(u) {
  const r = await q("SELECT created FROM email_codes WHERE uid=?").get(u.id);
  if (r && Date.now() - r.created < 60000) return false;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await q("INSERT INTO email_codes(uid,ch,exp,tries,created) VALUES(?,?,?,0,?) ON CONFLICT(uid) DO UPDATE SET ch=excluded.ch,exp=excluded.exp,tries=0,created=excluded.created").run(u.id, sha(code), Date.now() + 10 * 60000, Date.now());
  await sendMail({to: u.email, kind: "verify", code, subject: "Your SMD verification code",
    text: "Your Send Me Deliveries verification code is " + code + ".\nIt expires in 10 minutes. If you did not create an account, ignore this email."});
  return true;
}
const notifyAdmins = (subject, text) => ADMINS.forEach((to) => sendMail({to, kind: "admin", subject, text}));

/* ---------- Push notifications for shippers (Web Push) ----------
   Needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (make them with: npm run vapid). Without them the app still works; shippers just get no phone alerts.
   A shipper is alerted about a NEW job when: approved, has a live login session, has allowed notifications on a device, and is based within NOTIFY_KM of the pickup area.
   The alert carries only the route and fee: never the sender's or the recipient's details. PUSH_DRY_RUN=1 logs instead of sending (tests). */
let webpush = null;
const DRY_PUSH = process.env.PUSH_DRY_RUN === "1";
if ((process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) || DRY_PUSH) {
  try {
    webpush = require("web-push");
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) webpush.setVapidDetails("mailto:" + (process.env.SUPPORT_EMAIL || ADMINS[0] || "admin@example.com"), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  } catch (e) { console.error("Push notifications are off:", e.message); webpush = null; }
}
const NOTIFY_KM = +process.env.NOTIFY_KM || 10;
async function announceJob(id) { /* call after a job becomes visible on the board; safe to call twice */
  try {
    const r = await q("UPDATE deliveries SET notified=1 WHERE id=? AND notified=0 AND step=0 AND shipper IS NULL AND pay_state<>'awaiting'").run(id);
    if (!r.changes || !webpush) return;
    const d = await q("SELECT src,dst,price,goods FROM deliveries WHERE id=?").get(id); if (!d) return;
    const subs = await q("SELECT s.*, u.area FROM push_subs s JOIN users u ON u.id=s.uid WHERE u.role='shipper' AND u.status='approved' AND u.email_verified=1 AND EXISTS (SELECT 1 FROM sessions x WHERE x.uid=u.id AND x.exp>?)").all(Date.now());
    const near = subs.filter((x) => x.area && Object.hasOwn(C.AREAS, x.area) && Math.abs(C.AREAS[x.area].pos - C.AREAS[d.src].pos) <= NOTIFY_KM);
    const payload = JSON.stringify({title: "New delivery job", body: d.src + " → " + d.dst + " · fee " + d.price + " KES", tag: "smd-job", url: "/"});
    for (const sub of near) {
      if (DRY_PUSH) { console.log("[push] to user " + sub.uid + ": " + d.src + " -> " + d.dst); continue; }
      try { await webpush.sendNotification({endpoint: sub.endpoint, keys: {p256dh: sub.p256dh, auth: sub.auth}}, payload, {TTL: 3600, urgency: "high"}); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await q("DELETE FROM push_subs WHERE endpoint=?").run(sub.endpoint); else console.error("push failed:", e.statusCode || e.message); }
    }
  } catch (e) { console.error("announceJob:", e.message); }
}

/* ---------- App ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", +process.env.TRUST_PROXY || process.env.TRUST_PROXY);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {useDefaults: false, directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style"],
    fontSrc: ["https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
    frameSrc: ["https://accounts.google.com/gsi/"],
    objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"],
    ...(PROD ? {upgradeInsecureRequests: []} : {})
  }},
  crossOriginOpenerPolicy: {policy: "same-origin-allow-popups"}, /* required by Google sign-in popup */
  hsts: PROD ? {maxAge: 15552000, includeSubDomains: true} : false
}));
/* Legal pages (needed by app stores): the contact line comes from SUPPORT_EMAIL so it can be changed without editing code. */
const legalPage = (file) => (req, res, next) => {
  try {
    const t = fs.readFileSync(path.join(__dirname, "legal", file), "utf8");
    const mail = String(process.env.SUPPORT_EMAIL || "").trim(), esc = (x) => x.replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
    const contact = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail) ? '<a href="mailto:' + esc(mail) + '">' + esc(mail) + "</a>" : "the contact email on our Google Play listing";
    res.type("html").send(t.replace(/{{CONTACT}}/g, contact).replace(/{{DATE}}/g, "October 2026"));
  } catch (e) { next(e); }
};
app.get(["/privacy", "/privacy-policy"], legalPage("privacy.html"));
app.get(["/delete-account", "/delete"], legalPage("delete-account.html"));
app.use(express.static(path.join(__dirname, "public"), {index: "index.html", maxAge: PROD ? "1h" : 0, setHeaders: (res, p) => {
  if (/[\\/](sw\.js|manifest\.webmanifest)$/.test(p)) res.setHeader("Cache-Control", "no-cache"); /* the browser must always see a new service worker / manifest */
}}));

const api = express.Router();
api.use(express.json({limit: "20kb"}));
api.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
api.use(rateLimit({windowMs: 60000, limit: +process.env.API_RATE_LIMIT || 300, standardHeaders: true, legacyHeaders: false, message: {error: "Too many requests."}}));
api.use((req, res, next) => { /* CSRF defence in depth (cookie is already SameSite=Strict) */
  if (req.method === "GET" || req.method === "HEAD") return next();
  const o = req.headers.origin;
  if (o) { let h = ""; try { h = new URL(o).host; } catch (e) {} if (h !== req.headers.host) return next(new HttpError(403, "Cross-site request blocked.")); }
  else if (req.headers["sec-fetch-site"] === "cross-site") return next(new HttpError(403, "Cross-site request blocked."));
  const photo = req.method === "PUT" && /^\/me\/id-docs\/[a-z]+$/.test(req.path) && req.is(["image/jpeg", "image/png"]); /* the only non-JSON write: ID photo upload */
  if (!photo && !req.is("json")) return next(new HttpError(415, "JSON required."));
  next();
});
api.use(auth);
const authLimit = rateLimit({windowMs: 60000, limit: +process.env.AUTH_RATE_LIMIT || 20, standardHeaders: true, legacyHeaders: false, message: {error: "Too many attempts. Please wait a minute."}});
const wrap = (f) => (req, res, next) => Promise.resolve(f(req, res)).catch(next);

api.get("/config", (req, res) => res.json({AREAS: C.AREAS, P: C.P, WT: C.WT, VEHICLES: C.VEHICLES, BOX: C.BOX, ID_TYPES: C.ID_TYPES, googleClientId: GID, mpesa: M.enabled(), FEES, DEFER_MIN: C.DEFER_MIN, push: !!webpush && !!process.env.VAPID_PUBLIC_KEY, vapid: process.env.VAPID_PUBLIC_KEY || ""}));

/* Shipper identification details (validated on the server; the ID number is normalised so one ID cannot back two accounts) */
function idIn(b) {
  if (!C.ID_TYPES.includes(b.idType)) bad("Choose your ID type.");
  const num = typeof b.idNumber === "string" ? b.idNumber.replace(/[\s]/g, "").toUpperCase() : "";
  if (!/^[A-Z0-9\/-]{5,20}$/.test(num)) bad("Enter your ID number (5-20 letters or digits).");
  if (typeof b.dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) bad("Enter your date of birth.");
  const d = new Date(b.dob + "T00:00:00Z"); if (isNaN(d) || d.toISOString().slice(0, 10) !== b.dob) bad("Enter a valid date of birth.");
  const now = new Date(); let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  if (age < 18) bad("Shippers must be at least 18 years old."); if (age > 90) bad("Enter a valid date of birth.");
  return {idType: b.idType, idNumber: num, dob: b.dob, address: str(b.address, 5, 120, "Residential address")};
}
const idTaken = (e) => /id_number/.test(String(e && e.message));

/* Removes an account that never proved its email. Dependents are deleted explicitly so this is correct even if the database does not enforce cascades. */
async function dropOwnerShop(uid) {
  await q("DELETE FROM catalog_items WHERE shop_id IN (SELECT id FROM catalog_shops WHERE owner_uid=?)").run(uid);
  await q("DELETE FROM catalog_shops WHERE owner_uid=?").run(uid);
}
async function dropUnverified(id) {
  for (const t of ["sessions", "resets", "email_codes", "shops", "id_docs", "push_subs"]) await q("DELETE FROM " + t + " WHERE uid=?").run(id);
  await dropOwnerShop(id);
  await q("DELETE FROM deliveries WHERE owner=?").run(id);
  await q("DELETE FROM users WHERE id=?").run(id);
}
async function newUser(b, email, pw, google) {
  const owner = b.role === "owner"; /* a shop owner is stored as a 'sender' row with is_owner=1 (the role column only allows sender/shipper) */
  const role = b.role === "shipper" ? "shipper" : (b.role === "sender" || owner) ? "sender" : bad("Choose an account type.");
  const name = str(b.name, 2, 60, "Full name"); if (!phoneOk(b.phone)) bad("Enter a valid phone, e.g. 0712 345 678.");
  let veh = null, area = null, id = {}, status = "approved", shopName = null;
  if (owner) {
    shopName = str(b.shopName, 2, 60, "Shop name"); if (!Object.hasOwn(C.AREAS, b.area)) bad("Choose the area your shop is in."); area = b.area;
    if (await q("SELECT 1 x FROM catalog_shops WHERE area=? AND name=? COLLATE NOCASE").get(area, shopName)) bad("A shop with that name already exists in this area.", 409);
  }
  if (role === "shipper") { /* shippers start as "draft" and must be approved by an admin before they can see any job */
    if (!C.VEHICLES.includes(b.veh) || !Object.hasOwn(C.AREAS, b.area)) bad("Choose a vehicle and base area.");
    veh = b.veh; area = b.area; id = idIn(b); status = "draft";
  }
  /* An earlier sign-up for this email that never proved ownership must not block (or hijack) the real owner: replace it. */
  const ex = await q("SELECT id,email_verified,created FROM users WHERE email=?").get(email);
  if (ex && !ex.email_verified) {
    if (Date.now() - ex.created < 60000) bad("Please wait a minute before trying again.", 429);
    await dropUnverified(ex.id);
  }
  try {
    const uid = Number((await q("INSERT INTO users(email,name,phone,role,veh,area,pw,google,created,email_verified,status,id_type,id_number,dob,address,is_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(email, name, b.phone.trim(), role, veh, area, pw, google ? 1 : 0, Date.now(), google ? 1 : 0, status, id.idType || null, id.idNumber || null, id.dob || null, id.address || null, owner ? 1 : 0)).lastInsertRowid);
    if (owner) { /* the shop stays hidden from customers until an admin approves it (Shops tab) */
      try { await q("INSERT INTO catalog_shops(area,name,recommended,active,created,owner_uid) VALUES(?,?,0,0,?,?)").run(area, shopName, Date.now(), uid); }
      catch (e) { await q("DELETE FROM users WHERE id=?").run(uid); bad("A shop with that name already exists in this area.", 409); }
    }
    return uid;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (idTaken(e)) bad("That ID number is already registered to another account. Contact support if this is a mistake.", 409);
    bad("An account with this email already exists. Log in instead.", 409);
  }
}

api.post("/auth/signup", authLimit, wrap(async (req, res) => {
  const b = req.body, email = String(b.email || "").trim().toLowerCase();
  if (!emailOk(email)) bad("Enter a valid email address."); if (!pwOk(b.password)) bad("Password must be at least 8 characters.");
  const uid = await newUser(b, email, await hashPw(b.password), false);
  await issueEmailCode(await q("SELECT * FROM users WHERE id=?").get(uid));
  res.status(201).json({needsVerify: true, email}); /* no session until the emailed code is confirmed */
}));

api.post("/auth/verify", authLimit, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), code = String(req.body.code || "").trim();
  if (!emailOk(email) || !/^\d{6}$/.test(code)) bad("Invalid or expired code.");
  await guard("verify:" + email);
  const u = await q("SELECT * FROM users WHERE email=?").get(email), r = u && !u.email_verified && await q("SELECT * FROM email_codes WHERE uid=?").get(u.id);
  const good = r && r.exp > Date.now() && r.tries < 5 && crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(r.ch));
  if (!good) { await fail("verify:" + email); if (r) await q("UPDATE email_codes SET tries=tries+1 WHERE uid=?").run(u.id); bad("Invalid or expired code. Request a new one if needed."); }
  await q("UPDATE users SET email_verified=1 WHERE id=?").run(u.id); await q("DELETE FROM email_codes WHERE uid=?").run(u.id); await clear("verify:" + email);
  await syncAdmins(); await login(res, u.id);
  res.json({user: await pub(await q("SELECT * FROM users WHERE id=?").get(u.id))});
}));

api.post("/auth/resend", authLimit, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const u = emailOk(email) && await q("SELECT * FROM users WHERE email=? AND email_verified=0").get(email);
  if (u) await issueEmailCode(u); /* one per minute; identical reply whether or not the account exists */
  res.json({ok: true});
}));

api.post("/auth/login", authLimit, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), pw = req.body.password;
  if (!emailOk(email) || typeof pw !== "string" || !pw || pw.length > 200) bad("Wrong email or password.", 401);
  await guard("login:" + email);
  const u = await q("SELECT * FROM users WHERE email=?").get(email);
  const ok = await checkPw(pw, u && u.pw ? u.pw : await DUMMY);
  if (!u || !u.pw || !ok) { await fail("login:" + email); bad("Wrong email or password. If you signed up with Google, use Continue with Google.", 401); }
  await clear("login:" + email);
  if (!u.email_verified) { /* right password but email never confirmed: send a fresh code and ask for it */
    await issueEmailCode(u);
    return res.status(403).json({error: "Please verify your email first. We sent a code to " + email + ".", needsVerify: true, email});
  }
  await login(res, u.id); res.json({user: await pub(u)});
}));

api.post("/auth/logout", wrap(async (req, res) => {
  const t = readCookie(req); if (t) await q("DELETE FROM sessions WHERE th=?").run(sha(t));
  res.clearCookie(COOKIE, {path: "/"}); res.json({ok: true});
}));

api.post("/auth/forgot", authLimit, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (emailOk(email)) {
    const u = await q("SELECT id,pw,email_verified FROM users WHERE email=?").get(email);
    const r = u && await q("SELECT created FROM resets WHERE uid=?").get(u.id);
    if (u && u.pw && u.email_verified && !(r && Date.now() - r.created < 60000)) { /* one code per minute; unverified accounts verify instead */
      const code = newCode();
      await q("INSERT INTO resets(uid,ch,exp,tries,created) VALUES(?,?,?,0,?) ON CONFLICT(uid) DO UPDATE SET ch=excluded.ch,exp=excluded.exp,tries=0,created=excluded.created").run(u.id, sha(code), Date.now() + 15 * 60000, Date.now());
      await sendReset(email, code);
    }
  }
  res.json({ok: true}); /* identical response whether or not the account exists */
}));

api.post("/auth/reset", authLimit, wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), code = String(req.body.code || "").trim().toUpperCase(), pw = req.body.password;
  if (!emailOk(email) || code.length < 6 || code.length > 12) bad("Invalid or expired code.");
  if (!pwOk(pw)) bad("Password must be at least 8 characters.");
  await guard("reset:" + email);
  const u = await q("SELECT id FROM users WHERE email=?").get(email), r = u && await q("SELECT * FROM resets WHERE uid=?").get(u.id);
  const good = r && r.exp > Date.now() && r.tries < 5 && crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(r.ch));
  if (!good) { await fail("reset:" + email); if (r) await q("UPDATE resets SET tries=tries+1 WHERE uid=?").run(u.id); bad("Invalid or expired code."); }
  await q("UPDATE users SET pw=? WHERE id=?").run(await hashPw(pw), u.id);
  await q("DELETE FROM resets WHERE uid=?").run(u.id); await q("DELETE FROM sessions WHERE uid=?").run(u.id); await clear("reset:" + email); await clear("login:" + email); /* owner proved email access: lift any lockout */
  res.json({ok: true});
}));

api.post("/auth/google", authLimit, wrap(async (req, res) => {
  if (!GID) bad("Google sign-in is not configured.", 501);
  const c = await verifyGoogle(req.body.credential); if (!c) bad("Google sign-in could not be verified. Please try again.", 401);
  const email = c.email.toLowerCase(); let u = await q("SELECT * FROM users WHERE email=?").get(email);
  if (u && !u.email_verified) { await dropUnverified(u.id); u = null; } /* an unproven password sign-up must not capture the real owner's Google login */
  if (u) { if (!u.google) await q("UPDATE users SET google=1 WHERE id=?").run(u.id); await syncAdmins(); await login(res, u.id); return res.json({user: await pub(u)}); }
  res.json({needsSetup: true, email, name: String(c.name || "").slice(0, 60), setup: signSetup({email, exp: Date.now() + 10 * 60000})});
}));

api.post("/auth/google/complete", authLimit, wrap(async (req, res) => {
  const s = readSetup(req.body.setup); if (!s) bad("Please start again with Google.", 401);
  const uid = await newUser(req.body, s.email, null, true); await syncAdmins(); await login(res, uid); /* Google already verified this email */
  res.status(201).json({user: await pub(await q("SELECT * FROM users WHERE id=?").get(uid))});
}));

/* Delete my account (required by app stores). Refused while money or a delivery is in flight; otherwise everything personal is removed. */
api.post("/me/delete", need(), wrap(async (req, res) => {
  const u = req.user, b = req.body || {};
  if (u.role === "admin") bad("Administrator accounts cannot be deleted from the app.", 403);
  if (b.confirm !== "DELETE") bad("Type DELETE to confirm.");
  if (u.pw) { await guard("del:" + u.id); if (typeof b.password !== "string" || !(await checkPw(b.password, u.pw))) { await fail("del:" + u.id); bad("Wrong password.", 403); } await clear("del:" + u.id); }
  const busy = (await q("SELECT COUNT(*) c FROM deliveries WHERE (owner=? AND (step=1 OR (step=0 AND pay_state='paid'))) OR (shipper=? AND step=1)").get(u.id, u.id)).c
    || (await q("SELECT COUNT(*) c FROM payments WHERE uid=? AND status IN ('initiating','pending')").get(u.id)).c;
  if (busy) bad("You still have a delivery in progress or a paid request that is not complete. Finish or cancel it first, then delete your account.", 409);
  for (const t of ["sessions", "resets", "email_codes", "shops", "id_docs", "push_subs"]) await q("DELETE FROM " + t + " WHERE uid=?").run(u.id);
  await dropOwnerShop(u.id); await q("DELETE FROM ratings WHERE shipper=?").run(u.id);
  await q("DELETE FROM deliveries WHERE owner=?").run(u.id);
  await q("UPDATE deliveries SET shipper=NULL, sname='Deleted user', sphone='', veh=NULL WHERE shipper=?").run(u.id); /* completed jobs stay on the sender's record without the shipper's identity */
  await q("DELETE FROM users WHERE id=?").run(u.id);
  res.clearCookie(COOKIE, {path: "/"}); res.json({ok: true});
}));
api.get("/me", need(), wrap(async (req, res) => res.json({user: await pub(req.user), shops: await q("SELECT area AS a, name AS n FROM shops WHERE uid=?").all(req.user.id)})));
api.patch("/me", need(), wrap(async (req, res) => {
  const name = str(req.body.name, 2, 60, "Full name"); if (!phoneOk(req.body.phone)) bad("Enter a valid phone number.");
  if (req.user.role === "shipper" && (req.user.status === "pending" || req.user.status === "approved") && name !== req.user.name) bad("Your name is locked after ID submission because it must match your ID.", 403);
  await q("UPDATE users SET name=?, phone=? WHERE id=?").run(name, req.body.phone.trim(), req.user.id);
  res.json({user: await pub(await q("SELECT * FROM users WHERE id=?").get(req.user.id))});
}));

/* Shipper identity verification: photos are stored privately (never in a public folder) and only the owner and admins can fetch them */
const rawPhoto = express.raw({type: ["image/jpeg", "image/png"], limit: "4mb"});
const photoLimit = rateLimit({windowMs: 60000, limit: +process.env.UPLOAD_RATE_LIMIT || 30, standardHeaders: true, legacyHeaders: false, message: {error: "Too many uploads. Please wait a minute."}});
const editable = (u) => (u.status === "draft" || u.status === "rejected" ? true : bad("Your ID is already submitted and cannot be changed now.", 409));
api.put("/me/id-docs/:kind", need("shipper"), photoLimit, rawPhoto, wrap(async (req, res) => {
  editable(req.user);
  const kind = req.params.kind; if (!DOC_KINDS.includes(kind)) bad("Unknown document.", 404);
  const b = req.body, png = Buffer.isBuffer(b) && b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), jpg = Buffer.isBuffer(b) && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (!png && !jpg) bad("Please upload a JPEG or PNG photo.", 415); /* checked by file signature, not by what the client claims */
  if (b.length < 5000) bad("That photo is too small to read. Take a clearer one.");
  await q("INSERT INTO id_docs(uid,kind,mime,data,created) VALUES(?,?,?,?,?) ON CONFLICT(uid,kind) DO UPDATE SET mime=excluded.mime,data=excluded.data,created=excluded.created").run(req.user.id, kind, png ? "image/png" : "image/jpeg", b, Date.now());
  res.json({docs: await docsOf(req.user.id)});
}));
async function sendDoc(res, uid, kind) {
  const d = DOC_KINDS.includes(kind) && await q("SELECT mime,data FROM id_docs WHERE uid=? AND kind=?").get(uid, kind); if (!d) bad("Not found.", 404);
  res.set({"Content-Type": d.mime, "Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"}); res.send(Buffer.from(d.data));
}
api.get("/me/id-docs/:kind", need("shipper"), wrap((req, res) => sendDoc(res, req.user.id, req.params.kind)));
api.post("/me/verification", need("shipper"), wrap(async (req, res) => { /* save the ID details and send everything to the admin for review */
  const u = req.user; editable(u);
  const id = idIn(req.body), have = await docsOf(u.id), miss = docsNeeded(id.idType).filter((k) => !have.includes(k));
  if (miss.length) bad("Please upload: " + miss.map((k) => ({front: "ID front", back: "ID back", selfie: "selfie with ID"})[k]).join(", ") + ".");
  try { await q("UPDATE users SET id_type=?, id_number=?, dob=?, address=?, status='pending', reject_reason=NULL WHERE id=?").run(id.idType, id.idNumber, id.dob, id.address, u.id); }
  catch (e) { if (idTaken(e)) bad("That ID number is already registered to another account. Contact support if this is a mistake.", 409); throw e; }
  notifyAdmins("New shipper awaiting approval", u.name + " (" + u.email + ") submitted ID documents. Open SMD > Review to approve or reject.");
  res.json({user: await pub(await q("SELECT * FROM users WHERE id=?").get(u.id))});
}));

/* Admin: review queue */
const adminOnly = need("admin");
const SHIP_STATUS = ["pending", "approved", "rejected"];
api.get("/admin/shippers", adminOnly, wrap(async (req, res) => {
  const s = String(req.query.status || "pending"); if (!SHIP_STATUS.includes(s)) bad("Invalid status.");
  const rows = await q("SELECT id,name,email,phone,veh,area,id_type,id_number,dob,address,status,reject_reason,created,reviewed_at FROM users WHERE role='shipper' AND is_admin=0 AND status=? ORDER BY created ASC LIMIT 200").all(s);
  const counts = {}; for (const k of SHIP_STATUS) counts[k] = (await q("SELECT COUNT(*) c FROM users WHERE role='shipper' AND is_admin=0 AND status=?").get(k)).c;
  const shippers = []; for (const r of rows) shippers.push({id: r.id, name: r.name, email: r.email, phone: r.phone, veh: r.veh, area: r.area, idType: r.id_type, idNumber: r.id_number, dob: r.dob, address: r.address, status: r.status, reason: r.reject_reason || "", at: r.created, reviewed: r.reviewed_at, docs: await docsOf(r.id)});
  res.json({counts, shippers});
}));
api.get("/admin/shippers/:id/docs/:kind", adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id), u = Number.isInteger(id) && await q("SELECT id FROM users WHERE id=? AND role='shipper' AND is_admin=0").get(id); if (!u) bad("Not found.", 404);
  await sendDoc(res, id, req.params.kind);
}));
async function decide(req, res, ok) {
  const id = Number(req.params.id), reason = ok ? null : str(req.body.reason, 3, 200, "Reason");
  const u = Number.isInteger(id) && await q("SELECT * FROM users WHERE id=? AND role='shipper' AND is_admin=0").get(id); if (!u) bad("Not found.", 404);
  const from = ok ? "('pending','rejected')" : "('pending','approved')"; /* admins may also reverse an earlier decision */
  const r = await q("UPDATE users SET status=?, reject_reason=?, reviewed_at=? WHERE id=? AND status IN " + from).run(ok ? "approved" : "rejected", reason, Date.now(), id);
  if (!r.changes) bad("This shipper is not in a state that can be " + (ok ? "approved" : "rejected") + ".", 409);
  sendMail({to: u.email, kind: "decision", subject: ok ? "Your SMD shipper account is approved" : "Your SMD shipper verification needs changes",
    text: ok ? "Good news, " + u.name + ": your ID was verified and you can now accept delivery jobs. Open the app and log in."
      : "Hi " + u.name + ", we could not verify your ID.\nReason: " + reason + "\nOpen the app, fix the details or photos, and submit again."});
  res.json({ok: true});
}
api.post("/admin/shippers/:id/approve", adminOnly, wrap((req, res) => decide(req, res, true)));
api.post("/admin/shippers/:id/reject", adminOnly, wrap((req, res) => decide(req, res, false)));

/* Shop catalog: recommended shops first, each with its per-unit price list */
async function catalog(all) {
  const shops = await q("SELECT * FROM catalog_shops" + (all ? "" : " WHERE active=1") + " ORDER BY (owner_uid IS NOT NULL AND active=0) DESC, recommended DESC, name COLLATE NOCASE").all();
  const items = await q("SELECT * FROM catalog_items" + (all ? "" : " WHERE active=1") + " ORDER BY name COLLATE NOCASE, unit").all();
  return shops.map((s) => ({id: s.id, area: s.area, name: s.name, rec: !!s.recommended, active: !!s.active, owned: s.owner_uid != null,
    items: items.filter((i) => i.shop_id === s.id).map((i) => ({id: i.id, name: i.name, unit: i.unit, price: i.price, active: !!i.active}))}));
}
api.get("/shops", need("sender"), wrap(async (req, res) => res.json(await catalog(false))));
const idp = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : bad("Not found.", 404); };
const priceIn = (v) => (Number.isInteger(v) && v >= 1 && v <= 1000000 ? v : bad("Price must be a whole number of shillings (1 to 1,000,000)."));
const dupShop = (e) => { if (/UNIQUE/.test(String(e && e.message))) bad("A shop with that name already exists in this area.", 409); throw e; };
api.get("/admin/shops", need("admin"), wrap(async (req, res) => res.json({shops: await catalog(true)})));
api.post("/admin/shops", need("admin"), wrap(async (req, res) => {
  const b = req.body, name = str(b.name, 2, 60, "Shop name"); if (!Object.hasOwn(C.AREAS, b.area)) bad("Choose an area.");
  try { res.status(201).json({id: Number((await q("INSERT INTO catalog_shops(area,name,recommended,active,created) VALUES(?,?,?,1,?)").run(b.area, name, b.rec === false ? 0 : 1, Date.now())).lastInsertRowid)}); } catch (e) { dupShop(e); }
}));
api.patch("/admin/shops/:id", need("admin"), wrap(async (req, res) => {
  const id = idp(req.params.id), s = await q("SELECT * FROM catalog_shops WHERE id=?").get(id); if (!s) bad("Not found.", 404); const b = req.body;
  const name = b.name !== undefined ? str(b.name, 2, 60, "Shop name") : s.name, area = b.area !== undefined ? (Object.hasOwn(C.AREAS, b.area) ? b.area : bad("Choose an area.")) : s.area;
  const flag = (v, cur) => (v === undefined ? cur : v ? 1 : 0);
  try { await q("UPDATE catalog_shops SET name=?, area=?, recommended=?, active=? WHERE id=?").run(name, area, flag(b.rec, s.recommended), flag(b.active, s.active), id); } catch (e) { dupShop(e); }
  res.json({ok: true});
}));
api.delete("/admin/shops/:id", need("admin"), wrap(async (req, res) => { /* past orders keep their own copy of the shop name and prices */
  const id = idp(req.params.id); await q("DELETE FROM catalog_items WHERE shop_id=?").run(id); /* explicit, so it never depends on cascade support */
  if (!(await q("DELETE FROM catalog_shops WHERE id=?").run(id)).changes) bad("Not found.", 404); res.json({ok: true});
}));
/* Goods of a shop: the same rules for the admin (any shop) and for a shop owner (their own shop only) */
async function addItem(sid, b) {
  const name = str(b.name, 2, 60, "Item name"), unit = str(b.unit, 1, 20, "Unit"), price = priceIn(b.price);
  if ((await q("SELECT COUNT(*) c FROM catalog_items WHERE shop_id=?").get(sid)).c >= 300) bad("That shop already has the maximum number of goods.", 429);
  try { return Number((await q("INSERT INTO catalog_items(shop_id,name,unit,price,active) VALUES(?,?,?,?,1)").run(sid, name, unit, price)).lastInsertRowid); }
  catch (e) { if (/UNIQUE/.test(String(e.message))) bad("That item (with the same unit) is already on this shop's list.", 409); throw e; }
}
async function editItem(id, b, ownerUid) {
  const it = await q("SELECT i.* FROM catalog_items i JOIN catalog_shops s ON s.id=i.shop_id WHERE i.id=?" + (ownerUid ? " AND s.owner_uid=?" : "")).get(...(ownerUid ? [id, ownerUid] : [id])); if (!it) bad("Not found.", 404);
  const name = b.name !== undefined ? str(b.name, 2, 60, "Item name") : it.name, unit = b.unit !== undefined ? str(b.unit, 1, 20, "Unit") : it.unit, price = b.price !== undefined ? priceIn(b.price) : it.price;
  try { await q("UPDATE catalog_items SET name=?, unit=?, price=?, active=? WHERE id=?").run(name, unit, price, b.active === undefined ? it.active : b.active ? 1 : 0, id); }
  catch (e) { if (/UNIQUE/.test(String(e.message))) bad("That item (with the same unit) is already on this shop's list.", 409); throw e; }
}
async function removeItem(id, ownerUid) {
  const ok = await q("SELECT i.id FROM catalog_items i JOIN catalog_shops s ON s.id=i.shop_id WHERE i.id=?" + (ownerUid ? " AND s.owner_uid=?" : "")).get(...(ownerUid ? [id, ownerUid] : [id]));
  if (!ok) bad("Not found.", 404); await q("DELETE FROM catalog_items WHERE id=?").run(id);
}
api.post("/admin/shops/:id/items", need("admin"), wrap(async (req, res) => {
  const sid = idp(req.params.id); if (!(await q("SELECT id FROM catalog_shops WHERE id=?").get(sid))) bad("Not found.", 404);
  res.status(201).json({id: await addItem(sid, req.body)});
}));
api.patch("/admin/items/:id", need("admin"), wrap(async (req, res) => { await editItem(idp(req.params.id), req.body); res.json({ok: true}); }));
api.delete("/admin/items/:id", need("admin"), wrap(async (req, res) => { await removeItem(idp(req.params.id)); res.json({ok: true}); }));

/* Shop owner dashboard: one shop per owner, goods only (the admin approves the shop and decides if it is recommended) */
const myShop = async (req) => (await q("SELECT * FROM catalog_shops WHERE owner_uid=?").get(req.user.id)) || bad("No shop is linked to your account.", 404);
async function ownerView(sh) {
  const items = await q("SELECT * FROM catalog_items WHERE shop_id=? ORDER BY name COLLATE NOCASE, unit").all(sh.id);
  return {shop: {id: sh.id, name: sh.name, area: sh.area, approved: !!sh.active, rec: !!sh.recommended, items: items.map((i) => ({id: i.id, name: i.name, unit: i.unit, price: i.price, active: !!i.active}))}};
}
api.get("/owner/shop", need("owner"), wrap(async (req, res) => res.json(await ownerView(await myShop(req)))));
api.patch("/owner/shop", need("owner"), wrap(async (req, res) => {
  const sh = await myShop(req), name = str(req.body.name, 2, 60, "Shop name");
  try { await q("UPDATE catalog_shops SET name=? WHERE id=?").run(name, sh.id); } catch (e) { dupShop(e); }
  res.json(await ownerView(await myShop(req)));
}));
api.post("/owner/items", need("owner"), wrap(async (req, res) => { const sh = await myShop(req); await addItem(sh.id, req.body); res.status(201).json(await ownerView(sh)); }));
api.patch("/owner/items/:id", need("owner"), wrap(async (req, res) => { await editItem(idp(req.params.id), req.body, req.user.id); res.json(await ownerView(await myShop(req))); }));
api.delete("/owner/items/:id", need("owner"), wrap(async (req, res) => { await removeItem(idp(req.params.id), req.user.id); res.json(await ownerView(await myShop(req))); }));

api.post("/push/subscribe", need("shipper"), approved, wrap(async (req, res) => {
  const b = req.body, k = b && b.keys;
  if (!webpush) bad("Notifications are not switched on for this server.", 501);
  if (typeof b.endpoint !== "string" || !/^https:\/\/[^\s]{10,480}$/.test(b.endpoint) || !k || typeof k.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 200 || k.auth.length > 100) bad("That notification setup is not valid.");
  await q("INSERT INTO push_subs(endpoint,uid,p256dh,auth,created) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid,p256dh=excluded.p256dh,auth=excluded.auth").run(b.endpoint, req.user.id, k.p256dh, k.auth, Date.now());
  await q("DELETE FROM push_subs WHERE uid=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE uid=? ORDER BY created DESC LIMIT 5)").run(req.user.id, req.user.id); /* at most 5 devices */
  res.status(201).json({ok: true});
}));
api.post("/push/unsubscribe", need(), wrap(async (req, res) => {
  if (typeof req.body.endpoint === "string") await q("DELETE FROM push_subs WHERE endpoint=? AND uid=?").run(req.body.endpoint, req.user.id);
  res.json({ok: true});
}));

/* Near you (senders): shops the admin recommends in an area, and the approved shippers based there with their work rating */
const shortName = (n) => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0]; };
api.get("/nearby", need("sender"), wrap(async (req, res) => {
  const a = String(req.query.area || ""); if (!Object.hasOwn(C.AREAS, a)) bad("Choose an area.");
  const shops = await q("SELECT s.id, s.name, (SELECT COUNT(*) FROM catalog_items i WHERE i.shop_id=s.id AND i.active=1) goods FROM catalog_shops s WHERE s.area=? AND s.active=1 AND s.recommended=1 ORDER BY s.name COLLATE NOCASE LIMIT 12").all(a);
  const rows = await q("SELECT id, name, veh FROM users WHERE role='shipper' AND status='approved' AND area=? AND email_verified=1").all(a), out = [];
  for (const r of rows) {
    if ((await q("SELECT COUNT(*) c FROM deliveries WHERE shipper=? AND step=1").get(r.id)).c >= 10) continue; /* fully booked: not available */
    out.push({name: shortName(r.name), veh: r.veh || "", ...(await stats(r.id))});
  }
  out.sort((x, y) => (y.avg || 0) - (x.avg || 0) || y.done - x.done);
  res.json({area: a, shops: shops.map((s) => ({id: s.id, name: s.name, goods: Number(s.goods)})), shippers: out.slice(0, 10)});
}));
api.post("/deliveries/:id/rate", need("sender"), wrap(async (req, res) => {
  const stars = req.body.stars; if (!Number.isInteger(stars) || stars < 1 || stars > 5) bad("Choose 1 to 5 stars.");
  const d = await q("SELECT shipper FROM deliveries WHERE id=? AND owner=? AND step=2").get(String(req.params.id), req.user.id);
  if (!d || !d.shipper) bad("You can rate a delivery once it is completed.", 409);
  try { await q("INSERT INTO ratings(delivery_id,shipper,owner,stars,created) VALUES(?,?,?,?,?)").run(String(req.params.id), d.shipper, req.user.id, stars, Date.now()); }
  catch (e) { if (/UNIQUE|PRIMARY/i.test(String(e.message))) bad("You already rated this delivery.", 409); throw e; }
  res.json({ok: true, rating: stars});
}));

/* Sender */
api.get("/deliveries", need("sender"), wrap(async (req, res) => res.json((await q("SELECT d.*, r.stars rstars FROM deliveries d LEFT JOIN ratings r ON r.delivery_id=d.id WHERE d.owner=? ORDER BY d.at DESC").all(req.user.id)).map((d) => mapD(d, "s")))));
api.post("/deliveries", need("sender"), wrap(async (req, res) => {
  const b = req.body;
  if (!Object.hasOwn(C.AREAS, b.from) || !Object.hasOwn(C.AREAS, b.to)) bad("Choose valid areas.");
  const land = b.land ? str(b.land, 0, 100, "Landmark") : "", drop = str(b.drop, 2, 100, "Drop-off location"), rn = str(b.rn, 2, 60, "Recipient name");
  /* A recommended shop from the catalog (shopId) can come with priced goods; any other shop is just a typed name. */
  let shop, shopId = null; const lines = [];
  if (b.shopId != null) {
    const sh = Number.isInteger(b.shopId) && await q("SELECT * FROM catalog_shops WHERE id=? AND active=1").get(b.shopId);
    if (!sh || sh.area !== b.from) bad("That shop is not available in the chosen pickup area. Refresh and try again.", 409);
    shop = sh.name; shopId = sh.id;
  } else shop = str(b.shop, 2, 60, "Shop name");
  if (b.items != null && !(Array.isArray(b.items) && !b.items.length)) {
    if (shopId == null) bad("Listed goods can only be ordered from a listed shop.");
    if (!Array.isArray(b.items) || b.items.length > 20) bad("Choose up to 20 different goods.");
    const seen = new Set();
    for (const li of b.items) {
      const id = li && li.id, n = li && li.q;
      if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || n > 50 || seen.has(id)) bad("Check the goods and quantities (1 to 50 each).");
      seen.add(id);
      const row = await q("SELECT name,unit,price FROM catalog_items WHERE id=? AND shop_id=? AND active=1").get(id, shopId); /* price comes from OUR list, never from the client */
      if (!row) bad("A chosen item is no longer available. Refresh and try again.", 409);
      lines.push({n: row.name, u: row.unit, p: row.price, q: n});
    }
  }
  const custom = lines.length ? (b.it ? str(b.it, 0, 80, "Other items") : "") : str(b.it, 2, 80, "Item name");
  const goods = lines.reduce((t, l) => t + l.p * l.q, 0);
  const item = (lines.map((l) => l.q + " × " + l.n + (l.u ? " (" + l.u + ")" : "")).join(", ") + (custom ? (lines.length ? " + " : "") + custom : "")).slice(0, 400);
  if (!phoneOk(b.rp)) bad("Recipient phone looks like 0712 345 678.");
  if (!Number.isInteger(b.w) || !C.WT[b.w]) bad("Choose a valid weight.");
  if (b.s !== "standard" && b.s !== "express") bad("Choose a valid speed.");
  /* How the order is paid. With M-Pesa configured there are two ways, both through the gateway:
     "mpesa" = pay now, before shippers see the request; "later" = pay after delivery, once the sender confirms receipt (listed shops, goods above the limit only).
     Without M-Pesa configured the app works as before: cash on delivery. */
  let pay = "cod";
  if (M.enabled()) {
    if (b.pay !== "mpesa" && b.pay !== "later") bad("Please refresh the page and choose how to pay.");
    pay = b.pay;
    if (pay === "later" && !(shopId != null && goods > C.DEFER_MIN)) bad("Pay after delivery is only for goods above KES " + C.DEFER_MIN + " from our listed shops. Choose pay now.");
  }
  const pp = pinIn(b.pp), dp = pinIn(b.dp);
  if ((await q("SELECT COUNT(*) c FROM deliveries WHERE owner=? AND step=0").get(req.user.id)).c >= 20) bad("You have too many pending requests. Cancel some or wait for pickup.", 429);
  const price = C.quote(b.from, b.to, b.w, b.s, feeFor(b.from, b.to)).total; /* price is always computed server-side */
  if (b.custom && shopId == null) try { await q("INSERT INTO shops(uid,area,name) VALUES(?,?,?)").run(req.user.id, b.from, shop); } catch (e) {}
  let id;
  for (let i = 0; i < 5; i++) {
    id = "SMD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    try { await q("INSERT INTO deliveries(id,owner,shop,src,dst,land,drop_,pp,dp,item,w,spd,rn,rp,price,step,at,items,goods,custom,pay,pay_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)").run(id, req.user.id, shop, b.from, b.to, land, drop, pp, dp, item, b.w, b.s, rn, b.rp.trim(), price, Date.now(), lines.length ? JSON.stringify(lines) : null, goods, custom, pay, pay === "mpesa" ? "awaiting" : pay === "later" ? "later" : "na"); break; }
    catch (e) { id = null; }
  }
  if (!id) bad("Could not create request. Try again.", 500);
  announceJob(id); /* not awaited: alerts shippers when the job is already on the board (unpaid M-Pesa orders are announced once paid) */
  res.status(201).json(mapD(await q("SELECT * FROM deliveries WHERE id=?").get(id), "s"));
}));
api.delete("/deliveries/:id", need("sender"), wrap(async (req, res) => {
  const id = String(req.params.id);
  const d = await q("SELECT pay_state FROM deliveries WHERE id=? AND owner=? AND step=0").get(id, req.user.id);
  if (d && d.pay_state === "paid") bad("This request is already paid by M-Pesa. Contact support to cancel and get a refund.", 409);
  if (d && await q("SELECT 1 x FROM payments WHERE delivery_id=? AND status IN ('initiating','pending')").get(id)) bad("An M-Pesa payment is in progress. Wait a minute, then try again.", 409);
  const r = await q("DELETE FROM deliveries WHERE id=? AND owner=? AND step=0 AND pay_state<>'paid'").run(id, req.user.id);
  if (!r.changes) bad("Only your own pending requests can be cancelled.", 409);
  res.json({ok: true});
}));

/* Shipper */
api.get("/jobs", need("shipper"), approved, wrap(async (req, res) => {
  const a = String(req.query.area || "all"); if (a !== "all" && !Object.hasOwn(C.AREAS, a)) bad("Invalid area.");
  const rows = a === "all" ? await q("SELECT * FROM deliveries WHERE step=0 AND shipper IS NULL AND pay_state<>'awaiting' ORDER BY at DESC LIMIT 100").all()
    : await q("SELECT * FROM deliveries WHERE step=0 AND shipper IS NULL AND pay_state<>'awaiting' AND src=? ORDER BY at DESC LIMIT 100").all(a);
  res.json(rows.map((d) => mapD(d, "j")));
}));
api.get("/jobs/mine", need("shipper"), approved, wrap(async (req, res) =>
  res.json((await q("SELECT d.*, u.name oname, u.phone ophone FROM deliveries d JOIN users u ON u.id=d.owner WHERE d.shipper=? ORDER BY d.step ASC, d.at DESC").all(req.user.id)).map((d) => mapD(d, "m")))));
api.post("/jobs/:id/accept", need("shipper"), approved, wrap(async (req, res) => {
  if ((await q("SELECT COUNT(*) c FROM deliveries WHERE shipper=? AND step=1").get(req.user.id)).c >= 10) bad("Finish your active jobs before accepting more.", 429);
  const u = req.user; /* single atomic UPDATE: only one shipper can win */
  const r = await q("UPDATE deliveries SET shipper=?, sname=?, sphone=?, veh=?, step=1 WHERE id=? AND step=0 AND shipper IS NULL AND pay_state<>'awaiting'").run(u.id, u.name, u.phone, u.veh, String(req.params.id));
  if (!r.changes) bad("Sorry, that job was already taken.", 409);
  res.json({ok: true});
}));
/* A delivery is Completed only when BOTH sides have signed off: the shipper ("I delivered it") and the sender ("I received it"), in either order. */
/* Completed = both signed off AND, for pay-after-delivery orders, the M-Pesa payment received. */
const finalize = (id) => q("UPDATE deliveries SET step=2 WHERE id=? AND step=1 AND ship_ok IS NOT NULL AND own_ok IS NOT NULL AND pay_state<>'later'").run(id);
async function signOff(id, col, who, whoId) {
  const r = await q("UPDATE deliveries SET " + col + "=? WHERE id=? AND " + who + "=? AND step=1 AND " + col + " IS NULL").run(Date.now(), id, whoId);
  if (!r.changes) return false;
  await finalize(id);
  return true;
}
api.post("/jobs/:id/deliver", need("shipper"), approved, wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!(await signOff(id, "ship_ok", "shipper", req.user.id))) bad("That job cannot be marked delivered.", 409);
  res.json({ok: true, done: (await q("SELECT step FROM deliveries WHERE id=?").get(id)).step === 2});
}));
api.post("/deliveries/:id/confirm", need("sender"), wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!(await signOff(id, "own_ok", "owner", req.user.id))) bad("That delivery cannot be confirmed.", 409);
  const d = await q("SELECT step, pay_state FROM deliveries WHERE id=?").get(id);
  res.json({ok: true, done: d.step === 2, needPay: d.pay_state === "later"}); /* needPay: the sender now pays through M-Pesa */
}));

/* ---------- M-Pesa (Daraja STK Push) ---------- */
/* Applies a final result to a payment exactly once. Safe to call from the callback AND from the status poll: whichever arrives first wins.
   Money moved (code 0) is always honoured, even if we had already marked the attempt failed/timed out locally. */
async function settle(p, r) { /* r = {code, desc, amount?, receipt?} */
  const now = Date.now();
  if (r.code === 0) {
    if (["success", "duplicate", "mismatch", "orphan"].includes(p.status)) return p.status;
    if (r.amount != null && r.amount !== p.amount) { /* never mark an order paid for the wrong amount: flag for a human */
      await q("UPDATE payments SET status='mismatch', result_code=0, result_desc=?, receipt=?, updated=? WHERE id=?").run("expected " + p.amount + " got " + r.amount, r.receipt, now, p.id);
      console.error("[mpesa] AMOUNT MISMATCH payment", p.id, "order", p.delivery_id, "expected", p.amount, "got", r.amount, "receipt", r.receipt); return "mismatch";
    }
    const d = await q("SELECT pay_state FROM deliveries WHERE id=?").get(p.delivery_id);
    let st = "success";
    if (!d) st = "orphan"; /* order was deleted while the prompt was open: needs a refund */
    else if (d.pay_state === "paid") st = "duplicate"; /* customer paid twice: needs a refund */
    await q("UPDATE payments SET status=?, result_code=0, result_desc=?, receipt=?, updated=? WHERE id=?").run(st, r.desc || "OK", r.receipt || null, now, p.id);
    if (st === "success") { await q("UPDATE deliveries SET pay_state='paid', pay='mpesa', receipt=? WHERE id=?").run(r.receipt || null, p.delivery_id); await finalize(p.delivery_id); announceJob(p.delivery_id); }
    else console.error("[mpesa] REFUND NEEDED (" + st + ") payment", p.id, "order", p.delivery_id, "amount", p.amount, "receipt", r.receipt);
    return st;
  }
  if (p.status !== "initiating" && p.status !== "pending") return p.status; /* a late "failed" must never undo anything */
  const st = r.code === 1032 ? "cancelled" : r.code === -1 ? "timeout" : "failed";
  await q("UPDATE payments SET status=?, result_code=?, result_desc=?, updated=? WHERE id=?").run(st, r.code, r.desc || "", now, p.id);
  return st;
}

const QUERY_AFTER = +process.env.PAY_QUERY_AFTER_MS || 12000, QUERY_EVERY = +process.env.PAY_QUERY_EVERY_MS || 8000; /* env overrides exist for tests */
const PAYFLOW_MS = +process.env.PAY_TIMEOUT_MS || 3 * 60000; /* an STK prompt is dead after ~1 minute; after 3 we stop waiting and let the customer retry */
const payRow = (id) => q("SELECT * FROM payments WHERE id=?").get(id);
const ownDelivery = async (req) => (await q("SELECT * FROM deliveries WHERE id=? AND owner=?").get(String(req.params.id), req.user.id)) || bad("Not found.", 404);
const payLimit = rateLimit({windowMs: 60000, limit: +process.env.PAY_RATE_LIMIT || 6, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => "u" + req.user.id, message: {error: "Too many payment attempts. Please wait a minute."}});

/* Start a payment: sends the PIN prompt to the customer's phone. The amount is ALWAYS computed here from the stored order. */
api.post("/deliveries/:id/pay", need("sender"), payLimit, wrap(async (req, res) => {
  if (!M.enabled()) bad("M-Pesa payment is not available right now.", 503);
  const d = await ownDelivery(req);
  if (d.pay_state === "paid") bad("This request is already paid.", 409);
  /* payable: a pay-now order still waiting for its money, or a pay-after-delivery order whose sender has confirmed receipt */
  if (!((d.pay_state === "awaiting" && d.step === 0) || (d.pay_state === "later" && d.step === 1 && d.own_ok))) bad("This request cannot be paid online right now.", 409);
  const phone = req.body.phone == null ? req.user.phone : req.body.phone;
  if (typeof phone !== "string" || !phoneOk(phone) || !M.toMsisdn(phone)) bad("Enter a valid Safaricom number, e.g. 0712 345 678.");
  const amount = d.price + (d.goods || 0), now = Date.now();
  let id;
  try { id = Number((await q("INSERT INTO payments(delivery_id,uid,phone,amount,status,created,updated) VALUES(?,?,?,?, 'initiating',?,?)").run(d.id, req.user.id, M.toMsisdn(phone), amount, now, now)).lastInsertRowid); }
  catch (e) { /* unique index pay_active: a prompt for this order is already open */
    const old = await q("SELECT * FROM payments WHERE delivery_id=? AND status IN ('initiating','pending')").get(d.id);
    if (old && now - old.created > PAYFLOW_MS) { await settle(old, {code: -1, desc: "No response from customer"}); return res.status(409).json({error: "The previous request expired. Tap Pay again."}); }
    bad("A payment request is already open on your phone. Enter your PIN, or wait a minute and try again.", 409);
  }
  try {
    const r = await M.stkPush({phone, amount, ref: d.id, desc: "SMD delivery"});
    await q("UPDATE payments SET status='pending', checkout_id=?, merchant_id=?, updated=? WHERE id=? AND status='initiating'").run(r.checkoutRequestId, r.merchantRequestId, Date.now(), id);
    res.status(202).json({status: "pending", amount, phone: r.msisdn.replace(/^254/, "0")});
  } catch (e) {
    await q("UPDATE payments SET status='failed', result_desc=?, updated=? WHERE id=?").run(String(e.message).slice(0, 200), Date.now(), id);
    if (e.user) bad(e.message); if (!(e instanceof Error) || e.name !== "AbortError") console.error("[mpesa] pay error:", e.message);
    bad(e.message && /M-Pesa/.test(e.message) ? e.message : "Could not reach M-Pesa. Please try again.", 502);
  }
}));

/* Poll target for the checkout screen. If the callback is late we ask Safaricom directly (at most every 8 s), so a lost callback never strands a customer. */
api.get("/deliveries/:id/payment", need("sender"), wrap(async (req, res) => {
  const d = await ownDelivery(req);
  let p = await q("SELECT * FROM payments WHERE delivery_id=? ORDER BY id DESC LIMIT 1").get(d.id);
  if (p && d.pay_state !== "paid" && (p.status === "pending" || p.status === "initiating")) {
    const now = Date.now();
    if (p.status === "pending" && p.checkout_id && now - p.created > QUERY_AFTER && now - p.checked > QUERY_EVERY) {
      await q("UPDATE payments SET checked=? WHERE id=?").run(now, p.id);
      try { const s = await M.stkQuery(p.checkout_id); if (!s.pending) await settle(await payRow(p.id), {code: s.code, desc: s.desc}); } catch (e) { /* try again on the next poll */ }
    }
    p = await payRow(p.id);
    if ((p.status === "pending" || p.status === "initiating") && now - p.created > PAYFLOW_MS) { await settle(p, {code: -1, desc: "No response from customer"}); p = await payRow(p.id); }
  }
  const dd = await q("SELECT pay_state, receipt FROM deliveries WHERE id=?").get(d.id), st = dd.pay_state === "paid" ? "success" : p ? p.status : "none";
  res.json({state: st, payState: dd.pay_state, receipt: dd.receipt || "", message: st === "success" ? "Payment received." : st === "pending" || st === "initiating" ? "Waiting for you to enter your M-Pesa PIN…" : p && p.result_code != null ? M.explain(p.result_code) : p ? "The payment was not completed." : ""});
}));

/* Customer would rather pay after delivery (only allowed for listed-shop orders with goods above the limit): the order goes to the job board. */
const laterOk = (d) => !!d.items && d.goods > C.DEFER_MIN;
api.post("/deliveries/:id/later", need("sender"), wrap(async (req, res) => {
  const d = await ownDelivery(req);
  if (!laterOk(d)) bad("Pay after delivery is only for goods above KES " + C.DEFER_MIN + " from our listed shops.", 409);
  if (await q("SELECT 1 x FROM payments WHERE delivery_id=? AND status IN ('initiating','pending')").get(d.id)) bad("An M-Pesa payment is still in progress. Wait a minute, then try again.", 409);
  const r = await q("UPDATE deliveries SET pay='later', pay_state='later' WHERE id=? AND owner=? AND step=0 AND pay_state='awaiting'").run(d.id, req.user.id);
  if (!r.changes) bad("This request cannot be switched to pay after delivery.", 409);
  announceJob(d.id);
  res.json(mapD(await q("SELECT * FROM deliveries WHERE id=?").get(d.id), "s"));
}));

/* ---------- Admin: delivery fees between places ---------- */
const placePairs = () => { const n = Object.keys(C.AREAS).sort((a, b) => C.AREAS[a].pos - C.AREAS[b].pos), o = []; n.forEach((a, i) => n.slice(i).forEach((b) => o.push([a, b]))); return o; };
const feeRows = () => placePairs().map(([a, b]) => { const bs = C.routeBase(a, b), k = C.feeKey(a, b); return {a, b, auto: bs.route + bs.ferry, fee: Object.hasOwn(FEES, k) ? FEES[k] : null}; });
api.get("/admin/fees", need("admin"), wrap(async (req, res) => res.json({fees: feeRows(), note: "Fee for one trip before weight surcharge and express."})));
api.put("/admin/fees", need("admin"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!Object.hasOwn(C.AREAS, b.a) || !Object.hasOwn(C.AREAS, b.b)) bad("Choose valid places.");
  if (!Number.isInteger(b.fee) || b.fee < 10 || b.fee > 50000) bad("Fee must be a whole number between 10 and 50,000.");
  const [x, y] = [b.a, b.b].sort();
  await q("INSERT INTO fees(a,b,fee,updated) VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET fee=excluded.fee, updated=excluded.updated").run(x, y, b.fee, Date.now());
  await loadFees(); res.json({fees: feeRows()});
}));
api.delete("/admin/fees", need("admin"), wrap(async (req, res) => { /* back to the automatic fee */
  const b = req.body || {}; if (!Object.hasOwn(C.AREAS, b.a) || !Object.hasOwn(C.AREAS, b.b)) bad("Choose valid places.");
  const [x, y] = [b.a, b.b].sort(); await q("DELETE FROM fees WHERE a=? AND b=?").run(x, y);
  await loadFees(); res.json({fees: feeRows()});
}));

api.use((req, res, next) => next(new HttpError(404, "Not found.")));
app.use("/api", api);
/* Safaricom's result callback. Lives outside /api (no cookie, no Origin header). The secret in the path is the authentication;
   optionally also pin Safaricom's source IPs with MPESA_CALLBACK_IPS (comma-separated; needs TRUST_PROXY behind a proxy).
   We always answer 200 quickly once the request is authentic: Safaricom retries otherwise, and we apply results idempotently anyway. */
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ALLOW_IPS = (process.env.MPESA_CALLBACK_IPS || "").split(",").map((s) => s.trim().replace(/^::ffff:/, "")).filter(Boolean);
app.post("/hooks/pay/:secret", rateLimit({windowMs: 60000, limit: 120, standardHeaders: false, legacyHeaders: false}), express.json({limit: "20kb"}), async (req, res) => {
  const secret = M.cfg().callbackSecret;
  if (!secret || !eq(req.params.secret, secret)) return res.status(404).end();
  if (ALLOW_IPS.length && !ALLOW_IPS.includes(String(req.ip).replace(/^::ffff:/, ""))) { console.error("[mpesa] callback from unlisted IP", req.ip); return res.status(404).end(); }
  try {
    const cb = M.parseCallback(req.body), p = cb && await q("SELECT * FROM payments WHERE checkout_id=?").get(cb.checkoutRequestId);
    if (!p) console.error("[mpesa] callback for unknown or malformed request", cb ? cb.checkoutRequestId : "(bad body)");
    else await settle(p, {code: cb.code, desc: cb.desc, amount: cb.amount, receipt: cb.receipt});
  } catch (e) { console.error("[mpesa] callback error:", e.message); }
  res.json({ResultCode: 0, ResultDesc: "Accepted"});
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") err = new HttpError(400, "Invalid JSON.");
  if (err.type === "entity.too.large") err = new HttpError(413, "Request too large.");
  const s = err.status || 500; if (s === 500) console.error(err);
  res.status(s).json({error: s === 500 ? "Something went wrong." : err.message});
});

async function cleanup() {
  const now = Date.now();
  await q("DELETE FROM sessions WHERE exp<?").run(now); await q("DELETE FROM resets WHERE exp<?").run(now); await q("DELETE FROM email_codes WHERE exp<?").run(now);
  for (const u of await q("SELECT id FROM users WHERE email_verified=0 AND created<?").all(now - 24 * 3600e3)) await dropUnverified(u.id);
  await q("DELETE FROM fails WHERE until<? AND n=0").run(now);
}
setInterval(() => cleanup().catch((e) => console.error("cleanup failed:", e.message)), 3600e3).unref();
const ready = initDb(); /* tables, upgrades, sample shops, admins: must finish before we accept requests */
if (require.main === module) ready.then(() => app.listen(PORT, () => console.log("SMD running on http://localhost:" + PORT)), (e) => { console.error("Database start-up failed:", e.message); process.exit(1); });
module.exports = app;
