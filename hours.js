"use strict";
/* Shop opening hours. Kenya has no daylight saving, so shops run on East Africa Time (UTC+3) all year.
   A week is stored as JSON: {"0":["08:00","20:00"], ... "6":null}  (0 = Sunday ... 6 = Saturday; null = closed that day).
   A day that closes at or before it opens (e.g. 18:00 to 02:00) runs past midnight into the next morning.
   "00:00" to "00:00" means open 24 hours. A shop with no hours at all (null) is treated as always open. */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EAT = 3 * 3600 * 1000;
const T = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3);

/* Check what an owner sent. Returns the clean week, or null for "no hours set". Throws a plain message when something is wrong. */
function clean(h) {
  if (h == null) return null;
  if (typeof h !== "object" || Array.isArray(h)) throw new Error("Opening hours are not valid.");
  const out = {};
  for (let d = 0; d < 7; d++) {
    const v = h[d] != null ? h[d] : h[String(d)];
    if (v == null || v === false) { out[d] = null; continue; }
    const o = Array.isArray(v) ? v[0] : v.o, c = Array.isArray(v) ? v[1] : v.c;
    if (typeof o !== "string" || typeof c !== "string" || !T.test(o) || !T.test(c)) throw new Error("Use times like 08:00 for " + DAYS[d] + ".");
    if (o === c && o !== "00:00") throw new Error("On " + DAYS[d] + " the opening and closing times are the same. Use 00:00 to 00:00 for open 24 hours, or mark the day closed.");
    out[d] = [o, c];
  }
  if (!Object.values(out).some(Boolean)) throw new Error("Open at least one day, or use 'Closed for now' to pause orders.");
  return out;
}

function parse(raw) { /* from the database column */
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function nowEAT(ms) { const d = new Date((ms == null ? Date.now() : ms) + EAT); return {day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes()}; }

/* Is the week open at this day/minute? Returns the closing time text when open, or null when closed. */
function openAt(h, day, min) {
  const w = h[day];
  if (w) {
    const o = mins(w[0]), c = mins(w[1]);
    if (o === c) return "24h";
    if (o < c ? min >= o && min < c : min >= o) return w[1];
  }
  const p = h[(day + 6) % 7]; /* yesterday's window that runs past midnight */
  if (p) { const o = mins(p[0]), c = mins(p[1]); if (c < o && min < c) return p[1]; }
  return null;
}

/* {open, hoursSet, label}: label is short text for the customer, e.g. "Open · closes 20:00" or "Closed · opens Mon 08:00" */
function status(shop, ms) {
  const h = parse(shop && shop.hours);
  if (shop && shop.closed_now) return {open: false, hoursSet: !!h, label: "Closed for now", paused: true};
  if (!h) return {open: true, hoursSet: false, label: ""};
  const t = nowEAT(ms), c = openAt(h, t.day, t.min);
  if (c) return {open: true, hoursSet: true, label: c === "24h" ? "Open 24 hours" : "Open · closes " + c};
  for (let off = 0; off <= 7; off++) {
    const d = (t.day + off) % 7, w = h[d]; if (!w) continue;
    if (off === 0 && mins(w[0]) <= t.min) continue; /* today's window already started or passed */
    const when = off === 0 ? "today" : off === 1 ? "tomorrow" : DAYS[d].slice(0, 3);
    return {open: false, hoursSet: true, label: "Closed · opens " + when + " " + w[0]};
  }
  return {open: false, hoursSet: true, label: "Closed"};
}

module.exports = {DAYS, clean, parse, status, nowEAT};
