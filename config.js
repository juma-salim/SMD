/* Business configuration: single source of truth. The server uses it for pricing and validation; the client gets it from /api/config. */
const AREAS = {
  /* Listed in route order. "pos" = km from Mombasa along the way (north is negative): it sets the price AND the order shown on the map/lists. x,y = map position.
     Mariakani and Mtwapa are the north/west side (no ferry needed to reach Mombasa); Likoni and everything south of it is reached by the Likoni ferry. */
  Mariakani:{x:100,y:16,pos:-25,side:"l"}, Mtwapa:{x:205,y:34,pos:-17,side:"l"}, Mombasa:{x:215,y:56,pos:0,side:"l"}, Likoni:{x:205,y:80,pos:5,side:"l"}, Kombani:{x:172,y:106,pos:30,side:"l"},
  Tiwi:{x:190,y:132,pos:36,side:"l"}, Ukunda:{x:152,y:158,pos:42,side:"l"}, Diani:{x:190,y:184,pos:46,side:"l"}
};
const SHOPS = [
  {n:"Sample Supermarket",a:"Mombasa"},{n:"Sample Pharmacy",a:"Mombasa"},{n:"Sample Supermarket",a:"Likoni"},{n:"Sample Pharmacy",a:"Likoni"},
  {n:"Sample Supermarket",a:"Tiwi"},{n:"Sample Supermarket",a:"Kombani"},{n:"Sample Supermarket",a:"Ukunda"},{n:"Sample Pharmacy",a:"Ukunda"},
  {n:"Sample Supermarket",a:"Diani"},{n:"Sample Pharmacy",a:"Diani"}
];
const P = {local:150, base:200, perKm:12, ferry:50, expressPct:0.6};
const WT = [{l:"Up to 2 kg",f:0},{l:"2 – 5 kg",f:100},{l:"5 – 10 kg",f:250},{l:"10 – 20 kg",f:500}];
const VEHICLES = ["Motorbike","Bicycle","Tuk-tuk","Pickup / van"];
const BOX = {latMin:-4.75, latMax:-3.9, lngMin:39.3, lngMax:39.95};
const ID_TYPES = ["National ID","Passport","Driving licence"];

/* Goods worth MORE than this (from a listed shop) may be paid for after delivery, through M-Pesa, once the sender confirms receipt. */
const DEFER_MIN = +process.env.DEFER_MIN_GOODS || 999;
/* The automatic route fee (ferry included). The admin can override it per pair of places; see the Fees tab. */
function routeBase(f, t) {
  const d = Math.abs(AREAS[f].pos - AREAS[t].pos);
  const route = f === t ? P.local : P.base + Math.round(d * P.perKm);
  const ferry = (f !== t && (AREAS[f].pos <= 0) !== (AREAS[t].pos <= 0)) ? P.ferry : 0; /* crossing the Likoni channel */
  return {d, route, ferry};
}
/* fee: the admin's fixed route fee for this pair (replaces route + ferry), or null/undefined to use the formula. */
function quote(f, t, w, s, fee) {
  const b = routeBase(f, t), d = b.d, custom = Number.isInteger(fee);
  const route = custom ? fee : b.route, ferry = custom ? 0 : b.ferry;
  const wf = WT[w].f, sub = route + wf + ferry;
  const ex = s === "express" ? Math.round(sub * P.expressPct) : 0;
  return {d, route, wf, ferry, ex, total: Math.round((sub + ex) / 10) * 10};
}
const feeKey = (a, b) => [a, b].sort().join("|");
module.exports = {AREAS, SHOPS, P, WT, VEHICLES, BOX, ID_TYPES, DEFER_MIN, quote, routeBase, feeKey};
