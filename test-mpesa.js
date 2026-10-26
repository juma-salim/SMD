"use strict";
/* End-to-end test of the M-Pesa STK Push checkout against a MOCK Daraja server (no Safaricom account or internet needed).
   Run: node test-mpesa.js */
const http = require("node:http"), {spawn} = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {DatabaseSync} = require("node:sqlite");
const SECRET = "test-callback-secret-0123456789abcdef", PASSKEY = "test-passkey", SHORTCODE = "174379";
const PORT = 4000 + Math.floor(Math.random() * 900), MOCK = PORT + 1000, BASE = "http://127.0.0.1:" + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-mp-")), DB = path.join(dir, "t.db"), out = [];
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓ " + name); } else { failN++; console.log("  ✗ FAIL: " + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- mock Daraja ---- */
const seen = {token: 0, push: [], query: []}; let queryAnswer = {pending: true}, nextReject = false, seq = 0;
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const send = (s, j) => { res.writeHead(s, {"content-type": "application/json"}); res.end(JSON.stringify(j)); };
    if (req.url.startsWith("/oauth/v1/generate")) { seen.token++; const a = req.headers.authorization || ""; return a.startsWith("Basic ") ? send(200, {access_token: "tok-" + seen.token, expires_in: "3599"}) : send(400, {}); }
    if (req.headers.authorization !== "Bearer tok-" + seen.token) return send(401, {errorMessage: "Invalid Access Token"});
    const j = JSON.parse(b || "{}");
    if (req.url === "/mpesa/stkpush/v1/processrequest") {
      seen.push.push(j);
      if (nextReject) { nextReject = false; return send(400, {errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber"}); }
      seq++; return send(200, {MerchantRequestID: "mr-" + seq, CheckoutRequestID: "ws_CO_" + seq, ResponseCode: "0", ResponseDescription: "Success", CustomerMessage: "Success"});
    }
    if (req.url === "/mpesa/stkpushquery/v1/query") {
      seen.query.push(j);
      return queryAnswer.pending ? send(500, {errorCode: "500.001.1001", errorMessage: "The transaction is being processed"}) : send(200, {ResponseCode: "0", ResultCode: String(queryAnswer.code), ResultDesc: queryAnswer.desc, CheckoutRequestID: j.CheckoutRequestID});
    }
    send(404, {});
  });
});

/* ---- helpers ---- */
class Agent {
  constructor() { this.cookie = ""; }
  async call(method, url, body) {
    const h = {}; if (this.cookie) h.cookie = this.cookie; if (method !== "GET") h["content-type"] = "application/json";
    const r = await fetch(BASE + url, {method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {})});
    const sc = r.headers.getSetCookie(); if (sc.length) { const c = sc[0].split(";")[0]; this.cookie = c.endsWith("=") ? "" : c; }
    let j = {}; try { j = await r.json(); } catch (e) {} return {s: r.status, j};
  }
}
const codeFor = async (email) => { await sleep(150); const all = [...out.join("").matchAll(new RegExp("verification code for " + email.replace(/\./g, "\\.") + ": ([0-9]+)", "g"))]; return all.length ? all[all.length - 1][1] : null; };
async function register(extra) {
  const a = new Agent(), email = extra.email, s = await a.call("POST", "/api/auth/signup", Object.assign({name: "Test User", phone: "0712 345 678", password: "correct-horse-9", role: "sender", consent: true, idConsent: true}, extra));
  if (s.s !== 201) throw new Error("signup failed " + JSON.stringify(s.j));
  const v = await a.call("POST", "/api/auth/verify", {email, code: await codeFor(email)}); if (v.s !== 200) throw new Error("verify failed");
  return a;
}
const order = (o = {}) => Object.assign({from: "Mombasa", to: "Diani", shop: "Corner Shop", drop: "Sea Lodge Road", rn: "Recipient", rp: "0722 111 222", it: "Groceries", w: 0, s: "standard", land: "", pay: "mpesa"}, o);
const cbBody = (checkoutId, code, o = {}) => ({Body: {stkCallback: Object.assign({MerchantRequestID: "x", CheckoutRequestID: checkoutId, ResultCode: code, ResultDesc: code === 0 ? "The service request is processed successfully." : "failed"},
  code === 0 ? {CallbackMetadata: {Item: [{Name: "Amount", Value: o.amount}, {Name: "MpesaReceiptNumber", Value: o.receipt || "TEST123ABC"}, {Name: "TransactionDate", Value: 20261017130000}, {Name: "PhoneNumber", Value: 254712345678}]}} : {})}});
const hook = (body, secret = SECRET) => fetch(BASE + "/hooks/pay/" + secret, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});

(async () => {
  await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));
  const srv = spawn(process.execPath, ["server.js"], {env: {...process.env, PORT, DB_PATH: DB, AUTH_RATE_LIMIT: "500", API_RATE_LIMIT: "5000", ADMIN_EMAIL: "admin@x.co", NODE_ENV: "test",
    MPESA_BASE_URL: "http://127.0.0.1:" + MOCK, MPESA_CONSUMER_KEY: "key", MPESA_CONSUMER_SECRET: "sec", MPESA_SHORTCODE: SHORTCODE, MPESA_PASSKEY: PASSKEY,
    MPESA_CALLBACK_BASE: "https://smd.example.com", MPESA_CALLBACK_SECRET: SECRET, PAY_QUERY_AFTER_MS: "300", PAY_QUERY_EVERY_MS: "300", PAY_TIMEOUT_MS: "2500", PAY_RATE_LIMIT: "500"}});
  srv.stdout.on("data", (d) => out.push(String(d))); srv.stderr.on("data", (d) => out.push(String(d)));
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/config"); break; } catch (e) { await sleep(100); } }
    const cfg = await (await fetch(BASE + "/api/config")).json(); ok(cfg.mpesa === true, "config advertises M-Pesa when Daraja is configured");

    const sender = await register({email: "s1@x.co"});
    const shipper = await register({email: "sh1@x.co", role: "shipper", veh: "Motorbike", area: "Mombasa", idType: "National ID", idNumber: "12345678", dob: "1990-01-01", address: "1 Test Street Mombasa"});
    const db = new DatabaseSync(DB); db.exec("UPDATE users SET status='approved' WHERE email='sh1@x.co'");
    const board = async () => (await shipper.call("GET", "/api/jobs?area=all")).j.map((d) => d.id);

    console.log("Checkout: create + pay");
    ok((await sender.call("POST", "/api/deliveries", order({pay: "cod"}))).s === 400, "with M-Pesa configured, cash on delivery is no longer offered");
    ok((await sender.call("POST", "/api/deliveries", order({pay: undefined}))).s === 400, "a request that does not say how to pay is refused");
    const o1 = await sender.call("POST", "/api/deliveries", order());
    ok(o1.s === 201 && o1.j.payState === "awaiting" && o1.j.pay === "mpesa", "M-Pesa order is created as 'awaiting'");
    ok(!(await board()).includes(o1.j.id), "unpaid M-Pesa order is hidden from the job board");
    ok((await shipper.call("POST", "/api/jobs/" + o1.j.id + "/accept")).s === 409, "shipper cannot accept an unpaid M-Pesa order even by ID");
    const total = o1.j.price + o1.j.goods;

    ok((await sender.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {phone: "12345"})).s === 400, "invalid phone number is rejected before calling Safaricom");
    ok((await shipper.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {})).s === 403, "only senders can pay");
    const other = await register({email: "s2@x.co"});
    ok((await other.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {})).s === 404, "another sender cannot pay (or probe) someone else's order");

    nextReject = true;
    const rej = await sender.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {phone: "0712345678"});
    ok(rej.s === 502 && !/400\.002/.test(JSON.stringify(rej.j)), "Daraja rejection returns a clean error without leaking internals");
    const p1 = await sender.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {phone: "+254 712 345 678"});
    ok(p1.s === 202 && p1.j.amount === total, "STK Push accepted; amount comes from the server (" + total + ")");
    const push = seen.push[seen.push.length - 1];
    ok(push.Amount === total && push.PartyA === "254712345678" && push.PhoneNumber === "254712345678" && push.PartyB === SHORTCODE && push.BusinessShortCode === SHORTCODE, "push body: amount, MSISDN 2547…, shortcode");
    ok(push.Password === Buffer.from(SHORTCODE + PASSKEY + push.Timestamp).toString("base64") && /^\d{14}$/.test(push.Timestamp), "password = base64(shortcode+passkey+timestamp), timestamp is 14 digits");
    ok(push.CallBackURL === "https://smd.example.com/hooks/pay/" + SECRET && !/mpesa|safaricom/i.test(push.CallBackURL), "callback URL is HTTPS and avoids forbidden keywords");
    ok(push.TransactionType === "CustomerPayBillOnline" && push.AccountReference === o1.j.id, "transaction type and account reference (order id)");
    ok(seen.token === 1, "OAuth token fetched once and cached");

    const dup = await sender.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {});
    ok(dup.s === 409 && /already open/.test(dup.j.error), "second prompt while one is open is refused (no double charge)");
    ok((await sender.call("DELETE", "/api/deliveries/" + o1.j.id)).s === 409, "cannot cancel while a payment is in flight");
    ok((await sender.call("GET", "/api/deliveries/" + o1.j.id + "/payment")).j.state === "pending", "status poll reports 'pending'");

    console.log("Callback security + success");
    ok((await hook(cbBody("ws_CO_" + seq, 0, {amount: total}), "wrong-secret")).status === 404, "callback with wrong secret is rejected (404)");
    ok((await sender.call("GET", "/api/deliveries/" + o1.j.id + "/payment")).j.state === "pending", "…and changed nothing");
    const bad = await hook({junk: true}); ok(bad.status === 200, "malformed callback is acknowledged without crashing");
    const cid1 = "ws_CO_" + seq;
    const c1 = await hook(cbBody(cid1, 0, {amount: total, receipt: "RCP1TEST01"}));
    ok(c1.status === 200 && (await c1.json()).ResultCode === 0, "valid callback acknowledged with ResultCode 0");
    const st1 = (await sender.call("GET", "/api/deliveries/" + o1.j.id + "/payment")).j;
    ok(st1.state === "success" && st1.receipt === "RCP1TEST01", "order marked paid with the M-Pesa receipt");
    ok((await board()).includes(o1.j.id), "paid order now appears on the job board");
    const mine = (await sender.call("GET", "/api/deliveries")).j.find((d) => d.id === o1.j.id);
    ok(mine.payState === "paid" && mine.receipt === "RCP1TEST01", "sender sees paid state + receipt");
    ok(!("receipt" in (await shipper.call("GET", "/api/jobs?area=all")).j.find((d) => d.id === o1.j.id)), "job board does not expose payment details");
    await hook(cbBody(cid1, 0, {amount: total, receipt: "RCP1TEST01"}));
    ok(db.prepare("SELECT COUNT(*) c FROM payments WHERE delivery_id=? AND status='success'").get(o1.j.id).c === 1, "duplicate callback is idempotent");
    await hook(cbBody(cid1, 1032));
    ok((await sender.call("GET", "/api/deliveries/" + o1.j.id + "/payment")).j.state === "success", "a late 'failed' callback cannot undo a success");
    ok((await sender.call("DELETE", "/api/deliveries/" + o1.j.id)).s === 409, "paid order cannot be cancelled by the app (needs a refund)");
    ok((await shipper.call("POST", "/api/jobs/" + o1.j.id + "/accept")).s === 200, "shipper can accept the paid order");
    const mj = (await shipper.call("GET", "/api/jobs/mine")).j.find((d) => d.id === o1.j.id);
    ok(mj.payState === "paid", "shipper's job shows it is already paid (no cash to collect)");
    ok((await sender.call("POST", "/api/deliveries/" + o1.j.id + "/pay", {})).s === 409, "an already-paid order cannot be paid again");

    console.log("Failure, retry, switch to cash");
    const o2 = (await sender.call("POST", "/api/deliveries", order())).j;
    await sender.call("POST", "/api/deliveries/" + o2.id + "/pay", {phone: "0712345678"});
    await hook(cbBody("ws_CO_" + seq, 1032));
    const st2 = (await sender.call("GET", "/api/deliveries/" + o2.id + "/payment")).j;
    ok(st2.state === "cancelled" && /cancelled/i.test(st2.message), "customer cancelled the prompt: state + friendly message");
    ok(!(await board()).includes(o2.id), "…and the order stays off the job board");
    await sender.call("POST", "/api/deliveries/" + o2.id + "/pay", {phone: "0712345678"});
    await hook(cbBody("ws_CO_" + seq, 2001));
    ok(/PIN/i.test((await sender.call("GET", "/api/deliveries/" + o2.id + "/payment")).j.message), "wrong PIN (2001) explained to the customer");
    await sender.call("POST", "/api/deliveries/" + o2.id + "/pay", {phone: "0712345678"});
    const sw1 = await sender.call("POST", "/api/deliveries/" + o2.id + "/later");
    ok(sw1.s === 409, "cannot switch to pay-after-delivery for an order with no listed goods");
    await hook(cbBody("ws_CO_" + seq, 1));
    ok((await sender.call("POST", "/api/deliveries/" + o2.id + "/later")).s === 409 && !(await board()).includes(o2.id), "…and it stays off the job board until paid");

    console.log("Lost callback + wrong amount + timeout");
    const o3 = (await sender.call("POST", "/api/deliveries", order())).j;
    await sender.call("POST", "/api/deliveries/" + o3.id + "/pay", {phone: "0712345678"});
    queryAnswer = {pending: true}; await sleep(400);
    ok((await sender.call("GET", "/api/deliveries/" + o3.id + "/payment")).j.state === "pending", "query says 'still processing' (Daraja 500.001.1001): stays pending");
    queryAnswer = {pending: false, code: 0, desc: "The service request is processed successfully."}; await sleep(400);
    const lost = (await sender.call("GET", "/api/deliveries/" + o3.id + "/payment")).j;
    ok(lost.state === "success" && seen.query.length >= 2, "callback never arrived: status poll asks Safaricom (STK Query) and settles the order");

    const o4 = (await sender.call("POST", "/api/deliveries", order())).j;
    await sender.call("POST", "/api/deliveries/" + o4.id + "/pay", {phone: "0712345678"});
    await hook(cbBody("ws_CO_" + seq, 0, {amount: o4.price - 10, receipt: "WRONGAMT01"}));
    ok((await sender.call("GET", "/api/deliveries/" + o4.id + "/payment")).j.state === "mismatch" && !(await board()).includes(o4.id), "wrong amount in callback is NOT treated as paid (flagged for review)");

    const o5 = (await sender.call("POST", "/api/deliveries", order())).j;
    queryAnswer = {pending: true};
    await sender.call("POST", "/api/deliveries/" + o5.id + "/pay", {phone: "0712345678"});
    await sleep(2800);
    ok((await sender.call("GET", "/api/deliveries/" + o5.id + "/payment")).j.state === "timeout", "no result after the timeout window: attempt closed so the customer can retry");
    ok((await sender.call("POST", "/api/deliveries/" + o5.id + "/pay", {phone: "0712345678"})).s === 202, "retry after timeout works");
    await hook(cbBody("ws_CO_" + (seq - 1), 0, {amount: o5.price, receipt: "LATEOK0001"}));
    ok(["success", "duplicate"].includes((await sender.call("GET", "/api/deliveries/" + o5.id + "/payment")).j.state), "a SUCCESS callback for the timed-out attempt is still honoured (money moved)");

    console.log("Concurrency + validation");
    const o6 = (await sender.call("POST", "/api/deliveries", order())).j;
    const race = await Promise.all([1, 2, 3].map(() => sender.call("POST", "/api/deliveries/" + o6.id + "/pay", {phone: "0712345678"})));
    ok(race.filter((r) => r.s === 202).length === 1, "three simultaneous pay taps send exactly one STK Push");
    ok((await sender.call("POST", "/api/deliveries", order({pay: "bitcoin"}))).s === 400, "unknown pay method is refused");

    console.log("Pay after delivery (listed shops, goods above the limit)");
    const cat = (await sender.call("GET", "/api/shops")).j, shop = cat.find((s) => s.area === "Mombasa" && /Supermarket/.test(s.name)), sugar = shop.items.find((i) => /Sugar/.test(i.name)), rice = shop.items.find((i) => /Rice/.test(i.name));
    const big = (o = {}) => order(Object.assign({shop: undefined, shopId: shop.id, items: [{id: sugar.id, q: 5}], it: "", pay: "later"}, o)); /* 5 x 220 = 1100 */
    ok((await sender.call("POST", "/api/deliveries", big({items: [{id: rice.id, q: 4}]}))).s === 400, "goods of 800 (not above 999): pay after delivery refused");
    ok((await sender.call("POST", "/api/deliveries", order({pay: "later"}))).s === 400, "typed shop / no listed goods: pay after delivery refused");
    ok((await sender.call("POST", "/api/deliveries", big({items: [{id: rice.id, q: 5}]}))).s === 201, "goods of 1000: allowed");
    const L = await sender.call("POST", "/api/deliveries", big());
    ok(L.s === 201 && L.j.payState === "later" && L.j.pay === "later" && (await board()).includes(L.j.id), "pay-after-delivery order goes straight to the job board, unpaid");
    ok((await sender.call("POST", "/api/deliveries/" + L.j.id + "/pay", {phone: "0712345678"})).s === 409, "cannot pay before confirming receipt");
    const pushes0 = seen.push.length;
    ok((await shipper.call("POST", "/api/jobs/" + L.j.id + "/accept")).s === 200, "shipper accepts it");
    const lm = (await shipper.call("GET", "/api/jobs/mine")).j.find((d) => d.id === L.j.id);
    ok(lm.payState === "later", "shipper sees it is pay-after-delivery (nothing to collect)");
    ok((await shipper.call("POST", "/api/jobs/" + L.j.id + "/deliver")).j.done === false, "shipper signs off: not complete");
    const cf1 = await sender.call("POST", "/api/deliveries/" + L.j.id + "/confirm");
    ok(cf1.s === 200 && cf1.j.needPay === true && cf1.j.done === false, "sender confirms receipt: now owes the payment, still not complete");
    ok((await sender.call("GET", "/api/deliveries")).j.find((d) => d.id === L.j.id).step === 1, "stays In Progress until paid");
    ok(seen.push.length === pushes0, "no money requested before the sender confirmed");
    const lp = await sender.call("POST", "/api/deliveries/" + L.j.id + "/pay", {phone: "0712345678"});
    ok(lp.s === 202 && lp.j.amount === L.j.price + 1100, "payment requested for delivery + goods (server-computed)");
    await hook(cbBody("ws_CO_" + seq, 1032));
    ok((await sender.call("GET", "/api/deliveries/" + L.j.id + "/payment")).j.state === "cancelled" && (await sender.call("GET", "/api/deliveries")).j.find((d) => d.id === L.j.id).step === 1, "cancelled prompt: order stays open for a retry");
    ok((await sender.call("POST", "/api/deliveries/" + L.j.id + "/pay", {phone: "0712345678"})).s === 202, "customer can retry");
    await hook(cbBody("ws_CO_" + seq, 0, {amount: L.j.price + 1100, receipt: "LATER00001"}));
    const done = (await sender.call("GET", "/api/deliveries")).j.find((d) => d.id === L.j.id);
    ok(done.step === 2 && done.payState === "paid" && done.receipt === "LATER00001", "payment received: order Completed with receipt");

    console.log("Pay after delivery: sender confirms first");
    const L2 = (await sender.call("POST", "/api/deliveries", big())).j; await shipper.call("POST", "/api/jobs/" + L2.id + "/accept");
    ok((await sender.call("POST", "/api/deliveries/" + L2.id + "/confirm")).j.needPay === true, "sender confirms before the shipper signs");
    await sender.call("POST", "/api/deliveries/" + L2.id + "/pay", {phone: "0712345678"}); await hook(cbBody("ws_CO_" + seq, 0, {amount: L2.price + 1100, receipt: "LATER00002"}));
    ok((await sender.call("GET", "/api/deliveries")).j.find((d) => d.id === L2.id).step === 1, "paid but the shipper has not signed off: still In Progress");
    ok((await shipper.call("POST", "/api/jobs/" + L2.id + "/deliver")).j.done === true, "shipper signs last: Completed");
    const L3 = (await sender.call("POST", "/api/deliveries", big())).j;
    ok((await sender.call("DELETE", "/api/deliveries/" + L3.id)).s === 200, "an unaccepted pay-after-delivery request can still be cancelled");
    const L4 = (await sender.call("POST", "/api/deliveries", big({pay: "mpesa"}))).j;
    ok(L4.laterOk === true && (await sender.call("POST", "/api/deliveries/" + L4.id + "/later")).j.payState === "later", "a pay-now order with big listed goods can be switched to pay-after-delivery");

    console.log("Admin delivery fees");
    const admin = await register({email: "admin@x.co", role: "sender"});
    const base = async () => (await sender.call("POST", "/api/deliveries", order({from: "Mombasa", to: "Likoni"}))).j.price;
    const before = await base();
    ok((await sender.call("GET", "/api/admin/fees")).s === 403 && (await sender.call("PUT", "/api/admin/fees", {a: "Mombasa", b: "Likoni", fee: 500})).s === 403, "only the admin can see or change fees");
    const fl = (await admin.call("GET", "/api/admin/fees")).j.fees;
    ok(fl.length === 36 && fl.every((f) => f.fee === null && f.auto > 0), "admin sees every pair (8 places: 28 routes + 8 local), all automatic at first");
    ok((await admin.call("PUT", "/api/admin/fees", {a: "Likoni", b: "Mombasa", fee: 400})).s === 200, "admin sets Likoni-Mombasa (either direction)");
    ok(((await sender.call("GET", "/api/config")).j.FEES || {})["Likoni|Mombasa"] === 400, "customers' config carries the new fee");
    ok(await base() === 400, "a new order on that route is charged the admin's fee");
    ok((await admin.call("PUT", "/api/admin/fees", {a: "Mombasa", b: "Atlantis", fee: 400})).s === 400 && (await admin.call("PUT", "/api/admin/fees", {a: "Mombasa", b: "Likoni", fee: 5})).s === 400 && (await admin.call("PUT", "/api/admin/fees", {a: "Mombasa", b: "Likoni", fee: 12.5})).s === 400, "unknown places and silly fees are refused");
    ok((await admin.call("DELETE", "/api/admin/fees", {a: "Mombasa", b: "Likoni"})).s === 200 && await base() === before, "reset goes back to the automatic fee");
    ok(!/key|sec|tok-|passkey/i.test(JSON.stringify((await sender.call("GET", "/api/config")).j).replace(/mpesa/g, "")), "no credentials in /api/config");
    ok(!out.join("").includes(PASSKEY) && !out.join("").includes("tok-"), "server logs contain no passkey or access tokens");
  } catch (e) { failN++; console.log("  ✗ ERROR: " + (e && e.stack || e)); }
  srv.kill(); mock.close(); try { fs.rmSync(dir, {recursive: true, force: true}); } catch (e) {}
  console.log("\n" + pass + " passed, " + failN + " failed"); process.exit(failN ? 1 : 0);
})();
