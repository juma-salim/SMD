/* Business configuration: single source of truth. The server uses it for pricing and validation; the client gets it from /api/config. */
const AREAS = {
  /* Listed in route order. "pos" = km from Mombasa: it sets the price AND the order shown on the map/lists. x,y = map position. */
  Mombasa:{x:215,y:22,pos:0,side:"l"}, Likoni:{x:205,y:58,pos:5,side:"l"}, Kombani:{x:172,y:92,pos:30,side:"l"},
  Tiwi:{x:190,y:126,pos:36,side:"l"}, Ukunda:{x:152,y:158,pos:42,side:"l"}, Diani:{x:190,y:186,pos:46,side:"l"}
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

function quote(f, t, w, s) {
  const d = Math.abs(AREAS[f].pos - AREAS[t].pos);
  const route = f === t ? P.local : P.base + Math.round(d * P.perKm);
  const ferry = (f !== t && ((f === "Mombasa") !== (t === "Mombasa"))) ? P.ferry : 0;
  const wf = WT[w].f, sub = route + wf + ferry;
  const ex = s === "express" ? Math.round(sub * P.expressPct) : 0;
  return {d, route, wf, ferry, ex, total: Math.round((sub + ex) / 10) * 10};
}
module.exports = {AREAS, SHOPS, P, WT, VEHICLES, BOX, ID_TYPES, quote};
