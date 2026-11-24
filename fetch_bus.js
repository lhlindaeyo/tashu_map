// 대전 버스 노선 + 노선별 정류소 순서 → data/bus_lines.json. 한 번만 실행하면 됩니다.
//   node fetch_bus.js
// 필요: .env 의 BusRouteInfoServiceKey (없으면 BUS_API_KEY) — '대전광역시_노선정보조회' 활용신청 키
const fs = require('fs'), path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const raw = env.BusRouteInfoServiceKey || env.BUS_API_KEY;
if (!raw) { console.error('.env 에 BusRouteInfoServiceKey(또는 BUS_API_KEY)를 넣어주세요.'); process.exit(1); }
const key = raw.includes('%') ? raw : encodeURIComponent(raw);

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const items = xml => [...xml.matchAll(/<itemList>([\s\S]*?)<\/itemList>/g)]
  .map(m => Object.fromEntries([...m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map(a => [a[1], decode(a[2].trim())])));
async function get(op, q, tries = 3) {
  for (let t = 1; ; t++) {
    try {
      const xml = await (await fetch(`https://apis.data.go.kr/6300000/busRouteInfo/${op}?serviceKey=${key}&${q}`)).text();
      if (xml.includes('OpenAPI_ServiceResponse')) throw new Error('API 오류: ' + (xml.match(/<errMsg>(.*?)<\/errMsg>/)?.[1] || xml.slice(0, 150)));
      return xml;
    } catch (e) { if (t >= tries || e.message.startsWith('API')) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
}

(async () => {
  const routes = [];
  for (let page = 1; ; page++) {
    const xml = await get('getRouteInfoAll', 'reqPage=' + page);
    routes.push(...items(xml));
    if (page >= +(xml.match(/<itemPageCnt>(\d+)</)?.[1] || 1)) break;
  }
  console.log('노선', routes.length + '개');
  const lines = [];
  for (const [n, r] of routes.entries()) {
    const st = items(await get('getStaionByRoute', 'busRouteId=' + r.ROUTE_CD));
    if (!st.length) continue;
    lines.push({
      id: r.ROUTE_CD, no: r.ROUTE_NO, type: r.ROUTE_TP, H: +r.ALLO_INTERVAL || 15, runMin: +r.RUN_TM || 0,
      // [정류소ID(도착정보용 7자리), ARS번호, 이름, 위도, 경도, 누적거리(m)]
      stops: st.map(s => [s.BUS_NODE_ID, s.BUS_STOP_ID, s.BUSSTOP_NM, +s.GPS_LATI, +s.GPS_LONG, +s.TOTAL_DIST]),
    });
    if ((n + 1) % 20 === 0) console.log((n + 1) + ' / ' + routes.length);
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'bus_lines.json'), JSON.stringify(lines));
  console.log('저장 완료:', lines.length + '개 노선 →', 'data/bus_lines.json');
})().catch(e => { console.error(e.message); process.exit(1); });
