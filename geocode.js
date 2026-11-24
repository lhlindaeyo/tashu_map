// 타슈 대여소 CSV(주소) → data/stations.json(좌표 포함). 한 번만 실행하면 됩니다.
//   node geocode.js
// 필요: .env 의 KAKAO_REST_KEY. 중간에 끊겨도 다시 실행하면 이어서 합니다.
const fs = require('fs'), path = require('path');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
if (!env.KAKAO_REST_KEY) { console.error('.env 에 KAKAO_REST_KEY 를 먼저 넣어주세요.'); process.exit(1); }

const dir = path.join(__dirname, 'data');
const csv = fs.readdirSync(dir).find(f => f.endsWith('.csv'));
const out = path.join(dir, 'stations.json');
const rows = new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(dir, csv))).split(/\r?\n/).slice(1)
  .filter(Boolean).map(l => { const [id, name, district, dong, ...addr] = l.split(','); return { id, name, district, dong, address: addr.join(',').trim() }; });

const done = new Map((fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : []).map(s => [s.id, s]));
const call = async (kind, q) => {
  const r = await fetch(`https://dapi.kakao.com/v2/local/search/${kind}.json?size=1&query=${encodeURIComponent(q)}`, { headers: { Authorization: 'KakaoAK ' + env.KAKAO_REST_KEY } });
  if (r.status === 401 || r.status === 403) throw new Error('카카오 인증 실패(' + r.status + ') — 키/서비스 설정을 확인하세요');
  const d = (await r.json()).documents?.[0];
  return d ? { lat: +d.y, lng: +d.x } : null;
};

(async () => {
  let n = 0, fail = [];
  for (const s of rows) {
    if (done.get(s.id)?.lat) continue;
    let p = null;
    try { p = await call('address', s.address) || await call('keyword', '대전 ' + s.name.replace(/\(.*?\)/g, '')); }
    catch (e) { console.error(e.message); process.exit(1); }
    done.set(s.id, { ...s, ...(p || {}) });
    if (!p) fail.push(s.id + ' ' + s.name);
    if (++n % 50 === 0) { fs.writeFileSync(out, JSON.stringify([...done.values()])); console.log(n + ' / ' + rows.length); }
    await new Promise(r => setTimeout(r, 40));
  }
  fs.writeFileSync(out, JSON.stringify([...done.values()]));
  console.log(`완료: ${done.size}개 저장, 좌표 못 찾음 ${fail.length}개`);
  if (fail.length) console.log(fail.join('\n'));
})();
