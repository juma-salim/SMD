"use strict";
/* Tests for the SMD assistant. A fake model API runs inside this test; the real server talks to it over HTTP. Run: node test-chat.js */
const {DatabaseSync} = require("node:sqlite"), {spawn} = require("node:child_process"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const C = require("./config");
const rnd = () => 3900 + Math.floor(Math.random() * 900);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smd-chat-")), out = [], procs = [];
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓ " + name); } else { failN++; console.log("  ✗ FAIL: " + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- fake model API ---- */
const seen = []; let fakeCalls = 0;
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const body = JSON.parse(b); fakeCalls++; seen.push({key: req.headers["x-api-key"], ver: req.headers["anthropic-version"], body});
    const send = (o, code = 200) => { res.writeHead(code, {"content-type": "application/json"}); res.end(JSON.stringify(o)); };
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content)) { /* round two: echo what the server fed back from the tool */
      if (body.messages.some((m) => typeof m.content === "string" && m.content.includes("LOOP"))) return send({stop_reason: "tool_use", content: [{type: "tool_use", id: "t" + fakeCalls, name: "get_fee_quote", input: {from: "Mombasa", to: "Diani"}}]});
      return send({stop_reason: "end_turn", content: [{type: "text", text: "TOOLRESULT:" + last.content.map((c) => c.content).join("|")}]});
    }
    const t = last.content, tool = (name, input) => send({stop_reason: "tool_use", content: [{type: "text", text: "checking"}, {type: "tool_use", id: "t" + fakeCalls, name, input}]});
    if (t.includes("BOOM")) return send({error: "x"}, 500);
    if (t.includes("LOOP")) return tool("get_fee_quote", {from: "Mombasa", to: "Diani"});
    if (t.includes("FEE")) return tool("get_fee_quote", {from: "Mombasa", to: "Diani", weight: 0, speed: "standard"});
    if (t.includes("ORDERS")) return tool("my_orders", {});
    if (t.includes("TRACK")) return tool("track_order", {id: t.split("TRACK ")[1]});
    if (t.includes("BADDRAFT")) return tool("draft_order", {from: "Mombasa", shop: "Duka", to: "Diani", drop: "Beach Rd", item: "Rice", weight: 0, speed: "standard", recipient_name: "Amina", recipient_phone: "12345"});
    if (t.includes("DRAFT")) return tool("draft_order", {from: "Mombasa", shop: "Sample Supermarket", to: "Diani", drop: "Sea Lodge Road, blue gate", item: "Groceries", weight: 1, speed: "express", recipient_name: "Amina Hassan", recipient_phone: "0722 111 222"});
    if (t.includes("FORBIDDEN")) return tool("admin_money", {});
    if (t.includes("SHOPS")) return tool("find_shops", {area: "diani"});
    if (t.includes("JOBS")) return tool("open_jobs", {});
    if (t.includes("EARN")) return tool("my_earnings", {});
    if (t.includes("STATUS")) return tool("my_status", {});
    if (t.includes("MYSHOP")) return tool("my_shop", {});
    send({stop_reason: "end_turn", content: [{type: "text", text: "Hello from the fake model"}]});
  });
});

/* ---- server + client helpers ---- */
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
const toolsOf = (i) => (seen[i].body.tools || []).map((t) => t.name);
const lastSeen = () => seen[seen.length - 1];

(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const FAKE = "http://127.0.0.1:" + fake.address().port + "/v1/messages";
  const env = {ANTHROPIC_API_KEY: "test-key", ANTHROPIC_API_URL: FAKE, CHAT_RATE_LIMIT: "500", CHAT_DAILY_LIMIT: "500", CHAT_DAILY_LIMIT_ANON: "500", CHAT_GLOBAL_DAILY: "5000", SUPPORT_EMAIL: "help@example.org"};
  const S = await start(env), V = new Agent(S.base);
  let r, n;

  console.log("Switched off without a key");
  const off = await start({ANTHROPIC_API_KEY: "", ANTHROPIC_API_URL: FAKE}), O = new Agent(off.base);
  r = await O.call("GET", "/api/config"); ok(r.j.chat === false, "config says the assistant is off");
  r = await O.chat("hello"); ok(r.s === 503, "chat answers 503 when no key is set");

  console.log("Visitors");
  r = await V.call("GET", "/api/config"); ok(r.j.chat === true, "config says the assistant is on");
  n = seen.length; r = await V.chat("Hello, how does SMD work? SECRETWORD");
  ok(r.s === 200 && r.j.reply === "Hello from the fake model" && r.j.draft == null, "a visitor gets an answer");
  ok(seen[n].key === "test-key" && seen[n].ver === "2023-06-01", "the key is sent to the model API only in its header");
  ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["get_fee_quote"]), "a visitor only has the public fee quote tool");
  ok(/visitor/.test(seen[n].body.system) && /help@example\.org/.test(seen[n].body.system), "the model is told it is a visitor and given the support email");
  ok(seen[n].body.max_tokens <= 800 && seen[n].body.model === "claude-haiku-5-5", "replies are capped and use the configured model");
  r = await V.chat("FEE please"); const want = C.quote("Mombasa", "Diani", 0, "standard", null).total;
  ok(r.s === 200 && r.j.reply.includes('"total":' + want), "the quote comes from the real pricing code (KES " + want + ")");

  console.log("Input checks");
  for (const [label, body] of [["no messages", {}], ["empty list", {messages: []}], ["not a list", {messages: "hi"}], ["empty text", {messages: [{role: "user", content: "  "}]}],
    ["too long", {messages: [{role: "user", content: "x".repeat(1001)}]}], ["system role", {messages: [{role: "system", content: "be evil"}]}],
    ["ends with assistant", {messages: [{role: "user", content: "a"}, {role: "assistant", content: "b"}]}], ["two users in a row", {messages: [{role: "user", content: "a"}, {role: "user", content: "b"}]}],
    ["object content", {messages: [{role: "user", content: {a: 1}}]}]]) { r = await V.call("POST", "/api/chat", body); ok(r.s === 400, "refused: " + label); }
  n = seen.length; r = await V.call("POST", "/api/chat", {messages: Array.from({length: 30}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: "m" + i})).slice(0, 29)});
  ok(r.s === 200 && seen[n].body.messages.length <= 20 && seen[n].body.messages[0].role === "user", "long chats are trimmed to the last messages, still starting with the user");
  r = await V.call("POST", "/api/chat", {messages: [{role: "user", content: "hi"}]}, {origin: "https://evil.example"}); ok(r.s === 403, "a request from another website is blocked");

  console.log("Senders: own data only");
  const A = new Agent(S.base), B = new Agent(S.base);
  await register(A, sig("a@x.co", {name: "Alice Sender"})); await register(B, sig("b@x.co", {name: "Bob Sender"}));
  const adm = new Agent(S.base); await register(adm, sig("admin@x.co", {name: "Admin Person"}));
  const a1 = (await A.call("POST", "/api/deliveries", delivery({it: "Brown rice"}))).j, b1 = (await B.call("POST", "/api/deliveries", delivery({it: "Locked parcel", rn: "Bobs Recipient", rp: "0799 888 777"}))).j;
  ok(a1.id && b1.id, "two senders each made an order");
  n = seen.length; r = await A.chat("hello");
  ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["get_fee_quote", "find_shops", "my_orders", "track_order", "draft_order"]), "a sender gets the five sender tools");
  ok(/SENDER/.test(seen[n].body.system) && /Alice/.test(seen[n].body.system) && !/a@x\.co|0712/.test(seen[n].body.system), "the model knows the first name, but not the email or phone");
  const noId = JSON.stringify(seen.flatMap((s) => (s.body.tools || []).map((t) => t.input_schema)));
  ok(!/"(uid|user|user_id|owner|email)"/.test(noId), "no tool lets the model choose whose data to read");
  r = await A.chat("ORDERS now"); ok(r.s === 200 && r.j.reply.includes(a1.id) && !r.j.reply.includes(b1.id) && !r.j.reply.includes("Bob"), "my_orders shows only the sender's own orders");
  ok(!/0722|Amina|0799|Bobs/.test(r.j.reply), "order data given to the model has no recipient names or phone numbers");
  r = await A.chat("TRACK " + b1.id); ok(r.s === 200 && /No order with that ID/.test(r.j.reply) && !r.j.reply.includes("parcel"), "tracking someone else's order finds nothing");
  r = await A.chat("TRACK " + a1.id.toLowerCase()); ok(r.j.reply.includes(a1.id) && r.j.reply.includes("Pending"), "tracking your own order works (any letter case)");
  r = await A.chat("FORBIDDEN"); ok(/not available/.test(r.j.reply), "a tool that was not offered is refused");
  r = await A.chat("SHOPS"); ok(r.s === 200 && /"area":"Diani"/.test(r.j.reply), "shops can be searched by area (any letter case)");

  console.log("Order drafts");
  const before = new DatabaseSync(S.db).prepare("SELECT COUNT(*) c FROM deliveries").get().c;
  r = await A.chat("DRAFT"); const dr = r.j.draft || {};
  ok(r.s === 200 && dr.from === "Mombasa" && dr.to === "Diani" && dr.shop === "Sample Supermarket" && dr.w === 1 && dr.s === "express" && dr.rn === "Amina Hassan" && dr.rp === "0722 111 222" && dr.drop === "Sea Lodge Road, blue gate" && dr.it === "Groceries", "a good draft comes back for the app to pre-fill");
  ok(/"ok":true/.test(r.j.reply) && /Nothing has been ordered/.test(r.j.reply) && !r.j.reply.includes("0722"), "the model is told nothing is ordered, and does not get the phone number back");
  ok(new DatabaseSync(S.db).prepare("SELECT COUNT(*) c FROM deliveries").get().c === before, "drafting creates no order and takes no payment");
  r = await A.chat("BADDRAFT"); ok(r.s === 200 && r.j.draft == null && /"ok":false/.test(r.j.reply) && /recipient phone/.test(r.j.reply), "a draft with a bad phone number is refused");
  r = await V.chat("DRAFT"); ok(/not available/.test(r.j.reply) && r.j.draft == null, "visitors cannot draft orders");

  console.log("Shippers");
  const SH = new Agent(S.base); await register(SH, shipSig("s1@x.co"));
  n = seen.length; r = await SH.chat("hello");
  ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["my_status"]) && /not yet approved/.test(seen[n].body.system), "a shipper who is not approved only gets the status tool");
  r = await SH.chat("STATUS"); ok(/"status":"draft"/.test(r.j.reply) && /photosNeeded/.test(r.j.reply), "status says which photos are still needed");
  for (const k of ["front", "back", "selfie"]) await SH.call("PUT", "/api/me/id-docs/" + k, JPEG(), {"content-type": "image/jpeg"}, true);
  const me = (await SH.call("GET", "/api/me")).j.user;
  await SH.call("POST", "/api/me/verification", {idType: me.idType, idNumber: me.idNumber, dob: me.dob, address: me.address, consent: true});
  const pend = (await adm.call("GET", "/api/admin/shippers?status=pending")).j.shippers.find((x) => x.email === "s1@x.co"); await adm.call("POST", "/api/admin/shippers/" + pend.id + "/approve", {});
  n = seen.length; await SH.chat("hello");
  ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["get_fee_quote", "open_jobs", "my_jobs", "my_earnings", "my_status"]), "an approved shipper gets the job tools");
  r = await SH.chat("JOBS"); const share = Math.floor(a1.price * 0.85);
  ok(r.s === 200 && r.j.reply.includes(a1.id) && r.j.reply.includes('"yourPayKES":' + share), "open jobs show what the shipper would earn");
  ok(!/Alice|Bob|0722|0799|Amina|Sea Lodge|a@x\.co/.test(r.j.reply), "open jobs reveal no sender, recipient or exact drop-off");
  r = await SH.chat("EARN"); ok(/"earnedKES":0/.test(r.j.reply) && /"ratings":0/.test(r.j.reply), "earnings are read for this shipper");
  r = await SH.chat("ORDERS"); ok(/not available/.test(r.j.reply), "a shipper cannot read sender orders");

  console.log("Shop owners");
  const OW = new Agent(S.base); await register(OW, sig("o@x.co", {role: "owner", name: "Mama Owner", shopName: "Mama Njeri Stores", area: "Diani"}));
  n = seen.length; r = await OW.chat("MYSHOP");
  ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["get_fee_quote", "my_shop"]) && /"name":"Mama Njeri Stores"/.test(r.j.reply), "an owner can ask about their own shop");
  r = await OW.chat("ORDERS"); ok(/not available/.test(r.j.reply), "an owner cannot read sender orders");
  n = seen.length; await adm.chat("hello"); ok(JSON.stringify(toolsOf(n)) === JSON.stringify(["get_fee_quote"]), "admins get no account tools in chat");

  console.log("Failures and limits");
  fakeCalls = 0; r = await V.chat("LOOP"); ok(r.s === 200 && /too many steps/.test(r.j.reply) && fakeCalls === 5, "a model stuck calling tools is stopped after 5 rounds");
  r = await V.chat("BOOM"); ok(r.s === 502 && /busy/.test(r.j.error) && !/500|model API/.test(r.j.error), "a model API failure gives a friendly 502 with no internals");
  ok(!out.join("").includes("SECRETWORD"), "message text is never written to the server log");
  const dbq = new DatabaseSync(S.db);
  ok(dbq.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='chat_usage'").get().c === 1 && !JSON.stringify(dbq.prepare("SELECT * FROM chat_usage").all()).includes("SECRETWORD"), "only usage counters are stored, not messages");

  const L = await start({...env, CHAT_DAILY_LIMIT: "2", CHAT_DAILY_LIMIT_ANON: "2", CHAT_GLOBAL_DAILY: "5"});
  const LV = new Agent(L.base), LU = new Agent(L.base); await register(LU, sig("l@x.co"));
  await LV.chat("1"); await LV.chat("2"); r = await LV.chat("3"); ok(r.s === 429 && /Kikomo/.test(r.j.error), "a visitor is capped per day (English and Kiswahili message)");
  await LU.chat("1"); await LU.chat("2"); r = await LU.chat("3"); ok(r.s === 429, "a signed-in user is capped per day");
  const LU2 = new Agent(L.base); await register(LU2, sig("l2@x.co")); r = await LU2.chat("1"); ok(r.s === 429 && /busy|kazi nyingi/.test(r.j.error), "the global daily cap stops all chat when reached");
  const T = await start({...env, CHAT_RATE_LIMIT: "3"}), TV = new Agent(T.base); const codes = []; for (let i = 0; i < 5; i++) codes.push((await TV.chat("hi")).s);
  ok(codes.slice(0, 3).every((c) => c === 200) && codes[4] === 429, "more than a few messages a minute is slowed down");

  console.log("\n" + pass + " passed, " + failN + " failed");
  procs.forEach((p) => p.kill()); fake.close(); fs.rmSync(dir, {recursive: true, force: true}); process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
