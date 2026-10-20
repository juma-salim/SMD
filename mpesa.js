"use strict";
/* Safaricom Daraja (M-Pesa Express / STK Push) client. No dependencies: uses Node's built-in fetch.
   Configuration comes from environment variables (see .env.example). Nothing here ever logs secrets or tokens. */

const SANDBOX = "https://sandbox.safaricom.co.ke", LIVE = "https://api.safaricom.co.ke";

const cfg = () => {
  const env = process.env.MPESA_ENV === "production" ? "production" : "sandbox";
  return {
    env,
    base: process.env.MPESA_BASE_URL || (env === "production" ? LIVE : SANDBOX), /* MPESA_BASE_URL is for tests only */
    key: process.env.MPESA_CONSUMER_KEY || "", secret: process.env.MPESA_CONSUMER_SECRET || "",
    shortcode: process.env.MPESA_SHORTCODE || "", passkey: process.env.MPESA_PASSKEY || "",
    /* CustomerPayBillOnline for a Paybill, CustomerBuyGoodsOnline for a Till (Buy Goods) number */
    type: process.env.MPESA_TXN_TYPE === "CustomerBuyGoodsOnline" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    /* For a Till, PartyB is the till number; for a Paybill it equals the shortcode. */
    partyB: process.env.MPESA_PARTY_B || process.env.MPESA_SHORTCODE || "",
    callbackBase: (process.env.MPESA_CALLBACK_BASE || "").replace(/\/+$/, ""), /* public HTTPS origin, e.g. https://smd.example.com */
    callbackSecret: process.env.MPESA_CALLBACK_SECRET || ""
  };
};
const enabled = () => { const c = cfg(); return !!(c.key && c.secret && c.shortcode && c.passkey && c.partyB && /^https:\/\//.test(c.callbackBase) && c.callbackSecret.length >= 24) || (!!process.env.MPESA_BASE_URL && !!(c.key && c.secret)); };
const callbackUrl = () => { const c = cfg(); return c.callbackBase + "/hooks/pay/" + c.callbackSecret; }; /* path deliberately avoids the word "mpesa": Daraja rejects such callback URLs */

/* 07XX / 01XX / +2547XX / 2547XX  ->  2547XXXXXXXX (the only format Daraja accepts) */
function toMsisdn(p) {
  const n = String(p || "").replace(/[\s\-()]/g, "").replace(/^\+/, "");
  const m = /^(?:254|0)([17]\d{8})$/.exec(n);
  return m ? "254" + m[1] : null;
}

/* Daraja timestamp: YYYYMMDDHHmmss in East Africa Time (UTC+3, no DST) */
function timestamp(d = new Date()) {
  const e = new Date(d.getTime() + 3 * 3600e3), p = (n) => String(n).padStart(2, "0");
  return e.getUTCFullYear() + p(e.getUTCMonth() + 1) + p(e.getUTCDate()) + p(e.getUTCHours()) + p(e.getUTCMinutes()) + p(e.getUTCSeconds());
}

class MpesaError extends Error {
  constructor(msg, extra) { super(msg); Object.assign(this, extra); }
}

/* OAuth token: valid ~1 hour, cached in memory and refreshed a minute early. Concurrent callers share one request. */
let tok = {v: "", exp: 0}, tokP = null;
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  if (tokP) return tokP;
  const c = cfg();
  tokP = (async () => {
    const r = await fetch(c.base + "/oauth/v1/generate?grant_type=client_credentials", {
      headers: {Authorization: "Basic " + Buffer.from(c.key + ":" + c.secret).toString("base64")}, signal: AbortSignal.timeout(10000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new MpesaError("M-Pesa authentication failed (check consumer key/secret and MPESA_ENV).", {status: r.status});
    tok = {v: j.access_token, exp: Date.now() + Math.max(60, (+j.expires_in || 3599) - 60) * 1000};
    return tok.v;
  })().finally(() => { tokP = null; });
  return tokP;
}

async function call(path, body, retry = true) {
  const c = cfg(), t = await token();
  const r = await fetch(c.base + path, {method: "POST", headers: {Authorization: "Bearer " + t, "Content-Type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && retry) { tok = {v: "", exp: 0}; return call(path, body, false); } /* token revoked/expired early */
  return {ok: r.ok, status: r.status, j};
}

/* Ask the customer's phone for payment. Returns {merchantRequestId, checkoutRequestId} when Safaricom ACCEPTED the request
   (this is NOT payment: the result arrives later via the callback or a status query). */
async function stkPush({phone, amount, ref, desc}) {
  const c = cfg(), msisdn = toMsisdn(phone);
  if (!msisdn) throw new MpesaError("Enter a valid Safaricom number, e.g. 0712 345 678.", {user: true});
  if (!Number.isInteger(amount) || amount < 1 || amount > 250000) throw new MpesaError("Invalid amount.", {user: true});
  const ts = timestamp();
  const {ok, j} = await call("/mpesa/stkpush/v1/processrequest", {
    BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString("base64"), Timestamp: ts,
    TransactionType: c.type, Amount: amount, PartyA: msisdn, PartyB: c.partyB, PhoneNumber: msisdn,
    CallBackURL: callbackUrl(), AccountReference: String(ref).slice(0, 12), TransactionDesc: String(desc || "Delivery").slice(0, 13)
  });
  if (!ok || String(j.ResponseCode) !== "0") {
    console.error("[mpesa] stkpush rejected:", j.errorCode || j.ResponseCode, j.errorMessage || j.ResponseDescription || "");
    throw new MpesaError("M-Pesa could not start the payment. Please try again in a moment.", {code: j.errorCode || j.ResponseCode});
  }
  return {merchantRequestId: j.MerchantRequestID, checkoutRequestId: j.CheckoutRequestID, msisdn};
}

/* Ask Safaricom what happened to a request (used when a callback is late or lost). */
async function stkQuery(checkoutRequestId) {
  const c = cfg(), ts = timestamp();
  const {ok, j} = await call("/mpesa/stkpushquery/v1/query", {
    BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.passkey + ts).toString("base64"), Timestamp: ts, CheckoutRequestID: checkoutRequestId
  });
  /* While the customer is still deciding Daraja answers HTTP 500 with errorCode 500.001.1001 ("being processed"): that means "still pending". */
  if (!ok) return {pending: true};
  if (j.ResultCode === undefined) return {pending: true};
  return {pending: false, code: Number(j.ResultCode), desc: String(j.ResultDesc || "")};
}

/* Parse the body Safaricom POSTs to our callback URL. Returns null when the shape is wrong. */
function parseCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== "string") return null;
  const meta = {};
  for (const it of (cb.CallbackMetadata && Array.isArray(cb.CallbackMetadata.Item) ? cb.CallbackMetadata.Item : [])) if (it && it.Name) meta[it.Name] = it.Value;
  return {
    merchantRequestId: String(cb.MerchantRequestID || ""), checkoutRequestId: cb.CheckoutRequestID, code: Number(cb.ResultCode), desc: String(cb.ResultDesc || "").slice(0, 200),
    amount: meta.Amount === undefined ? null : Number(meta.Amount), receipt: meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber).slice(0, 20) : null,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : null
  };
}

/* Friendly text for the result codes customers actually hit */
function explain(code) {
  return {[-1]: "We did not get a response from your phone. Please try again.", 1: "Insufficient M-Pesa balance.", 1032: "You cancelled the payment request.", 1037: "The request timed out: no PIN was entered on your phone.", 2001: "Wrong M-Pesa PIN entered.",
    1001: "Another M-Pesa transaction is in progress on this number. Try again shortly.", 1019: "The payment request expired.", 1025: "Could not send the request to your phone. Try again."}[code] || "The payment was not completed.";
}

module.exports = {enabled, toMsisdn, timestamp, stkPush, stkQuery, parseCallback, explain, cfg, callbackUrl};
