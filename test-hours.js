"use strict";
/* Tests for shop opening hours: the clock logic (pure) and the server rules. Run: node test-hours.js */
const {DatabaseSync} = require("node:sqlite"), {spawn} = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const H = require("./hours");
const rnd = () => 3900 + Math.floor(Math.random() * 900);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-hours-")), out = [], procs = [];
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓ " + name); } else { failN++; console.log("  ✗ FAIL: " + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(env) {
  const port = rnd(), base = "http://127.0.0.1:" + port, db = path.join(dir, "t" + port + ".db");
  const p = spawn(process.execPath, ["server.js"], {env: {...process.env, PORT: port, DB_PATH: db, AUTH_RATE_LIMIT: "500", API_RATE_LIMIT: "5000", UPLOAD_RATE_LIMIT: "500", ADMIN_EMAIL: "admin@x.co", NODE_ENV: "test", ...env}});
  p.stdout.on("data", (d) => out.push(String(d))); p.stderr.on("data", (d) => out.push(String(d))); procs.push(p);
  for (let i = 0; i < 60; i++) { try { await fetch(base + "/api/config"); break; } catch (e) { await sleep(150); } }
  return {base, db};
}
class Agent {
  constructor(base) { this.base = base; this.cookie = ""; }
  async call(method, url, body, headers = {}, raw) {
    const h = {...headers}; if (this.cookie) h.cookie = this.cookie;
    if (method !== "GET" && !raw) h["content-type"] = h["content-type"] || "application/json";
    const r = await fetch(this.base + url, {method, headers: h, body: method === "GET" ? undefined : (raw ? body : JSON.stringify(body || {}))});
    const sc = r.headers.getSetCookie(); if (sc.length) { const c = sc[0].split(";")[0]; this.cookie = c.endsWith("=") ? "" : c; }
    let j = {}; try { j = await r.json(); } catch (e) {} return {s: r.status, j};
  }
  chat(...texts) { return this.call("POST", "/api/chat", {messages: texts.map((t) => ({role: "user", content: t}))}).then((r) => r); }
}
const sig = (e, extra) => Object.assign({name: "Test User", phone: "0712 345 678", email: e, password: "correct-horse-9", role: "sender", consent: true}, extra);
const codeFor = async (email) => { await sleep(150); const all = [...out.join("").matchAll(new RegExp("verification code for " + email.replace(/\./g, "\\.") + ": ([A-Z0-9]+)", "g"))]; return all.length ? all[all.length - 1][1] : ""; };
const register = async (a, body) => { const r = await a.call("POST", "/api/auth/signup", body); if (r.s !== 201) return r; return a.call("POST", "/api/auth/verify", {email: body.email, code: await codeFor(body.email)}); };
const JPEG = (n = 8000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const shipSig = (e, extra) => sig(e, Object.assign({role: "shipper", veh: "Motorbike", area: "Mombasa", name: "Some Shipper", phone: "0733 000 111", idType: "National ID", idNumber: "ID" + e.replace(/\W/g, "").toUpperCase(), dob: "1990-01-01", address: "Nyali, Mombasa", idConsent: true}, extra));
const delivery = (extra) => Object.assign({from: "Mombasa", to: "Diani", shop: "Sample Supermarket", land: "", drop: "Sea Lodge Road, blue gate", it: "Groceries", w: 0, s: "standard", rn: "Amina Hassan", rp: "0722 111 222"}, extra);

const eat = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 3, mi); /* a moment in East Africa Time */
const week = (o, c, off = []) => { const w = {}; for (let d = 0; d < 7; d++) w[d] = off.includes(d) ? null : [o, c]; return w; };
const st = (h, ms, extra) => H.status({hours: h && JSON.stringify(h), ...extra}, ms);
(async () => {
  console.log("Hours: the clock logic (Friday 20 Nov 2026 is a Friday)");
  const W = week("08:00", "20:00", [0]); /* open Mon to Sat, closed Sunday */
  ok(H.nowEAT(eat(2026, 11, 20, 10, 5)).day === 5 && H.nowEAT(eat(2026, 11, 20, 10, 5)).min === 605, "times are read in East Africa Time");
  ok(st(null, eat(2026, 11, 20, 10, 0)).open && st(null).label === "" && !st(null).hoursSet, "a shop with no hours set is always open");
  let s = st(W, eat(2026, 11, 20, 10, 0)); ok(s.open && s.label === "Open · closes 20:00", "open in the middle of the day");
  ok(st(W, eat(2026, 11, 20, 8, 0)).open, "open exactly at opening time"); ok(!st(W, eat(2026, 11, 20, 20, 0)).open, "closed exactly at closing time");
  ok(st(W, eat(2026, 11, 20, 7, 0)).label === "Closed · opens today 08:00", "before opening: opens today");
  ok(st(W, eat(2026, 11, 20, 21, 0)).label === "Closed · opens tomorrow 08:00", "after closing: opens tomorrow");
  ok(st(W, eat(2026, 11, 21, 21, 0)).label === "Closed · opens Mon 08:00", "Saturday night with Sunday closed: opens Monday");
  ok(st(W, eat(2026, 11, 22, 12, 0)).label === "Closed · opens tomorrow 08:00", "on the closed Sunday: opens Monday (tomorrow)");
  s = st(W, eat(2026, 11, 20, 10, 0), {closed_now: 1}); ok(!s.open && s.paused && s.label === "Closed for now", "'closed for now' beats the hours");
  const N = week("18:00", "02:00");
  ok(st(N, eat(2026, 11, 20, 23, 0)).open && st(N, eat(2026, 11, 21, 1, 0)).label === "Open · closes 02:00", "a night shop stays open past midnight");
  ok(!st(N, eat(2026, 11, 20, 3, 0)).open && st(N, eat(2026, 11, 20, 3, 0)).label === "Closed · opens today 18:00", "...and shuts after its closing time");
  ok(st(week("00:00", "00:00"), eat(2026, 11, 20, 4, 0)).label === "Open 24 hours", "00:00 to 00:00 means open 24 hours");
  ok(st({...week("08:00", "20:00", [0, 1, 2, 3, 4, 5, 6])}, 0) !== undefined, "an all-closed week does not crash status");
  ok(H.clean(null) === null, "clean: no hours is allowed");
  ok(JSON.stringify(H.clean({0: null, 1: {o: "08:00", c: "17:30"}, 2: ["09:00", "18:00"]})[1]) === '["08:00","17:30"]', "clean: accepts {o,c} and [open, close]");
  for (const [label, v] of [["bad time", {1: ["25:00", "17:00"]}], ["bad format", {1: ["8:00", "17:00"]}], ["same open and close", {1: ["08:00", "08:00"]}], ["all days closed", {}], ["a list", [1, 2]], ["numbers", {1: [800, 1700]}]]) {
    let e = ""; try { H.clean(v); } catch (x) { e = x.message; } ok(e.length > 0, "clean refuses: " + label);
  }

  console.log("\nHours: the server rules");
  const S = await start({}), A = new Agent(S.base);
  let r;
  const adm = new Agent(S.base); await register(adm, sig("admin@x.co", {name: "Admin Person"}));
  const OW = new Agent(S.base); await register(OW, sig("o@x.co", {role: "owner", name: "Mama Owner", shopName: "Mama Njeri Stores", area: "Mombasa"}));
  const SN = new Agent(S.base); await register(SN, sig("s@x.co", {name: "Sam Sender"}));
  const sid = new DatabaseSync(S.db).prepare("SELECT id FROM catalog_shops WHERE name='Mama Njeri Stores'").get().id;
  await adm.call("PATCH", "/api/admin/shops/" + sid, {active: true, rec: true});
  const now = new Date(Date.now() + 3 * 3600e3), m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hhmm = (x) => { x = ((x % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
  const aroundNow = week(hhmm(m - 60), hhmm(m + 60)), farAway = week(hhmm(m + 720), hhmm(m + 721));
  const order = (extra) => ({from: "Mombasa", to: "Diani", shop: "Mama Njeri Stores", shopId: sid, drop: "Sea Lodge Road", it: "Sugar", w: 0, s: "standard", rn: "Amina Hassan", rp: "0722 111 222", ...extra});
  const mine = async () => (await SN.call("GET", "/api/shops")).j.find((x) => x.id === sid);

  ok((await mine()).open === true && (await mine()).hoursSet === false, "a shop with no hours is open and says its hours are not set");
  r = await OW.call("GET", "/api/owner/shop"); ok(r.j.shop.hours === null && r.j.shop.closedNow === false && r.j.shop.open === true, "the owner sees no hours yet");
  r = await SN.call("PUT", "/api/owner/hours", {hours: aroundNow}); ok(r.s === 403, "only a shop owner can set hours");
  r = await OW.call("PUT", "/api/owner/hours", {hours: {1: ["25:00", "17:00"]}}); ok(r.s === 400 && /times like/.test(r.j.error), "bad times are refused with a clear message");
  r = await OW.call("PUT", "/api/owner/hours", {hours: {}}); ok(r.s === 400, "a week with every day closed is refused");
  r = await OW.call("PUT", "/api/owner/hours", {hours: farAway}); ok(r.s === 200 && r.j.shop.open === false && /^Closed/.test(r.j.shop.hoursLabel), "owner sets hours that exclude now: the shop shows as closed");
  ok(JSON.stringify(r.j.shop.hours[1]).includes(":"), "the owner gets the saved week back");
  const sh = await mine(); ok(sh.open === false && /^Closed/.test(sh.hoursLabel), "customers see the shop as closed with a label");
  r = await SN.call("POST", "/api/deliveries", order()); ok(r.s === 409 && /closed right now/.test(r.j.error), "ordering from a closed shop is refused");
  r = await SN.call("POST", "/api/deliveries", order({shopId: undefined, shop: "mama njeri stores"})); ok(r.s === 409 && /closed right now/.test(r.j.error), "typing the shop's name does not get around its hours");
  r = await SN.call("POST", "/api/deliveries", order({shopId: undefined, shop: "Some Corner Duka", custom: true})); ok(r.s === 201, "a shop that is not registered can still be typed in");
  r = await SN.call("GET", "/api/nearby?area=Mombasa"); const names = r.j.shops.map((x) => x.name), idx = names.indexOf("Mama Njeri Stores");
  ok(idx >= 0 && r.j.shops[idx].open === false && r.j.shops.slice(0, idx).every((x) => x.open) && idx === names.length - 1, "'Near you' lists closed shops after the open ones, marked closed");

  r = await OW.call("PUT", "/api/owner/hours", {hours: aroundNow}); ok(r.s === 200 && r.j.shop.open === true && /^Open · closes/.test(r.j.shop.hoursLabel), "owner changes the hours so the shop is open now");
  r = await SN.call("POST", "/api/deliveries", order()); ok(r.s === 201, "an order from the open shop goes through");
  r = await OW.call("PUT", "/api/owner/hours", {hours: aroundNow, closedNow: true}); ok(r.s === 200 && r.j.shop.open === false && r.j.shop.paused === true && r.j.shop.hoursLabel === "Closed for now", "'closed for now' pauses orders even inside opening hours");
  r = await SN.call("POST", "/api/deliveries", order()); ok(r.s === 409 && /break from orders/.test(r.j.error), "paused shop refuses orders and says why");
  const pending = new DatabaseSync(S.db).prepare("SELECT COUNT(*) c FROM deliveries WHERE shop='Mama Njeri Stores'").get().c; ok(pending === 1, "the earlier order was not touched when the shop closed");
  r = await OW.call("PUT", "/api/owner/hours", {hours: null}); ok(r.s === 200 && r.j.shop.hours === null && r.j.shop.open === true, "owner can clear the hours (always open again)");
  r = await adm.call("PATCH", "/api/admin/shops/" + sid, {hours: farAway}); ok(r.s === 200, "an admin can set hours too");
  r = await adm.call("GET", "/api/admin/shops"); const ash = r.j.shops.find((x) => x.id === sid); ok(ash.open === false && ash.hours && ash.closedNow === false, "the admin list shows the hours and status");
  r = await adm.call("PATCH", "/api/admin/shops/" + sid, {hours: {1: ["99:00", "10:00"]}}); ok(r.s === 400, "the admin cannot save bad hours either");
  r = await adm.call("PATCH", "/api/admin/shops/" + sid, {closedNow: false, hours: null}); ok(r.s === 200 && (await mine()).open === true, "the admin can reopen the shop");

  console.log("\n" + pass + " passed, " + failN + " failed");
  procs.forEach((p) => p.kill()); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
