"use strict";
/* End-to-end tests: starts a real server on a temp database and exercises auth, privacy and job logic. Run: npm test */
const {DatabaseSync} = require("node:sqlite"), {spawn} = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 3900 + Math.floor(Math.random() * 90), BASE = "http://127.0.0.1:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-")), out = [];
const srv = spawn(process.execPath, ["server.js"], {env: {...process.env, PORT, DB_PATH: path.join(dir, "t.db"), AUTH_RATE_LIMIT: "500", API_RATE_LIMIT: "5000", UPLOAD_RATE_LIMIT: "500", ADMIN_EMAIL: "admin@x.co", NODE_ENV: "test"}});
srv.stdout.on("data", (d) => out.push(String(d))); srv.stderr.on("data", (d) => out.push(String(d)));
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓ " + name); } else { failN++; console.log("  ✗ FAIL: " + name); } };
class Agent {
  constructor() { this.cookie = ""; }
  async call(method, url, body, headers = {}, raw) {
    const h = {...headers}; if (cookieOn(this)) h.cookie = this.cookie;
    if (method !== "GET" && !raw) h["content-type"] = h["content-type"] || "application/json";
    const r = await fetch(BASE + url, {method, headers: h, body: method === "GET" ? undefined : (raw ? body : JSON.stringify(body || {}))});
    const sc = r.headers.getSetCookie(); this.setCookie = sc[0] || "";
    if (sc.length) { const c = sc[0].split(";")[0]; this.cookie = c.endsWith("=") ? "" : c; }
    let j = {}; try { j = await r.json(); } catch (e) {} return {s: r.status, j, h: r.headers};
  }
}
const cookieOn = (a) => !!a.cookie;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (e, extra) => Object.assign({name: "Test User", phone: "0712 345 678", email: e, password: "correct-horse-9", role: "sender"}, extra);
/* Helpers for the verification flow: codes are read from the dev log, exactly as an emailed code would be typed in */
const codeFor = async (email, kind = "verification") => { await sleep(120); const all = [...out.join("").matchAll(new RegExp(kind + " code for " + email.replace(/\./g, "\\.") + ": ([A-Z0-9]+)", "g"))]; return all.length ? all[all.length - 1][1] : null; };
const register = async (agent, body) => { const r = await agent.call("POST", "/api/auth/signup", body); if (r.s !== 201) return r; return agent.call("POST", "/api/auth/verify", {email: body.email, code: await codeFor(body.email)}); };
const JPEG = (n = 8000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const shipSig = (e, extra) => sig(e, Object.assign({role: "shipper", veh: "Motorbike", area: "Mombasa", name: "Some Shipper", phone: "0733 000 111", idType: "National ID", idNumber: "ID" + e.replace(/\W/g, "").toUpperCase(), dob: "1995-05-05", address: "Nyali, Mombasa"}, extra));
const putDoc = (a, kind, buf, type = "image/jpeg") => a.call("PUT", "/api/me/id-docs/" + kind, buf, {"content-type": type}, true);
const submitFromMe = async (a, extra) => { const m = (await a.call("GET", "/api/me")).j.user; return a.call("POST", "/api/me/verification", Object.assign({idType: m.idType, idNumber: m.idNumber, dob: m.dob, address: m.address}, extra)); };
const ADM = new Agent();
const pendingId = async (email) => (await ADM.call("GET", "/api/admin/shippers?status=pending")).j.shippers.find((x) => x.email === email);
const approvedShipper = async (a, e, extra) => { await register(a, shipSig(e, extra)); for (const k of ["front", "back", "selfie"]) await putDoc(a, k, JPEG()); await submitFromMe(a); const id = (await pendingId(e)).id; await ADM.call("POST", "/api/admin/shippers/" + id + "/approve"); return id; };
const delivery = (extra) => Object.assign({from: "Mombasa", to: "Diani", shop: "Sample Supermarket", land: "", drop: "Sea Lodge Road, blue gate", it: "Groceries", w: 0, s: "standard", rn: "Amina", rp: "0722 111 222", pp: null, dp: {lat: -4.3, lng: 39.57}}, extra);

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/config"); break; } catch (e) { await sleep(150); } }
  let r;
  console.log("Terms page");
  r = await fetch(BASE + "/terms"); let t = await r.text();
  ok(r.status === 200 && /Terms of Use and Privacy Policy/.test(t) && /Data Protection Act, 2019/.test(t) && /only to verify who you are/i.test(t) && /without your consent/.test(t) && !/{{/.test(t), "the combined Terms and Privacy page is served, with no leftover placeholders");
  for (const u of ["/privacy", "/privacy-policy", "/terms-and-privacy"]) { r = await fetch(BASE + u); ok(r.status === 200 && /Part B: Privacy Policy/.test(await r.text()), u + " shows the same page"); }
  ok(/shipper/i.test(t) && /shop owner/i.test(t) && /sub-admin/i.test(t) && /Safaricom/.test(t) && /delete-account/.test(t), "it covers shippers, shop owners, reviewers, M-Pesa and deletion");

  console.log("Consent at sign-up");
  const A = new Agent();
  r = await A.call("POST", "/api/auth/signup", sig("c1@x.co")); ok(r.s === 400 && /Terms of Use/.test(r.j.error), "sign-up without consent is refused");
  r = await A.call("POST", "/api/auth/signup", sig("c1@x.co", {consent: "yes"})); ok(r.s === 400, "consent must be exactly true");
  r = await A.call("POST", "/api/auth/signup", sig("c1@x.co", {consent: true})); ok(r.s === 201, "sign-up with consent works");
  r = await A.call("POST", "/api/auth/verify", {email: "c1@x.co", code: await codeFor("c1@x.co")}); ok(r.s === 200 && r.j.user.needConsent === false && r.j.user.consentVer === "2026-10", "new account is on the current version");
  const db = new DatabaseSync(path.join(dir, "t.db")); const row = db.prepare("SELECT consent_at, consent_ver FROM users WHERE email='c1@x.co'").get();
  ok(row.consent_ver === "2026-10" && Math.abs(row.consent_at - Date.now()) < 60000, "the date and version of the consent are recorded");
  r = await new Agent().call("POST", "/api/auth/signup", shipSig("c2@x.co", {consent: true})); ok(r.s === 400 && /ID/.test(r.j.error), "a shipper must also give the separate ID consent");
  r = await new Agent().call("POST", "/api/auth/signup", shipSig("c2@x.co", {consent: true, idConsent: false})); ok(r.s === 400, "ID consent must be exactly true");
  r = await new Agent().call("POST", "/api/auth/signup", shipSig("c2@x.co", {consent: true, idConsent: true})); ok(r.s === 201, "a shipper with both consents signs up");
  r = await new Agent().call("POST", "/api/auth/signup", sig("c3@x.co", {role: "owner", shopName: "Cs Shop", area: "Diani"})); ok(r.s === 400, "a shop owner needs consent too");
  r = await new Agent().call("POST", "/api/auth/signup", sig("c3@x.co", {role: "owner", shopName: "Cs Shop", area: "Diani", consent: true})); ok(r.s === 201, "and can sign up with it");

  console.log("Re-consent for existing accounts");
  db.prepare("UPDATE users SET consent_ver=NULL, consent_at=NULL WHERE email='c1@x.co'").run();
  r = await A.call("GET", "/api/me"); ok(r.s === 200 && r.j.user.needConsent === true, "an older account is told it must accept");
  r = await A.call("GET", "/api/deliveries"); ok(r.s === 403 && r.j.needConsent === true, "and is blocked from using the service until it does");
  r = await A.call("POST", "/api/deliveries", delivery()); ok(r.s === 403 && r.j.needConsent === true, "including making orders");
  r = await A.call("POST", "/api/me/consent", {}); ok(r.s === 400, "accepting needs consent: true");
  r = await A.call("POST", "/api/me/consent", {consent: true}); ok(r.s === 200 && r.j.user.needConsent === false, "accepting lifts the block");
  r = await A.call("GET", "/api/deliveries"); ok(r.s === 200, "the account works again");
  db.prepare("UPDATE users SET consent_ver=NULL WHERE email='c1@x.co'").run();
  r = await A.call("POST", "/api/auth/logout"); ok(r.s === 200, "an account that has not accepted can still log out");
  const D2 = new Agent(); r = await D2.call("POST", "/api/auth/login", {email: "c1@x.co", password: "correct-horse-9"}); ok(r.s === 200 && r.j.user.needConsent === true, "and log in, to be asked again");
  r = await D2.call("POST", "/api/me/delete", {confirm: "DELETE", password: "correct-horse-9"}); ok(r.s === 200, "or delete the account without accepting");
  await register(ADM, sig("admin@x.co", {consent: true, name: "Admin Person"}));
  const SH = new Agent(); await register(SH, shipSig("c4@x.co", {consent: true, idConsent: true}));
  db.prepare("UPDATE users SET consent_ver=NULL WHERE email='c4@x.co'").run();
  r = await SH.call("POST", "/api/me/consent", {consent: true}); ok(r.s === 400 && /ID/.test(r.j.error), "an existing shipper must also accept the ID consent");
  r = await SH.call("POST", "/api/me/consent", {consent: true, idConsent: true}); ok(r.s === 200, "and then can continue");

  console.log("\n" + pass + " passed, " + failN + " failed");
  srv.kill(); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
