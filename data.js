/* 타슈로 · 데이터 + 재고 예측
 * 아래 stations / lines / events 는 "샘플"입니다 (좌표는 대략값).
 * 실서비스에서는 TASHU.load() 안을 공공데이터 API(타슈 대여소 실시간 현황, 대전 버스 도착정보)로 바꾸면 됩니다.
 */
const TASHU = (() => {
  // ── 규칙·상수 (기획서 5장: ML 없이 규칙으로) ─────────────────────────────
  const CONFIG = {
    center: [36.3504, 127.3845],
    demoOrigin: { name: '현재 위치 (데모: 궁동)', lat: 36.3622, lng: 127.3488 },
    walkMpm: 75,          // 도보 m/분
    bikeMpm: 200,         // 자전거 m/분
    detour: 1.3,          // 직선거리 → 실제 도로거리 보정
    rentMin: 1, returnMin: 1,
    findStationM: 900,    // 출발·도착 대여소 탐색 반경(직선 m)
    minBikes: 2, minSlots: 2,   // 대여/반납 가능으로 보는 최소 여유
    longWalkM: 500,       // 혼합 모드: 이 이상 도보면 타슈로 대체 후보
    longWaitMin: 10,      // 혼합 모드: 이 이상 대기면 타슈로 대체 후보
    stationNearM: 150,    // 정류장과 대여소가 이 거리 이내면 연결 가능
    minSaveMin: 3,        // 혼합이 이만큼 이상 빠를 때만 추천
  };

  // ── 대여소 (bikes: 현재 대여 가능 대수) ────────────────────────────────
  const S = (id, name, lat, lng, cap, bikes, type, extra) => ({ id, name, lat, lng, cap, bikes, type, ...extra });
  const stations = [
    S('s01', '궁동 로데오거리', 36.3622, 127.3488, 20, 7, 'resid'),
    S('s02', '충남대 정문', 36.3668, 127.3442, 24, 2, 'campus'),
    S('s03', '유성온천역 3번출구', 36.3543, 127.3410, 20, 6, 'hub'),
    S('s04', '봉명동 공원', 36.3500, 127.3430, 16, 9, 'resid'),
    S('s05', '유림공원', 36.3600, 127.3380, 14, 4, 'park'),
    S('s06', '갑천역', 36.3560, 127.3560, 16, 5, 'hub'),
    S('s07', '월평역', 36.3592, 127.3690, 14, 0, 'hub'),
    S('s08', '정부청사역', 36.3607, 127.3797, 22, 8, 'hub'),
    S('s09', '한밭수목원 입구', 36.3675, 127.3875, 24, 11, 'park'),
    S('s10', '시청역', 36.3510, 127.3850, 20, 6, 'hub'),
    S('s11', '탄방역', 36.3480, 127.3790, 16, 3, 'resid'),
    S('s12', '서대전네거리역', 36.3230, 127.4040, 18, 7, 'hub'),
    S('s13', '중앙로역', 36.3282, 127.4262, 16, 4, 'hub'),
    S('s14', '대전역 동광장', 36.3327, 127.4345, 30, 10, 'hub'),
    S('s15', '월드컵경기장역', 36.3002, 127.3395, 40, 8, 'hub'),
    S('s16', '노은역', 36.3190, 127.3200, 20, 6, 'resid'),
    // 행사 때만 열리는 임시 반납존
    S('s17', '임시 반납존 (경기장 동문)', 36.3660, 127.3250, 60, 0, 'hub', { temp: true }),
    S('s18', '임시 반납존 (볼파크 정문)', 36.3170, 127.4290, 50, 0, 'hub', { temp: true }),
  ];

  // ── 목적지 검색용 장소 (대여소 이름도 함께 검색됨) ─────────────────────────
  const places = [
    { name: '충남대학교', lat: 36.3665, lng: 127.3440 },
    { name: '유성온천역', lat: 36.3545, lng: 127.3413 },
    { name: '대전역', lat: 36.3326, lng: 127.4343 },
    { name: '대전시청', lat: 36.3504, lng: 127.3849 },
    { name: '정부대전청사', lat: 36.3610, lng: 127.3800 },
    { name: '월드컵경기장', lat: 36.3665, lng: 127.3237 },
    { name: '대전 볼파크', lat: 36.3163, lng: 127.4305 },
    { name: '한밭수목원', lat: 36.3680, lng: 127.3870 },
  ];

  // ── 버스 노선 (샘플: 배차 H분, phase 로 "실시간 도착"을 흉내) ────────────────
  const P = (name, lat, lng) => ({ name, lat, lng });
  const stop = {
    cnu: P('충남대 정문', 36.3671, 127.3446), gung: P('궁동사거리', 36.3626, 127.3480),
    yuseong: P('유성온천역', 36.3547, 127.3415), gapcheon: P('갑천역', 36.3563, 127.3563),
    wolpyeong: P('월평역', 36.3595, 127.3688), gov: P('정부청사', 36.3611, 127.3795),
    city: P('시청', 36.3514, 127.3846), seodaejeon: P('서대전네거리', 36.3233, 127.4038),
    jungang: P('중앙로역', 36.3285, 127.4258), daejeon: P('대전역', 36.3330, 127.4340),
    stadium: P('월드컵경기장', 36.3662, 127.3240), stadiumSt: P('월드컵경기장역', 36.3668, 127.3174),
    noeun: P('노은역', 36.3740, 127.3182),
  };
  const lines = [
    { name: '102', H: 16, phase: 3, stops: [stop.cnu, stop.gung, stop.yuseong, stop.gapcheon, stop.wolpyeong, stop.gov, stop.city, stop.seodaejeon, stop.jungang, stop.daejeon] },
    { name: '705', H: 12, phase: 7, stops: [stop.stadium, stop.stadiumSt, stop.noeun, stop.yuseong, stop.gov, stop.city] },
  ];
  const rad = Math.PI / 180;
  const meters = (a, b) => {
    const x = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  };
  for (const l of lines) {           // 정류장 간 누적 소요시간(분)
    l.cum = [0];
    for (let k = 1; k < l.stops.length; k++)
      l.cum.push(l.cum[k - 1] + meters(l.stops[k - 1], l.stops[k]) * CONFIG.detour / 300 + 0.5);
  }

  // ── 행사 (기획서 모드 3) ──────────────────────────────────────────────
  const at = (h, m) => {
    const d = new Date(); d.setHours(h, m, 0, 0);
    if (d.getTime() < Date.now() - 2 * 3600e3) d.setDate(d.getDate() + 1);
    return d;
  };
  const events = [
    { id: 'e1', emoji: '🎤', title: '월드컵경기장 대형 콘서트', short: '콘서트', lat: 36.3665, lng: 127.3237, radius: 700, start: at(19, 0),
      hubs: [{ id: 'ST0331', ready: 32 }, { id: 'ST0333', ready: 20 }, { id: 'ST0196', ready: 14 }], zone: 's17', afterBikes: 60 },
    { id: 'e2', emoji: '⚾', title: '대전 볼파크 야구 경기', short: '야구', lat: 36.3163, lng: 127.4305, radius: 600, start: at(18, 30),
      hubs: [{ id: 'ST0065', ready: 24 }, { id: 'ST1067', ready: 16 }], zone: 's18', afterBikes: 50 },
  ];

  // ── 도착 시점 재고 예상: 시간대별 평균 순유입(반납−대여)을 현재 재고에 더함 ──────
  // 실제로는 이용내역(2024·2026)에서 대여소·요일·시간대별 평균을 미리 계산해 쓰면 됩니다.
  const bump = (h, c, w, a) => a * Math.exp(-((h - c) ** 2) / (2 * w * w));
  const FLOW = {
    campus: h => bump(h, 9, 1.2, 6) - bump(h, 18, 1.5, 6),
    resid: h => -bump(h, 8, 1.2, 5) + bump(h, 19, 1.8, 5),
    hub: h => -bump(h, 8, 1.2, 3) + bump(h, 18, 1.5, 3),
    park: h => -bump(h, 15, 2.5, 3) + bump(h, 19, 1.5, 2),
  };
  function forecast(st, mins, now = new Date()) {
    let n = st.bikes;
    for (let m = 0; m < mins; m += 5) {
      const t = new Date(now.getTime() + m * 60000);
      n += FLOW[st.type](t.getHours() + t.getMinutes() / 60) * Math.min(5, mins - m) / 60;
    }
    return Math.max(0, Math.min(st.cap, Math.round(n)));
  }

  // ── 실제 대여소 로드 (data/stations.json ← geocode.js 가 CSV 에서 생성) ─────────
  // 주의: CSV 에는 "현재 대여 가능 대수"가 없어 cap/bikes/type 은 id 기반 추정값입니다.
  //       실시간 재고 API 를 받으면 아래 map() 안의 bikes 를 그 값으로 바꾸세요.
  const hash = s => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const guessType = n => /아파트|APT/i.test(n) ? 'resid' : /대학|학교|캠퍼스/.test(n) ? 'campus' : /공원|수목원|천변|체육/.test(n) ? 'park' : 'hub';
  const flags = { realStations: false, realLines: false, liveArrival: false };
  const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };

  async function load() {
    // 1) 타슈 대여소
    try {
      const rows = await getJson('data/stations.json');
      const real = rows.filter(x => x.lat && !/정비대기|관제/.test(x.name)).map(x => {
        const cap = 12 + hash(x.id) % 14;
        return { id: x.id, name: x.name, lat: x.lat, lng: x.lng, cap, type: guessType(x.name), dong: x.dong,
          bikes: Math.round(cap * (hash(x.id + 'b') % 100) / 100 * 0.8) };
      });
      const temps = stations.filter(s => s.temp);
      stations.length = 0; stations.push(...real, ...temps);
      flags.realStations = true;
    } catch { console.warn('data/stations.json 을 못 읽어 샘플 대여소를 씁니다 (node server.js 로 실행했는지 확인)'); }

    // 2) 버스 노선 (data/bus_lines.json ← fetch_bus.js). 한 노선의 정류소 목록은 기점→종점→복귀까지 "한 방향 순서".
    try {
      const rows = await getJson('data/bus_lines.json');
      const real = rows.map(r => {
        const H = Math.min(r.H, 90), st = r.stops.map(s => ({ id: s[0], ars: s[1], name: s[2], lat: s[3], lng: s[4] }));
        return { id: r.id, name: r.no, H, phase: hash(r.id) % H, real: true, oneWay: true, stops: st,
          cum: r.stops.map((s, k) => (s[5] - r.stops[0][5]) / 300 + 0.3 * k) };   // 누적거리(m)/300m·분 + 정차 0.3분
      });
      lines.length = 0; lines.push(...real);
      flags.realLines = true;
    } catch { console.warn('data/bus_lines.json 을 못 읽어 샘플 노선을 씁니다'); }
    return { stations, lines, flags };
  }

  // 정류소(7자리 정류소ID)의 실시간 도착 예정. server.js 가 키를 숨겨 중계. 실패하면 null → 배차간격 추정으로 대체.
  async function arrivals(nodeId, routeCd) {
    try {
      const r = await fetch('/api/arrive?stop=' + encodeURIComponent(nodeId), { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      flags.liveArrival = true;
      return (await r.json()).filter(a => a.routeCd === routeCd).map(a => a.sec / 60).sort((a, b) => a - b);
    } catch { return null; }
  }

  return { CONFIG, stations, places, lines, events, forecast, meters, load, arrivals, flags };
})();
