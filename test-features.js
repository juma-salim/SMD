"use strict";
/* End-to-end tests: starts a real server on a temp database and exercises auth, privacy and job logic. Run: npm test */
const {DatabaseSync} = require("node:sqlite"), {spawn} = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 3900 + Math.floor(Math.random() * 90), BASE = "http://127.0.0.1:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-")), out = [];
const srv = spawn(process.execPath, ["server.js"], {env: {...process.env, PORT, DB_PATH: path.join(dir, "t.db"), AUTH_RATE_LIMIT: "500", API_RATE_LIMIT: "5000", UPLOAD_RATE_LIMIT: "500", ADMIN_EMAIL: "admin@x.co", NODE_ENV: "test", PUSH_DRY_RUN: "1"}});
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
  const ownSig = (e, extra) => sig(e, Object.assign({role: "owner", name: "Mama Owner", shopName: "Mama Njeri Stores", area: "Diani"}, extra));

  console.log("Shop owners");
  const OW = new Agent();
  r = await register(OW, ownSig("owner1@x.co")); ok(r.s === 200 && r.j.user.role === "owner", "owner signs up and verifies");
  r = await new Agent().call("POST", "/api/auth/signup", ownSig("owner2@x.co", {shopName: "mama njeri stores"})); ok(r.s === 409, "same shop name in the same area is refused");
  r = await new Agent().call("POST", "/api/auth/signup", ownSig("owner3@x.co", {shopName: ""})); ok(r.s === 400, "owner needs a shop name");
  r = await new Agent().call("POST", "/api/auth/signup", ownSig("owner3@x.co", {area: "Nowhere"})); ok(r.s === 400, "owner needs a real area");
  r = await OW.call("GET", "/api/owner/shop"); ok(r.s === 200 && r.j.shop.name === "Mama Njeri Stores" && r.j.shop.approved === false && r.j.shop.items.length === 0, "owner sees their own shop, waiting for approval");
  r = await OW.call("POST", "/api/deliveries", delivery()); ok(r.s === 403, "an owner cannot request deliveries");
  r = await OW.call("GET", "/api/admin/shops"); ok(r.s === 403, "an owner cannot use admin routes");
  const SND = new Agent(); await register(SND, sig("buyer@x.co"));
  r = await SND.call("GET", "/api/owner/shop"); ok(r.s === 403, "a sender cannot open the owner dashboard");
  r = await SND.call("GET", "/api/shops"); ok(!r.j.some((s) => s.name === "Mama Njeri Stores"), "an unapproved shop is hidden from customers");

  r = await OW.call("POST", "/api/owner/items", {name: "Sugar", unit: "1 kg", price: 230}); ok(r.s === 201 && r.j.shop.items.length === 1, "owner adds a good");
  r = await OW.call("POST", "/api/owner/items", {name: "sugar", unit: "1 KG", price: 230}); ok(r.s === 409, "duplicate good is refused");
  r = await OW.call("POST", "/api/owner/items", {name: "Rice", unit: "1 kg", price: 0}); ok(r.s === 400, "a zero price is refused");
  r = await OW.call("POST", "/api/owner/items", {name: "Rice", unit: "1 kg", price: 210}); ok(r.s === 201, "second good");
  const items = r.j.shop.items, sugar = items.find((i) => i.name === "Sugar"), rice = items.find((i) => i.name === "Rice");
  r = await OW.call("PATCH", "/api/owner/items/" + sugar.id, {price: 240}); ok(r.s === 200 && r.j.shop.items.find((i) => i.id === sugar.id).price === 240, "owner changes a price");
  r = await OW.call("PATCH", "/api/owner/items/" + rice.id, {active: false}); ok(r.s === 200 && r.j.shop.items.find((i) => i.id === rice.id).active === false, "owner hides a good");
  const adminShops = (await ADM.call("GET", "/api/admin/shops")).j.shops, mine = adminShops.find((s) => s.name === "Mama Njeri Stores"), other = adminShops.find((s) => s.name !== "Mama Njeri Stores");
  ok(mine && mine.owned && !mine.active && adminShops[0].id === mine.id, "admin sees the owner's shop first, awaiting approval");
  r = await OW.call("PATCH", "/api/owner/items/" + other.items[0].id, {price: 1}); ok(r.s === 404, "an owner cannot edit another shop's goods");
  r = await OW.call("DELETE", "/api/owner/items/" + other.items[0].id); ok(r.s === 404, "an owner cannot delete another shop's goods");
  r = await ADM.call("PATCH", "/api/admin/shops/" + mine.id, {active: true, rec: true}); ok(r.s === 200, "admin approves and recommends the shop");
  r = await SND.call("GET", "/api/shops"); const cs = r.j.find((s) => s.name === "Mama Njeri Stores");
  ok(cs && cs.items.length === 1 && cs.items[0].price === 240, "customers now see the shop with only its visible goods");
  r = await ADM.call("POST", "/api/admin/shops/" + mine.id + "/items", {name: "Milk", unit: "500 ml", price: 70}); ok(r.s === 201, "admin can also add goods to an owner's shop");
  r = await OW.call("GET", "/api/owner/shop"); const milk = r.j.shop.items.find((i) => i.name === "Milk"); ok(!!milk, "owner sees the admin's addition");
  r = await ADM.call("DELETE", "/api/admin/items/" + milk.id); ok(r.s === 200, "admin removes a good");
  r = await OW.call("DELETE", "/api/owner/items/" + rice.id); ok(r.s === 200 && r.j.shop.items.length === 1, "owner removes a good");
  r = await OW.call("PATCH", "/api/owner/shop", {name: "Mama Njeri Mini Mart"}); ok(r.s === 200 && r.j.shop.name === "Mama Njeri Mini Mart", "owner renames the shop");
  r = await SND.call("POST", "/api/deliveries", delivery({from: "Diani", to: "Ukunda", shop: undefined, shopId: cs.id, items: [{id: sugar.id, q: 2}]}));
  ok(r.s === 201 && r.j.goods === 480, "a customer orders goods from the owner's shop at the owner's price");

  console.log("Near you, ratings");
  r = await SND.call("GET", "/api/nearby?area=Mombasa"); ok(r.s === 200 && r.j.shops.length >= 2 && r.j.shops.every((s) => s.name) && Array.isArray(r.j.shippers), "nearby lists recommended shops");
  r = await SND.call("GET", "/api/nearby?area=Nowhere"); ok(r.s === 400, "nearby needs a real area");
  r = await new Agent().call("GET", "/api/nearby?area=Mombasa"); ok(r.s === 401, "nearby needs login");
  const SH = new Agent(), SD = new Agent();
  await approvedShipper(SH, "ratem@x.co", {name: "Juma Salim Hassan", area: "Mombasa", phone: "0733 123 456"});
  await approvedShipper(SD, "ratediani@x.co", {name: "Zawadi K", area: "Diani"});
  r = await SND.call("GET", "/api/nearby?area=Mombasa"); const sj = r.j.shippers.find((x) => x.name === "Juma H.");
  ok(sj && sj.avg === null && sj.done === 0 && !JSON.stringify(r.j).match(/ratem@x|0733 123|Salim/), "available shipper shows a short name, vehicle and no contact details");
  r = await SND.call("GET", "/api/nearby?area=Diani"); ok(r.j.shippers.some((x) => x.name === "Zawadi K.") && !r.j.shippers.some((x) => x.name === "Juma H."), "shippers are listed by base area");
  r = await SND.call("POST", "/api/deliveries", delivery({s: "standard"})); const job = r.j;
  r = await SND.call("POST", "/api/deliveries/" + job.id + "/rate", {stars: 5}); ok(r.s === 409, "cannot rate before the delivery is completed");
  await SH.call("POST", "/api/jobs/" + job.id + "/accept"); await SH.call("POST", "/api/jobs/" + job.id + "/deliver"); r = await SND.call("POST", "/api/deliveries/" + job.id + "/confirm"); ok(r.j.done === true, "delivery completed");
  r = await SND.call("POST", "/api/deliveries/" + job.id + "/rate", {stars: 6}); ok(r.s === 400, "stars must be 1 to 5");
  r = await SND.call("POST", "/api/deliveries/" + job.id + "/rate", {stars: 4}); ok(r.s === 200, "sender rates the shipper");
  r = await SND.call("POST", "/api/deliveries/" + job.id + "/rate", {stars: 5}); ok(r.s === 409, "only one rating per delivery");
  const OTH = new Agent(); await register(OTH, sig("other@x.co")); r = await OTH.call("POST", "/api/deliveries/" + job.id + "/rate", {stars: 1}); ok(r.s === 409, "someone else cannot rate it");
  r = await SND.call("GET", "/api/deliveries"); ok(r.j.find((d) => d.id === job.id).rating === 4, "the sender's history shows the rating");
  r = await SND.call("GET", "/api/nearby?area=Mombasa"); const sj2 = r.j.shippers.find((x) => x.name === "Juma H."); ok(sj2 && sj2.avg === 4 && sj2.count === 1 && sj2.done === 1, "the shipper's rating shows up near you");
  r = await SH.call("GET", "/api/me"); ok(r.j.user.rating.avg === 4 && r.j.user.rating.done === 1, "the shipper sees their own rating");
  r = await SH.call("GET", "/api/jobs/mine"); ok(!JSON.stringify(r.j).includes('"rating"'), "a shipper's job list carries no rating field");

  console.log("Job alerts");
  r = await SH.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/abc123456789", keys: {p256dh: "BPk", auth: "au"}}); ok(r.s === 201, "approved shipper subscribes");
  r = await SH.call("POST", "/api/push/subscribe", {endpoint: "http://push.example.com/abc", keys: {p256dh: "x", auth: "y"}}); ok(r.s === 400, "non-https endpoint refused");
  r = await SH.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/zz123456789"}); ok(r.s === 400, "missing keys refused");
  r = await SND.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/s1234567890", keys: {p256dh: "x", auth: "y"}}); ok(r.s === 403, "a sender cannot subscribe");
  await SD.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/diani1234567", keys: {p256dh: "x", auth: "y"}});
  const logOf = () => out.join("");
  const before = (logOf().match(/\[push\]/g) || []).length;
  r = await SND.call("POST", "/api/deliveries", delivery()); await sleep(400);
  const lines = logOf().split("\n").filter((l) => l.includes("[push]")).slice(before);
  const mShip = (await SH.call("GET", "/api/me")).j.user, dbq = new DatabaseSync(path.join(dir, "t.db")); const uid = (e) => dbq.prepare("SELECT id FROM users WHERE email=?").get(e).id;
  ok(lines.length === 1 && lines[0].includes("user " + uid("ratem@x.co")), "a new Mombasa job alerts only the shipper based near Mombasa (not Diani)");
  const lastJob = r.j.id;
  const n2 = (logOf().match(/\[push\]/g) || []).length; await SH.call("POST", "/api/push/unsubscribe", {endpoint: "https://push.example.com/abc123456789"});
  await SND.call("POST", "/api/deliveries", delivery()); await sleep(300); ok((logOf().match(/\[push\]/g) || []).length === n2, "after turning alerts off nothing is sent");
  await SH.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/abc123456789", keys: {p256dh: "BPk", auth: "au"}});
  await SH.call("POST", "/api/auth/logout"); const n3 = (logOf().match(/\[push\]/g) || []).length;
  await SND.call("POST", "/api/deliveries", delivery()); await sleep(300); ok((logOf().match(/\[push\]/g) || []).length === n3, "a logged-out shipper is not alerted");
  const dd = await SD.call("POST", "/api/push/subscribe", {endpoint: "https://push.example.com/diani1234567", keys: {p256dh: "x", auth: "y"}});
  const n4 = (logOf().match(/\[push\]/g) || []).length;
  await SND.call("POST", "/api/deliveries", delivery({from: "Diani", to: "Ukunda"})); await sleep(300);
  ok((logOf().match(/\[push\]/g) || []).length === n4 + 1, "a Diani pickup alerts the Diani shipper");
  r = await SND.call("GET", "/api/config"); ok(r.j.push === false, "config reports push off until VAPID keys are set");
  const gotAll = dbq.prepare("SELECT COUNT(*) c FROM deliveries WHERE notified=0 AND step=0").get().c; ok(gotAll === 0, "every visible job is marked announced exactly once");

  console.log("Owner account deletion");
  r = await OW.call("POST", "/api/me/delete", {confirm: "DELETE", password: "correct-horse-9"}); ok(r.s === 200, "owner deletes the account");
  ok(dbq.prepare("SELECT COUNT(*) c FROM catalog_shops WHERE owner_uid IS NOT NULL").get().c === 0 && dbq.prepare("SELECT COUNT(*) c FROM catalog_items WHERE name='Sugar' AND price=240").get().c === 0, "the owner's shop and goods are removed");
  r = await SND.call("GET", "/api/deliveries"); ok(r.j.some((d) => d.goods === 480), "customers keep their past order records");

  console.log("\n" + pass + " passed, " + failN + " failed");
  srv.kill(); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
