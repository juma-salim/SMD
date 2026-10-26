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
const sig = (e, extra) => Object.assign({name: "Test User", phone: "0712 345 678", email: e, password: "correct-horse-9", role: "sender", consent: true, idConsent: true}, extra);
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
  r = await register(ADM, sig("admin@x.co", {name: "Admin Person"})); ok(r.s === 200 && r.j.user.role === "admin", "admin ready");
  const db = new DatabaseSync(path.join(dir, "t.db"));
  console.log("Money");
  const OW = new Agent(); await register(OW, sig("own@x.co", {role: "owner", name: "Mama Owner", shopName: "Mama Mini Mart", area: "Diani"}));
  const shop = (await ADM.call("GET", "/api/admin/shops")).j.shops.find((s) => s.name === "Mama Mini Mart"); await ADM.call("PATCH", "/api/admin/shops/" + shop.id, {active: true, rec: true});
  r = await OW.call("POST", "/api/owner/items", {name: "Sugar", unit: "1 kg", price: 250}); const sugar = r.j.shop.items[0];
  const SND = new Agent(); await register(SND, sig("buyer@x.co"));
  const SH = new Agent(); const shId = await approvedShipper(SH, "ship@x.co", {name: "Hassan Mwangi", area: "Mombasa"});
  const complete = async (extra) => { const o = (await SND.call("POST", "/api/deliveries", delivery(extra))).j; await SH.call("POST", "/api/jobs/" + o.id + "/accept"); await SH.call("POST", "/api/jobs/" + o.id + "/deliver"); await SND.call("POST", "/api/deliveries/" + o.id + "/confirm"); return o; };
  const o1 = await complete({from: "Diani", to: "Ukunda", shop: undefined, shopId: shop.id, items: [{id: sugar.id, q: 4}]}); // goods 1000
  const o2 = await complete({}); // plain order, fee only
  const o3 = await complete({}); // completed but paid in cash: never counted
  db.prepare("UPDATE deliveries SET pay_state='paid', pay='mpesa' WHERE id IN (?,?)").run(o1.id, o2.id);
  ok(o1.goods === 1000 && o1.price > 0, "orders completed");

  r = await SND.call("GET", "/api/admin/money"); ok(r.s === 403, "only the admin can open Money");
  r = await ADM.call("GET", "/api/admin/money"); const M = r.j, fee = Math.floor(o1.price * 0.85) + Math.floor(o2.price * 0.85);
  ok(r.s === 200 && M.share === 85 && M.platformPct === 15, "money screen loads: shipper 85%, admin 15% by default");
  ok(M.shippers.length === 1 && M.shippers[0].earned === fee && M.shippers[0].owed === fee && M.shippers[0].n === 2, "shipper is owed 85% of the paid orders' fees only (cash order not counted)");
  ok(M.shops.length === 1 && M.shops[0].owed === 1000 && M.shops[0].owner === "Mama Owner" && M.shops[0].ref === "s:" + shop.id, "owner's shop is owed the goods amount");
  ok(M.platformEarned === o1.price + o2.price - fee, "admin's 15% is the rest of each paid delivery fee");
  r = await SH.call("GET", "/api/me"); ok(r.j.user.money.earned === fee && r.j.user.money.owed === fee, "shipper sees their own earnings");
  r = await OW.call("GET", "/api/owner/shop"); ok(r.j.money.owed === 1000 && r.j.money.orders === 1, "owner sees sales waiting for payout");

  const shipRef = M.shippers[0].ref;
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shipper", ref: shipRef, amount: fee + 1}); ok(r.s === 409, "cannot pay out more than is owed");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shipper", ref: shipRef, amount: 10.5}); ok(r.s === 400, "whole shillings only");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shipper", ref: "u:99999", amount: 10}); ok(r.s === 404, "unknown account refused");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "other", ref: shipRef, amount: 10}); ok(r.s === 400, "unknown kind refused");
  r = await SND.call("POST", "/api/admin/payouts", {kind: "shipper", ref: shipRef, amount: 10}); ok(r.s === 403, "only the admin can record payouts");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shipper", ref: shipRef, amount: 100, note: "SAMPLE123"}); ok(r.s === 201, "partial payout recorded");
  M.after = (await ADM.call("GET", "/api/admin/money")).j; ok(M.after.shippers[0].owed === fee - 100 && M.after.shippers[0].paid === 100 && M.after.payouts[0].note === "SAMPLE123", "owed goes down, history shows the payout");
  r = await SH.call("POST", "/api/me/delete", {confirm: "DELETE", password: "correct-horse-9"}); ok(r.s === 409 && /earnings/.test(r.j.error), "a shipper with unpaid earnings cannot delete the account");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shipper", ref: shipRef, amount: fee - 100}); ok(r.s === 201, "rest paid");
  r = await ADM.call("POST", "/api/admin/payouts", {kind: "shop", ref: "s:" + shop.id, amount: 1000}); ok(r.s === 201, "shop paid");
  r = await ADM.call("GET", "/api/admin/money"); ok(r.j.owedShippers === 0 && r.j.owedShops === 0 && r.j.payouts.length === 3, "everything settled");
  r = await OW.call("POST", "/api/me/delete", {confirm: "DELETE", password: "correct-horse-9"}); ok(r.s === 200, "settled owner can delete the account");

  console.log("Payment problems");
  const ins = db.prepare("INSERT INTO payments(delivery_id,uid,phone,amount,status,receipt,result_desc,created,updated) VALUES(?,?,?,?,?,?,?,?,?)");
  ins.run(o2.id, 1, "254712345678", 970, "duplicate", "RCPT1", "OK", Date.now(), Date.now());
  ins.run(o2.id, 1, "254712345678", 500, "mismatch", "RCPT2", "expected 970 got 500", Date.now(), Date.now());
  ins.run(o2.id, 1, "254712345678", 970, "success", "RCPT3", "OK", Date.now(), Date.now());
  r = await ADM.call("GET", "/api/admin/money"); ok(r.j.issues.length === 2 && r.j.issues.every((i) => !i.refunded) && r.j.collected === 970 && r.j.orders === 1, "double payment and wrong amount are listed; only real successes count as collected");
  const iss = r.j.issues.find((i) => i.status === "duplicate");
  r = await ADM.call("POST", "/api/admin/payments/" + iss.id + "/refunded", {note: "reversal ABC"}); ok(r.s === 200, "admin marks it refunded");
  r = await ADM.call("POST", "/api/admin/payments/" + iss.id + "/refunded", {}); ok(r.s === 404, "cannot mark twice");
  r = await ADM.call("POST", "/api/admin/payments/" + db.prepare("SELECT id FROM payments WHERE status='success'").get().id + "/refunded", {}); ok(r.s === 404, "a good payment cannot be marked refunded");
  r = await SND.call("POST", "/api/admin/payments/" + iss.id + "/refunded", {}); ok(r.s === 403, "only the admin can mark refunds");
  r = await ADM.call("GET", "/api/admin/money"); ok(r.j.issues[0].refunded === false && r.j.issues[1].refunded === true && r.j.issues[1].note === "reversal ABC", "open problems list first, refunded ones keep their note");

  console.log("\n" + pass + " passed, " + failN + " failed");
  srv.kill(); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
