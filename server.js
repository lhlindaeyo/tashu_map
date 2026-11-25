// 타슈로 서버: 정적 파일 제공 + 버스 도착정보·타슈 대여소 현황 중계 (API 키는 .env 에만 있고 브라우저로 나가지 않음)
//   node server.js   →  http://localhost:5173
const http = require('http'), fs = require('fs'), path = require('path');

const root = __dirname;
const env = Object.fromEntries((fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const get = k => process.env[k] || env[k] || '';          // 환경변수가 .env 보다 우선 (테스트용)
const rawKey = get('BusArrivalInfoServiceKey') || get('BUS_API_KEY');
const arriveKey = rawKey.includes('%') ? rawKey : encodeURIComponent(rawKey);
const PORT = +process.env.PORT || 5173;
const tashuKey = get('TashuApiKey');
const TASHU_URL = get('TASHU_API_URL') || 'https://bikeapp.tashu.or.kr:50041/v1/openapi/station';

// 브라우저에 내보내도 되는 파일만 (서버 코드·.env 는 제외)
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json;charset=utf-8' };
const hidden = new Set(['server.js', 'geocode.js', 'fetch_bus.js']);

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const cache = new Map();   // stop → { t, data }  (같은 정류소를 15초 안에 다시 부르면 재사용)

async function arrivals(stop) {
  const hit = cache.get(stop);
  if (hit && Date.now() - hit.t < 15000) return hit.data;
  const r = await fetch(`https://apis.data.go.kr/6300000/arrive/getArrInfoByStopID?serviceKey=${arriveKey}&BusStopID=${stop}`, { signal: AbortSignal.timeout(5000) });
  const xml = await r.text();
  if (xml.includes('OpenAPI_ServiceResponse')) throw new Error(xml.match(/<errMsg>(.*?)<\/errMsg>/)?.[1] || 'API 오류');
  const data = [...xml.matchAll(/<itemList>([\s\S]*?)<\/itemList>/g)].map(m => {
    const o = Object.fromEntries([...m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map(a => [a[1], decode(a[2].trim())]));
    return { routeCd: o.ROUTE_CD, route: o.ROUTE_NO, sec: +o.EXTIME_SEC, min: +o.EXTIME_MIN, stopsLeft: +o.STATUS_POS, dest: o.DESTINATION };
  });
  cache.set(stop, { t: Date.now(), data });
  return data;
}

// 타슈 대여소 현황 (대전교통공사 Open API): 헤더 api-token 으로 인증, 대여소별 parking_count = 대여 가능 자전거 수
let stationCache = null;   // { t, data }
const inRange = (v, lo, hi) => v >= lo && v <= hi;
function normStation(s) {
  let lat = +s.x_pos, lng = +s.y_pos;                                   // 안내문: x_pos=위도, y_pos=경도
  if (!inRange(lat, 33, 39) && inRange(lng, 33, 39)) [lat, lng] = [lng, lat];   // 순서가 뒤바뀌어 와도 값 범위로 바로잡는다
  if (!inRange(lat, 33, 39) || !inRange(lng, 124, 132)) return null;
  return { id: String(s.id), name: String(s.name || ''), lat, lng, address: s.address || '', bikes: Math.max(0, +s.parking_count || 0) };
}
async function tashuStations() {
  if (stationCache && Date.now() - stationCache.t < 30000) return stationCache.data;   // 호출 한도를 아끼기 위해 30초 재사용
  const origin = new URL(TASHU_URL).origin, out = [];
  let next = TASHU_URL;
  for (let page = 0; next && page < 30; page++) {
    const r = await fetch(next, { headers: { 'api-token': tashuKey }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('타슈 API 응답 ' + r.status);
    const j = await r.json();
    out.push(...(j.results || []).map(normStation).filter(Boolean));
    next = j.next && new URL(j.next, TASHU_URL).origin === origin ? j.next : null;   // 같은 서버의 다음 페이지만 따라간다 (키가 다른 곳으로 가지 않게)
  }
  stationCache = { t: Date.now(), data: out };
  return out;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/arrive') {
    const stop = url.searchParams.get('stop') || '';
    res.setHeader('content-type', 'application/json;charset=utf-8');
    if (!/^\d{5,9}$/.test(stop)) { res.writeHead(400); return res.end('{"error":"bad stop"}'); }
    if (!rawKey) { res.writeHead(503); return res.end('{"error":"no key"}'); }
    try { res.writeHead(200); res.end(JSON.stringify(await arrivals(stop))); }
    catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (url.pathname === '/api/stations') {
    res.setHeader('content-type', 'application/json;charset=utf-8');
    if (!tashuKey) { res.writeHead(503); return res.end('{"error":"no key"}'); }
    try { res.writeHead(200); res.end(JSON.stringify(await tashuStations())); }
    catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.resolve(root, '.' + p);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(s => s.startsWith('.')) || hidden.has(rel) || !types[path.extname(file)]) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-cache' });
    res.end(d);
  });
}).listen(PORT, '127.0.0.1', () => console.log('타슈로: http://localhost:' + PORT));
