// 產生 Google Flights 的 tfs 參數(protobuf 手工編碼)
// 結構參考社群逆向 (fast-flights): Info{data=3, passengers=8, seat=9, trip=19}
// FlightData{date=2, from=13{name=2}, to=14{name=2}}
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
function lenDelim(fieldNo, bytes) {
  return [...varint((fieldNo << 3) | 2), ...varint(bytes.length), ...bytes];
}
function str(fieldNo, s) {
  return lenDelim(fieldNo, [...Buffer.from(s, 'utf8')]);
}
function vint(fieldNo, v) {
  return [...varint(fieldNo << 3), ...varint(v)];
}
const SEAT = { economy: 1, premium: 2, business: 3, first: 4 };

// legs: [{date:'2026-10-15', from:'BKK', to:'VIE'}, ...]
function tfs(legs, cabin) {
  const body = [];
  for (const leg of legs) {
    const fd = [
      ...str(2, leg.date),
      ...lenDelim(13, str(2, leg.from)),
      ...lenDelim(14, str(2, leg.to)),
    ];
    body.push(...lenDelim(3, fd));
  }
  body.push(...lenDelim(8, vint(1, 1)));            // passengers: 1 adult
  body.push(...vint(9, SEAT[cabin] || 1));           // seat
  body.push(...vint(19, legs.length > 1 ? 1 : 2));   // trip: round/one-way
  return Buffer.from(body).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function flightsUrl({ from, to, depart, ret, cabin }) {
  const legs = [{ date: depart, from, to }];
  if (ret) legs.push({ date: ret, from: to, to: from });
  return `https://www.google.com/travel/flights/search?tfs=${tfs(legs, cabin)}&hl=zh-TW&curr=TWD`;
}

module.exports = { flightsUrl };
