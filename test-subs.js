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
  r = await register(ADM, sig("admin@x.co", {name: "Admin Person"})); ok(r.s === 200 && r.j.user.role === "admin", "main admin ready");
  const pend = async (a, email, area, name) => { await register(a, shipSig(email, {area, name: name || "Pending Shipper"})); for (const k of ["front", "back", "selfie"]) await putDoc(a, k, JPEG()); await submitFromMe(a); return (await pendingId(email)).id; };

  console.log("New areas");
  const cfg = (await new Agent().call("GET", "/api/config")).j;
  ok(cfg.AREAS.Mtwapa && cfg.AREAS.Mariakani && Object.keys(cfg.AREAS).length === 8, "Mtwapa and Mariakani are service areas");
  const C = require("./config");
  ok(C.quote("Mombasa", "Mtwapa", 0, "standard").ferry === 0 && C.quote("Mariakani", "Mtwapa", 0, "standard").ferry === 0 && C.quote("Mtwapa", "Diani", 0, "standard").ferry === 50 && C.quote("Mombasa", "Likoni", 0, "standard").ferry === 50 && C.quote("Likoni", "Diani", 0, "standard").ferry === 0, "the ferry only applies when crossing the Likoni channel");
  const SND = new Agent(); await register(SND, sig("buyer@x.co"));
  r = await SND.call("POST", "/api/deliveries", delivery({from: "Mtwapa", to: "Mombasa"})); ok(r.s === 201 && r.j.price === C.quote("Mtwapa", "Mombasa", 0, "standard").total, "an order from Mtwapa is priced with the new area");
  r = await SND.call("POST", "/api/deliveries", delivery({from: "Mariakani", to: "Diani", w: 1})); ok(r.s === 201 && r.j.price === C.quote("Mariakani", "Diani", 1, "standard").total, "Mariakani to Diani works, ferry included");

  console.log("Sub-admins");
  const SUB = new Agent(); await register(SUB, sig("sub@x.co", {name: "Sub Person"}));
  const SHX = new Agent(); await register(SHX, shipSig("shipx@x.co"));
  const OWX = new Agent(); await register(OWX, sig("ownx@x.co", {role: "owner", shopName: "Ox Shop", area: "Mtwapa"}));
  r = await SND.call("GET", "/api/admin/subs"); ok(r.s === 403, "a sender cannot see sub-admins");
  r = await ADM.call("POST", "/api/admin/subs", {email: "nobody@x.co", areas: ["Mtwapa"]}); ok(r.s === 404, "the person must have an account");
  r = await ADM.call("POST", "/api/admin/subs", {email: "shipx@x.co", areas: ["Mtwapa"]}); ok(r.s === 409, "a shipper cannot become a sub-admin");
  r = await ADM.call("POST", "/api/admin/subs", {email: "ownx@x.co", areas: ["Mtwapa"]}); ok(r.s === 409, "a shop owner cannot become a sub-admin");
  r = await ADM.call("POST", "/api/admin/subs", {email: "admin@x.co", areas: ["Mtwapa"]}); ok(r.s === 409, "the main admin cannot be a sub-admin");
  r = await ADM.call("POST", "/api/admin/subs", {email: "sub@x.co", areas: []}); ok(r.s === 400, "at least one area is needed");
  r = await ADM.call("POST", "/api/admin/subs", {email: "sub@x.co", areas: ["Atlantis"]}); ok(r.s === 400, "areas must be real");
  r = await ADM.call("POST", "/api/admin/subs", {email: "sub@x.co", areas: ["Mtwapa", "Mariakani"]}); ok(r.s === 201 && r.j.subs.length === 1 && r.j.subs[0].areas.join() === "Mariakani,Mtwapa", "main admin adds a sub-admin for Mtwapa and Mariakani");
  r = await ADM.call("POST", "/api/admin/subs", {email: "sub@x.co", areas: ["Mtwapa"]}); ok(r.s === 409, "cannot add the same person twice");
  r = await SUB.call("GET", "/api/me"); ok(r.j.user.role === "subadmin" && r.j.user.areas.join() === "Mariakani,Mtwapa", "the sub-admin's account now shows the role and areas");
  r = await SUB.call("POST", "/api/deliveries", delivery()); ok(r.s === 403, "a sub-admin does not order deliveries");
  for (const u of ["/api/admin/subs", "/api/admin/shops", "/api/admin/fees", "/api/admin/money"]) { r = await SUB.call("GET", u); ok(r.s === 403, "a sub-admin cannot open " + u); }
  r = await SUB.call("POST", "/api/admin/subs", {email: "buyer@x.co", areas: ["Mtwapa"]}); ok(r.s === 403, "a sub-admin cannot add other sub-admins");

  console.log("Area-limited review");
  const ids = {};
  ids.mt = await pend(new Agent(), "s-mtwapa@x.co", "Mtwapa", "Mtwapa Shipper"); ids.ma = await pend(new Agent(), "s-mariakani@x.co", "Mariakani", "Mariakani Shipper"); ids.mo = await pend(new Agent(), "s-mombasa@x.co", "Mombasa", "Mombasa Shipper"); ids.di = await pend(new Agent(), "s-diani@x.co", "Diani", "Diani Shipper");
  r = await SUB.call("GET", "/api/admin/shippers?status=pending"); const names = r.j.shippers.map((x) => x.area).sort().join();
  ok(r.s === 200 && names === "Mariakani,Mtwapa" && r.j.counts.pending === 2, "the sub-admin sees only shippers based in their areas");
  r = await ADM.call("GET", "/api/admin/shippers?status=pending"); ok(r.j.shippers.length === 4, "the main admin sees every shipper");
  r = await SUB.call("GET", "/api/admin/shippers/" + ids.mt + "/docs/front"); ok(r.s === 200, "the sub-admin can view ID photos in their area");
  r = await SUB.call("GET", "/api/admin/shippers/" + ids.mo + "/docs/front"); ok(r.s === 404, "but not ID photos from another area");
  r = await SUB.call("POST", "/api/admin/shippers/" + ids.mo + "/approve"); ok(r.s === 404, "cannot approve a shipper in another area");
  r = await SUB.call("POST", "/api/admin/shippers/" + ids.di + "/reject", {reason: "nope nope"}); ok(r.s === 404, "cannot reject a shipper in another area");
  r = await SUB.call("POST", "/api/admin/shippers/" + ids.mt + "/approve"); ok(r.s === 200, "approves a Mtwapa shipper");
  r = await SUB.call("POST", "/api/admin/shippers/" + ids.ma + "/reject", {reason: "photo is blurry"}); ok(r.s === 200, "rejects a Mariakani shipper with a reason");
  r = await ADM.call("POST", "/api/admin/shippers/" + ids.mo + "/approve"); ok(r.s === 200, "the main admin still approves anywhere");
  ok(/email to sub@x\.co: New shipper awaiting approval/.test(out.join("")), "the area's sub-admin is emailed when a shipper in their area applies");
  ok(!/email to sub@x\.co: New shipper awaiting approval[^]*s-mombasa/.test("") && (out.join("").match(/email to sub@x\.co: New shipper awaiting approval/g) || []).length === 2, "and only for their own areas (2 of 4 applications)");
  const SM = new Agent(); r = await SM.call("POST", "/api/auth/login", {email: "s-mtwapa@x.co", password: "correct-horse-9"}); r = await SM.call("GET", "/api/jobs"); ok(r.s === 200, "the shipper the sub-admin approved can see jobs");

  console.log("Owner shops by area");
  const OWD = new Agent(); await register(OWD, sig("owd@x.co", {role: "owner", shopName: "Diani Shop", area: "Diani"}));
  r = await SUB.call("GET", "/api/review/shops"); ok(r.j.shops.length === 1 && r.j.shops[0].name === "Ox Shop", "the sub-admin sees only shops waiting in their areas");
  r = await ADM.call("GET", "/api/review/shops"); ok(r.j.shops.length === 2, "the main admin sees all waiting shops");
  const dShop = r.j.shops.find((s) => s.name === "Diani Shop"), mShop = r.j.shops.find((s) => s.name === "Ox Shop");
  r = await SUB.call("POST", "/api/review/shops/" + dShop.id + "/approve"); ok(r.s === 404, "cannot approve a shop in another area");
  r = await SUB.call("POST", "/api/review/shops/" + mShop.id + "/approve"); ok(r.s === 200, "approves a shop in their area");
  r = await SND.call("GET", "/api/shops"); ok(r.j.some((s) => s.name === "Ox Shop") && !r.j.some((s) => s.name === "Diani Shop"), "the approved shop is now visible to customers, the other still hidden");
  r = await SUB.call("POST", "/api/review/shops/" + mShop.id + "/approve"); ok(r.s === 404, "a shop cannot be approved twice");

  console.log("Changing and removing");
  const subId = (await ADM.call("GET", "/api/admin/subs")).j.subs[0].id;
  r = await ADM.call("PUT", "/api/admin/subs/" + subId, {areas: ["Mombasa"]}); ok(r.s === 200 && r.j.subs[0].areas.join() === "Mombasa", "areas can be changed");
  r = await SUB.call("GET", "/api/admin/shippers?status=approved"); ok(r.j.shippers.length === 1 && r.j.shippers[0].area === "Mombasa", "the new scope applies at once");
  r = await ADM.call("DELETE", "/api/admin/subs/" + subId); ok(r.s === 200 && r.j.subs.length === 0, "a sub-admin can be removed");
  r = await SUB.call("GET", "/api/admin/shippers"); ok(r.s === 403, "a removed sub-admin loses access immediately");
  r = await SUB.call("GET", "/api/me"); ok(r.j.user.role === "sender", "and is a normal sender again");
  r = await ADM.call("DELETE", "/api/admin/subs/" + subId); ok(r.s === 404, "removing twice is refused");
  r = await ADM.call("POST", "/api/admin/subs", {email: "sub@x.co", areas: ["Tiwi"]}); ok(r.s === 201, "and can be added again");
  r = await SUB.call("POST", "/api/me/delete", {confirm: "DELETE", password: "correct-horse-9"}); ok(r.s === 200, "a sub-admin can delete their own account");
  const dbq = new DatabaseSync(path.join(dir, "t.db")); ok(dbq.prepare("SELECT COUNT(*) c FROM sub_areas").get().c === 0, "their area rows are removed with it");

  console.log("\n" + pass + " passed, " + failN + " failed");
  srv.kill(); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
