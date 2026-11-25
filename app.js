'use strict';
const T = TASHU, C = T.CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  tab: 'map', mode: 'tashu',
  origin: { ...C.demoOrigin }, dest: null, field: 'to',
  sel: null, fav: new Set(), ev: 0, after: false,
  plan: null, guide: null, token: 0,
};
try { JSON.parse(localStorage.getItem('tashuro.fav') || '[]').forEach(id => state.fav.add(id)); } catch {}
const saveFav = () => { try { localStorage.setItem('tashuro.fav', JSON.stringify([...state.fav])); } catch {} };

/* ───────── 계산 도우미 ───────── */
const dist = T.meters;
const road = (a, b) => dist(a, b) * C.detour;
const walkRaw = (a, b) => road(a, b) / C.walkMpm;
const bikeRaw = (a, b) => road(a, b) / C.bikeMpm + C.rentMin + C.returnMin;
const rnd = x => Math.max(1, Math.round(x));
const mod = (a, n) => ((a % n) + n) % n;
const hhmm = min => { const d = new Date(Date.now() + min * 60000); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
const byId = id => T.stations.find(s => s.id === id);
const slots = (s, min) => s.cap - T.forecast(s, min);
const realStations = () => T.stations.filter(s => !s.temp);
const near = (p, m) => realStations().filter(s => dist(p, s) <= m).sort((a, b) => dist(p, a) - dist(p, b));
const color = n => n >= 5 ? '#0A8BD0' : n >= 1 ? '#F2A83A' : '#B7C1CB';

/* ───────── 구간(leg) 만들기 ───────── */
const Leg = {
  walk: (from, to) => { const raw = walkRaw(from, to); return { t: 'walk', from, to, raw, min: rnd(raw), coords: [[from.lat, from.lng], [to.lat, to.lng]] }; },
  bike: (from, to) => { const raw = bikeRaw(from, to); return { t: 'bike', from, to, raw, min: rnd(raw), m: road(from, to), coords: [[from.lat, from.lng], [to.lat, to.lng]] }; },
  wait: (raw, line, at) => ({ t: 'wait', line, at, raw, min: Math.round(raw), live: false }),
  bus: (line, k, j, raw) => {
    const st = line.stops, step = k < j ? 1 : -1, coords = [];
    for (let x = k; x !== j + step; x += step) coords.push([st[x].lat, st[x].lng]);
    return { t: 'bus', line, from: st[k], to: st[j], raw, min: rnd(raw), coords };
  },
};
function timeline() {      // leg 를 쌓으며 각 leg 의 시작 시각(t0, 분)을 기록
  const legs = []; let t = 0;
  return {
    legs, get t() { return t; },
    push(l) { if (l.t === 'walk' && l.raw < 0.5) return; l.t0 = t; t += l.raw; legs.push(l); },
    done(extra) { return { legs, total: legs.reduce((s, l) => s + l.min, 0), ...extra }; },
  };
}

/* ───────── 모드 1: 타슈 모드 ───────── */
function planTashu(o, d) {
  if (road(o, d) < 350) return { kind: 'walk' };
  const rents = near(o, C.findStationM);
  if (!rents.length || !near(d, C.findStationM).length) return { kind: 'none', msg: '근처에 타슈 대여소가 없어요' };
  // 가장 가까운 곳이 아니라 "도착했을 때 자전거가 있는" 대여소
  const rentOK = rents.filter(s => T.forecast(s, walkRaw(o, s)) >= C.minBikes);
  const rent = rentOK[0] || rents[0];
  const rentAlt = rentOK.find(s => s !== rent) || rents.find(s => s !== rent);
  // 도착 시점에 반납 자리가 있는 대여소 (타는 시간 + 도보 합이 가장 짧은 곳)
  const arrive = s => walkRaw(o, rent) + bikeRaw(rent, s);
  const rets = near(d, C.findStationM).filter(s => s !== rent);
  const retOK = rets.filter(s => slots(s, arrive(s)) >= C.minSlots);
  const pool = (retOK.length ? retOK : rets).sort((a, b) => bikeRaw(rent, a) + walkRaw(a, d) - bikeRaw(rent, b) - walkRaw(b, d));
  const ret = pool[0], retAlt = pool[1];
  if (!ret) return { kind: 'none', msg: '반납할 대여소를 찾지 못했어요' };
  const tl = timeline();
  tl.push(Leg.walk(o, rent));
  const bk = Leg.bike(rent, ret); bk.altFrom = rentAlt; bk.altTo = retAlt; tl.push(bk);
  tl.push(Leg.walk(ret, d));
  return tl.done({ kind: 'tashu' });
}

/* ───────── 모드 2: 타슈+버스 (규칙 기반 혼합 경로) ───────── */
const nearCache = new Map();    // 정류소 → 150m 이내 대여소 (정류소가 많아 캐시)
const stationsNear = s => { const k = s.id + s.lat; if (!nearCache.has(k)) nearCache.set(k, near(s, C.stationNearM).slice(0, 2)); return nearCache.get(k); };

// arr: 승차 정류소 i 에 이 노선 버스가 도착하기까지 남은 분 목록 (실시간). 없으면 배차간격 기반 추정.
function buildBus(line, i, j, so, eo, o, d, now, arr) {
  const st = line.stops, dir = j > i ? 1 : -1, last = line.cum[line.cum.length - 1];
  const ride = (p, q) => Math.abs(line.cum[q] - line.cum[p]);
  const live = !!(arr && arr.length);
  const waitAt = (k, t) => {                          // t: 지금부터 k번 정류장에 도착할 때까지 걸린 분
    if (live) {                                       // 실시간 버스가 i 를 지난 뒤 k 에 닿는 시각들(+ 뒤따르는 배차)
      const last = arr[arr.length - 1];
      for (let n = 0; n < 8; n++) for (const a of n ? [last + n * line.H] : arr) { const x = a + ride(i, k); if (x >= t) return x - t; }
    }
    return mod(line.phase + (dir > 0 ? line.cum[k] : last - line.cum[k] + line.H / 2) - (now + t), line.H);
  };
  const tl = timeline(); let k = i;
  if (so) {
    k = so.k;
    if (T.forecast(so.sA, walkRaw(o, so.sA)) < C.minBikes) return null;
    tl.push(Leg.walk(o, so.sA)); tl.push(Leg.bike(so.sA, so.sB));
    if (slots(so.sB, tl.t) < C.minSlots) return null;
    tl.push(Leg.walk(so.sB, st[k]));
  } else tl.push(Leg.walk(o, st[i]));
  const w = waitAt(k, tl.t);
  const wl = Leg.wait(w, line, st[k]); wl.live = live;
  tl.push(wl);
  tl.push(Leg.bus(line, k, j, ride(k, j)));
  if (eo) {
    if (T.forecast(eo.sC, tl.t + walkRaw(st[j], eo.sC)) < C.minBikes) return null;
    tl.push(Leg.walk(st[j], eo.sC)); tl.push(Leg.bike(eo.sC, eo.sD));
    if (slots(eo.sD, tl.t) < C.minSlots) return null;
    tl.push(Leg.walk(eo.sD, d));
  } else tl.push(Leg.walk(st[j], d));
  return tl.done({ line, so, eo, waitLeg: wl, kind: 'bus' });
}

async function planMixed(o, d) {
  const now = Date.now() / 60000;
  // 1) 노선마다 (승차 i, 하차 j) 후보. 실제 노선은 한 방향 순서라 i < j 여야 한다.
  const cands = [];
  for (const line of T.lines) {
    const st = line.stops, dO = st.map(s => road(o, s)), dD = st.map(s => road(d, s));
    let i = -1, j = -1;
    if (line.oneWay) {
      let bi = -1, cost = Infinity;
      for (let q = 1; q < st.length; q++) {
        if (bi < 0 || dO[q - 1] < dO[bi]) bi = q - 1;
        if (dO[bi] + dD[q] < cost) { cost = dO[bi] + dD[q]; i = bi; j = q; }
      }
    } else { i = dO.indexOf(Math.min(...dO)); j = dD.indexOf(Math.min(...dD)); }
    if (i < 0 || i === j || dO[i] > 1500 || dD[j] > 1500) continue;
    const ride = Math.abs(line.cum[j] - line.cum[i]);
    cands.push({ line, i, j, a: dO[i], b: dD[j], approx: dO[i] / C.walkMpm + line.H / 2 + ride + dD[j] / C.walkMpm });
  }
  if (!cands.length) return { kind: 'none', msg: '근처 버스 노선을 찾지 못했어요. 타슈 모드로 확인해 보세요.' };
  const top = cands.sort((x, y) => x.approx - y.approx).slice(0, 8);

  // 2) 후보 노선의 승차 정류소 실시간 도착 (서버가 없거나 실패하면 null → 추정)
  const arrs = await Promise.all(top.map(c => T.arrivals(c.line.stops[c.i].id, c.line.id)));

  // 3) "버스만" 기준 경로와, 긴 도보·긴 대기를 타슈로 바꾼 혼합 경로
  let base = null, mix = null;
  top.forEach((c, n) => {
    const { line, i, j } = c, st = line.stops, arr = arrs[n], dir = j > i ? 1 : -1;
    const bus = buildBus(line, i, j, null, null, o, d, now, arr);
    if (!base || bus.total < base.total) base = bus;
    const startOpts = [null], endOpts = [null];
    if (c.a >= C.longWalkM || bus.waitLeg.raw >= C.longWaitMin) {       // 규칙: 긴 도보·긴 대기 → 타슈 대체 후보
      const sAs = near(o, C.findStationM).filter(s => s.bikes >= C.minBikes).slice(0, 5);
      for (let k = i + dir; k !== j; k += dir)
        for (const sB of stationsNear(st[k])) for (const sA of sAs) if (sA !== sB) startOpts.push({ sA, sB, k });
    }
    if (c.b >= C.longWalkM)
      for (const sC of stationsNear(st[j])) for (const sD of near(d, C.findStationM).slice(0, 5)) if (sD !== sC) endOpts.push({ sC, sD });
    for (const so of startOpts) for (const eo of endOpts) {
      if (!so && !eo) continue;
      const p = buildBus(line, i, j, so, eo, o, d, now, arr);
      if (p && (!mix || p.total < mix.total)) mix = p;
    }
  });
  if (mix && base.total - mix.total < C.minSaveMin) mix = null;
  if (mix) mix.baseWait = Math.round(base.waitLeg.raw);
  return { kind: 'mixed', base, mix };
}

/* ───────── 자전거 경로 (OSM 기반 공개 OSRM, 실패하면 직선 추정 유지) ───────── */
const pathCache = new Map();
async function bikePath(a, b) {
  const key = [a.lat, a.lng, b.lat, b.lng].join();
  if (pathCache.has(key)) return pathCache.get(key);
  let res = null;
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://routing.openstreetmap.de/routed-bike/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`, { signal: ctl.signal });
    clearTimeout(to);
    const rt = (await r.json()).routes[0];
    res = { coords: rt.geometry.coordinates.map(([x, y]) => [y, x]), m: rt.distance };
  } catch {}
  pathCache.set(key, res);
  return res;
}
async function refine(plan, token) {
  const p = plan.kind === 'mixed' ? (plan.mix || plan.base) : plan;
  if (!p || !p.legs) return;
  let changed = false;
  for (const l of p.legs.filter(x => x.t === 'bike')) {
    const r = await bikePath(l.from, l.to);
    if (token !== state.token) return;
    if (!r) continue;
    l.coords = r.coords; changed = true;
    if (plan.kind === 'tashu') { l.m = r.m; l.raw = r.m / C.bikeMpm + C.rentMin + C.returnMin; l.min = rnd(l.raw); }
  }
  if (changed && token === state.token) { p.total = p.legs.reduce((s, l) => s + l.min, 0); render({ fit: true }); }
}

/* ───────── 지도 ───────── */
const map = L.map('map', { zoomControl: false }).setView(C.center, 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);
const layer = L.layerGroup().addTo(map);
new ResizeObserver(() => map.invalidateSize()).observe($('#stage'));

const mkIcon = (html, w, h, ax, ay) => L.divIcon({ className: 'mk', html, iconSize: [w, h], iconAnchor: [ax, ay] });
const pinIcon = (n, c, sel) => mkIcon(`<div class="pin${sel ? ' sel' : ''}" style="--c:${c}"><b>${n}</b></div>`, 30, 30, 15, 36);
const sqIcon = (t, c) => mkIcon(`<div class="sq" style="--c:${c}">${t}</div>`, 26, 26, 13, 13);
const dotIcon = c => mkIcon(`<div class="dotm" style="--c:${c}"></div>`, 18, 18, 9, 9);
const tagIcon = (t, c) => mkIcon(`<div class="tag" style="--c:${c}">${t}</div>`, 0, 0, 0, 0);
const addMk = (p, icon, onClick) => { const m = L.marker([p.lat, p.lng], { icon }).addTo(layer); if (onClick) m.on('click', onClick); return m; };
const line = (coords, c, w, dash) => L.polyline(coords, { color: c, weight: w, opacity: .9, dashArray: dash, lineCap: 'round' }).addTo(layer);
const fit = pts => { map.invalidateSize(); if (pts.length > 1) map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 }); else if (pts.length) map.setView(pts[0], 16); };

// 대여소가 1,300개 넘으므로 화면 안(확대 14 이상)의 가까운 120개만 그린다
function drawStations() {
  if (map.getZoom() < 14) return;
  const b = map.getBounds().pad(0.1), c = map.getCenter();
  realStations().filter(s => b.contains([s.lat, s.lng])).sort((a, z) => dist(c, a) - dist(c, z)).slice(0, 120)
    .forEach(s => addMk(s, pinIcon(s.bikes, color(s.bikes), s.id === state.sel), () => act('pick', { id: s.id })));
}
map.on('moveend', () => { if (state.tab === 'map' || (state.tab === 'route' && !state.dest)) render(); });

/* ───────── 화면 ───────── */
const sheetBody = $('#sheetBody');
const fcText = (s, min = 30) => { const f = T.forecast(s, min); return s.bikes >= 1 && f <= 1 ? { t: '곧 소진 예상', w: true } : { t: `${min}분 뒤 ${f}대 예상` }; };
const stationRow = (s, sub) => {
  const f = fcText(s), cls = s.bikes >= 5 ? '' : s.bikes >= 1 ? 'o' : 'g';
  return `<div class="st" data-act="pick" data-id="${s.id}"><div class="pin2 ${cls}">${s.bikes}</div>
    <div>${s.name}<br><small>${sub}</small></div>
    <div class="cnt ${s.bikes >= 5 ? '' : 'w'}">${s.bikes}대<small>${f.t}</small></div>
    <button class="star" data-act="fav" data-id="${s.id}" aria-label="즐겨찾기">${state.fav.has(s.id) ? '★' : '☆'}</button></div>`;
};

function render({ fit: doFit = false } = {}) {
  const t = state.tab;
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#top').hidden = !(t === 'map' || t === 'route');
  $('#banner').hidden = t !== 'event';
  $('#stage').hidden = $('#sheet').hidden = t === 'fav';
  $('#fav').hidden = t !== 'fav';
  $$('#seg button').forEach(b => { const on = b.dataset.mode === state.mode; b.classList.toggle('on', on); b.classList.toggle('o', on && state.mode === 'mixed'); });
  $('#from').value = state.origin.name; $('#to').value = state.dest ? state.dest.name : '';
  layer.clearLayers();
  ({ map: viewMap, route: viewRoute, event: viewEvent, fav: viewFav })[t](doFit);
}

/* 1) 지도 · 주변 대여소 */
function viewMap(doFit) {
  drawStations();
  addMk(state.origin, dotIcon('#0A8BD0'));
  const sel = state.sel && byId(state.sel);
  if (sel) {
    const f = [15, 30, 60].map(m => `${m}분 뒤 ${T.forecast(sel, m)}대`).join(' · ');
    sheetBody.innerHTML = `<h3>${sel.name}</h3>
      <div class="big"><b>${sel.bikes}대</b><span>/ ${sel.cap}대 거치</span></div>
      <p class="note">${f}${fcText(sel).w ? ' · <b style="color:#D64545">곧 소진 예상</b>' : ''}</p>
      <div class="btns"><button class="btn" data-act="go" data-id="${sel.id}">여기로 길찾기</button>
      <button class="btn ghost" data-act="fav" data-id="${sel.id}">${state.fav.has(sel.id) ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기'}</button></div>
      <button class="btn ghost" data-act="back">‹ 가까운 대여소 목록</button>`;
    if (doFit) map.flyTo([sel.lat, sel.lng], 16);
  } else {
    const list = realStations().sort((a, b) => dist(state.origin, a) - dist(state.origin, b)).slice(0, 3);
    sheetBody.innerHTML = `<h3>가까운 대여소</h3>` + list.map(s => stationRow(s, `도보 ${rnd(walkRaw(state.origin, s))}분 · ${Math.round(dist(state.origin, s) * C.detour)}m`)).join('') +
      `<p class="note">핀 숫자 = 대여 가능 대수 (파랑 여유 · 주황 부족 · 회색 없음). 지도를 누르면 도착지로 지정돼요.</p>`;
    if (doFit) map.setView([state.origin.lat, state.origin.lng], 15);
  }
}

/* 2·3) 길찾기: 타슈 모드 / 혼합 모드 */
const legClass = { walk: 'walk', bike: 'bike', bus: 'bus', wait: 'wait' };
const legLabel = l => l.min < 3 ? '' : l.t === 'bike' ? `🚲 타슈 ${l.min}분` : l.t === 'bus' ? `🚌 ${l.line.name}번 ${l.min}분` : l.t === 'wait' ? `⏳${l.min}` : `${l.min}분`;
const legsBar = legs => `<div class="legs">${legs.filter(l => l.min >= 1).map(l => `<div class="${legClass[l.t]}" style="flex:${l.min}" title="${l.min}분">${legLabel(l)}</div>`).join('')}</div>`;

function stepsOf(p) {
  const out = [], legs = p.legs;
  legs.forEach((l, n) => {
    const here = { lat: l.from?.lat ?? l.at?.lat, lng: l.from?.lng ?? l.at?.lng };
    if (l.t === 'walk') {
      out.push({ ic: '🚶', cls: '', at: here, html: `도보 ${l.min}분 → <b>${l.to.name}</b>` });
    } else if (l.t === 'bike') {
      const f = T.forecast(l.from, l.t0), r = slots(l.to, l.t0 + l.raw);
      const sub = [`지금 ${l.from.bikes}대 · 도착 시 ${f}대 예상`, r >= C.minSlots ? '반납 여유 있음' : '반납 자리 적음',
        l.altTo ? `대안 반납: ${l.altTo.name} (도보 ${rnd(walkRaw(l.altTo, state.dest))}분)` : ''].filter(Boolean).join(' · ');
      out.push({ ic: '🚲', cls: 'b', at: here, html: `<b>${l.from.name}</b> 대여 → <b>${l.to.name}</b> 반납 · ${l.min}분${f < C.minBikes ? ' <span class="chip r">재고 적음</span>' : ''}<small>${sub}</small>` });
    } else if (l.t === 'bus') {
      const w = legs[n - 1]?.t === 'wait' ? legs[n - 1] : null, wm = w ? w.min : 0;
      const extra = p.baseWait != null && p.so ? `원래 정류장에선 다음 버스 ${p.baseWait}분 후` : `${l.from.name} 승차`;
      out.push({ ic: '🚌', cls: 'o', at: here, html: `<b>${l.line.name}번</b> ${wm}분 후 도착 <span class="chip ${w?.live ? 'b' : 'o'}">${w?.live ? '실시간' : '추정'}</span><small>${extra} → ${l.to.name} 하차 · ${l.min}분</small>` });
    }
  });
  return out;
}
const stepsHtml = (steps, cur = -1) => `<ul class="steps">${steps.map((s, i) => `<li class="${i === cur ? 'cur' : ''}"><span class="ic ${s.cls}">${s.ic}</span><div>${s.html}</div></li>`).join('')}</ul>`;

function drawPlan(p, o, d) {
  const pts = [[o.lat, o.lng], [d.lat, d.lng]];
  p.legs.forEach(l => {
    if (l.t === 'wait') return;
    if (l.t === 'walk') line(l.coords, '#9AA6B2', 4, '2 8');
    if (l.t === 'bike') { line(l.coords, '#0A8BD0', 7); addMk(l.from, sqIcon('🚲', '#0A8BD0')); addMk(l.to, sqIcon('P', '#F2A83A')); }
    if (l.t === 'bus') { line(l.coords, '#F2A83A', 7); addMk(l.from, sqIcon('🚌', '#F2A83A')); addMk(l.to, sqIcon('🚌', '#F2A83A')); }
    l.coords.forEach(c => pts.push(c));
  });
  addMk(o, dotIcon('#0A8BD0')); addMk(d, dotIcon('#F2A83A'));
  return pts;
}

function viewRoute(doFit) {
  const p = state.plan, o = state.origin, d = state.dest;
  if (!d) {
    sheetBody.innerHTML = `<div class="empty">도착지를 입력하거나 지도를 눌러 선택하세요<div class="tags">${T.places.map(x => `<button data-act="place" data-name="${x.name}">${x.name}</button>`).join('')}</div></div>`;
    drawStations();
    addMk(o, dotIcon('#0A8BD0')); if (doFit) fit([[o.lat, o.lng]]);
    return;
  }
  if (state.loading) {
    sheetBody.innerHTML = `<div class="empty">⏳ 버스 도착정보를 불러오는 중…</div>`;
    addMk(o, dotIcon('#0A8BD0')); addMk(d, dotIcon('#F2A83A')); if (doFit) fit([[o.lat, o.lng], [d.lat, d.lng]]);
    return;
  }
  if (!p || p.kind === 'walk' || p.kind === 'none') {
    sheetBody.innerHTML = `<div class="empty">${p?.kind === 'walk' ? '🚶 가까워서 걸어가는 게 빨라요' : (p?.msg || '경로를 찾지 못했어요')}</div>`;
    addMk(o, dotIcon('#0A8BD0')); addMk(d, dotIcon('#F2A83A')); if (doFit) fit([[o.lat, o.lng], [d.lat, d.lng]]);
    return;
  }
  const shown = p.kind === 'mixed' ? (p.mix || p.base) : p;
  const pts = drawPlan(shown, o, d);
  if (doFit) fit(pts);
  const steps = stepsOf(shown);

  if (state.guide != null) {                       // 안내 시작
    const g = state.guide;
    sheetBody.innerHTML = `<div class="big"><b>${g + 1}/${steps.length}</b><span>단계 · 총 ${shown.total}분</span></div>${stepsHtml(steps, g)}
      <div class="btns"><button class="btn ghost" data-act="gprev" ${g === 0 ? 'disabled' : ''}>‹ 이전</button>
      <button class="btn ${p.kind === 'mixed' ? 'o' : ''}" data-act="gnext">${g === steps.length - 1 ? '도착 완료' : '다음 ›'}</button></div>`;
    return;
  }
  if (p.kind === 'tashu') {
    const bk = shown.legs.find(l => l.t === 'bike');
    const warn = T.forecast(bk.from, bk.t0) < C.minBikes ? `<div class="alert">⚠ 출발 대여소 재고가 적어요</div>` : '';
    const head = `<div class="big"><b>${shown.total}분</b><span>· ${(bk.m / 1000).toFixed(1)}km · 도착 ${hhmm(shown.total)}</span></div>`;
    sheetBody.innerHTML = `${warn}${head}${legsBar(shown.legs)}${stepsHtml(steps)}<button class="btn" data-act="guide">안내 시작</button>`;
  } else {
    const cmp = `<div class="cmp"><div class="a"><small>🚌 버스만</small><b>${p.base.total}분</b><small>대기 ${Math.round(p.base.waitLeg.raw)}분 포함</small></div>` +
      (p.mix ? `<div class="w"><small>🚲+🚌 추천</small><b>${p.mix.total}분</b><small>도착 ${hhmm(p.mix.total)}</small></div>` : '') + `</div>`;
    if (p.mix) sheetBody.innerHTML = `${cmp}<div class="save">⏱ 타슈를 섞으면 ${p.base.total - p.mix.total}분 빨라요</div>${legsBar(p.mix.legs)}${stepsHtml(steps)}<button class="btn o" data-act="guide">이 경로로 안내</button>`;
    else sheetBody.innerHTML = `${cmp}<p class="note">지금은 타슈를 섞어도 ${C.minSaveMin}분 이상 줄지 않아요. 버스만 이용하는 편이 좋아요. (긴 대기·긴 도보가 생기면 자동으로 혼합 경로를 제안해요)</p>${legsBar(p.base.legs)}${stepsHtml(steps)}
      <div class="btns"><button class="btn o" data-act="guide">버스로 안내</button><button class="btn ghost" data-act="mode" data-mode="tashu">타슈 모드로 보기</button></div>`;
  }
}

/* 4) 행사 모드 */
function viewEvent(doFit) {
  const ev = T.events[state.ev], venue = { name: ev.title, lat: ev.lat, lng: ev.lng }, zone = byId(ev.zone);
  const diff = Math.round((ev.start - Date.now()) / 60000);
  const day = ev.start.getDate() === new Date().getDate() ? '오늘' : '내일';
  const status = diff > 0 ? `${day} ${hhmm(diff)} 시작` : '진행 중';
  $('#banner').innerHTML = `<b>${ev.emoji} ${ev.title} <small>(예시)</small></b><small>${status} · 주변 버스 혼잡 예상</small><img src="assets/bike.jpg" alt="">`;

  L.circle([ev.lat, ev.lng], { radius: ev.radius, color: '#F2A83A', weight: 2, dashArray: '5 5', fillColor: '#F2A83A', fillOpacity: .16 }).addTo(layer);
  addMk(venue, sqIcon(ev.emoji, '#F2A83A'));
  addMk(zone, tagIcon(state.after ? `대여 ${ev.afterBikes}대` : '임시 반납존', '#0068A8'));
  const hubs = ev.hubs.map(h => ({ ...h, s: byId(h.id) })).filter(h => h.s);
  hubs.forEach(h => {
    line([[h.s.lat, h.s.lng], [ev.lat, ev.lng]], state.after ? '#F2A83A' : '#0A8BD0', 5, state.after ? '8 8' : null);
    addMk(h.s, tagIcon(state.after ? `→ ${h.s.name}` : `${h.s.name} ${h.ready}대`, state.after ? '#E08A12' : '#0A8BD0'));
  });
  if (doFit) fit([[ev.lat, ev.lng], ...hubs.map(h => [h.s.lat, h.s.lng])]);

  const chips = `<div class="chips" style="margin:0 0 8px">${T.events.map((e, i) => `<button class="${i === state.ev ? 'on' : ''}" data-act="ev" data-i="${i}">${e.emoji} ${e.short}</button>`).join('')}</div>`;
  const rows = hubs.map(h => {
    const m = rnd(bikeRaw(h.s, ev) - C.returnMin);
    return state.after
      ? `<div class="st"><div class="pin2 o">🚇</div><div>행사장 → ${h.s.name}<br><small>타슈 ${m}분 · 반납 가능</small></div><div class="cnt w">${m}분</div></div>`
      : `<div class="st"><div class="pin2">🚇</div><div>${h.s.name} → 행사장<br><small>타슈 ${m}분 · ${h.ready}대 준비됨</small></div><div class="cnt">${m}분</div></div>`;
  }).join('');
  const zoneRow = `<div class="st"><div class="pin2 o">P</div><div>${zone.name}<br><small>${state.after ? `행사 후 대여 가능 ${ev.afterBikes}대` : '반납 여유 많음 · 행사 후 대여 가능'}</small></div><div class="cnt w">${state.after ? ev.afterBikes + '대' : '여유'}</div></div>`;
  sheetBody.innerHTML = chips +
    (state.after ? `<div class="alert b">🏁 행사 종료 후 · 역·주거지 방향으로 나눠 이동하세요</div>` : `<div class="alert">🚌 행사장행 버스 만차 예상 · 타슈 이용을 추천해요</div>`) +
    rows + zoneRow +
    `<button class="btn o" data-act="after">${state.after ? '‹ 행사 전 안내로' : '행사 끝나고 귀가 경로 미리 보기'}</button>`;
}

/* 5) 즐겨찾기 */
function viewFav() {
  const list = [...state.fav].map(byId).filter(Boolean);
  $('#fav').innerHTML = `<h3>즐겨찾는 대여소</h3>` + (list.length
    ? list.map(s => stationRow(s, `${s.cap}대 거치`)).join('')
    : `<div class="empty">⭐ 아직 없어요<br>지도에서 대여소를 눌러 ☆를 눌러보세요</div>`);
}

/* ───────── 동작 ───────── */
async function compute() {
  const token = ++state.token; state.guide = null;
  const o = state.origin, d = state.dest;
  if (!d) { state.plan = null; state.loading = false; return render({ fit: true }); }
  if (state.mode === 'tashu') { state.loading = false; state.plan = planTashu(o, d); }
  else {
    state.plan = null; state.loading = true; render({ fit: true });
    try { state.plan = await planMixed(o, d); } catch (e) { console.error(e); state.plan = { kind: 'none', msg: '경로 계산 중 오류가 났어요' }; }
    if (token !== state.token) return;
    state.loading = false;
  }
  render({ fit: true });
  if (state.plan) refine(state.plan, token);
}
function setTab(t, doFit = true) { state.tab = t; if (t === 'route') return compute(); state.token++; render({ fit: doFit }); }
function setPoint(field, pt) {
  state[field === 'from' ? 'origin' : 'dest'] = pt;
  if (field === 'to' || state.dest) { state.tab = 'route'; compute(); } else render({ fit: true });
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2600); }
function locate() {
  if (!navigator.geolocation) return toast('이 브라우저는 위치를 지원하지 않아요 (데모 위치 사용)');
  navigator.geolocation.getCurrentPosition(p => {
    const pt = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (dist(pt, { lat: C.center[0], lng: C.center[1] }) > 25000) return toast('대전 밖이라 데모 위치(궁동)를 사용해요');
    setPoint('from', { name: '현재 위치', ...pt });
  }, () => toast('위치 권한이 없어 데모 위치(궁동)를 사용해요'), { timeout: 6000 });
}

function act(a, d = {}) {
  switch (a) {
    case 'fold': $('#sheet').classList.toggle('fold'); break;
    case 'pick': state.sel = d.id; state.tab = 'map'; render({ fit: true }); break;
    case 'back': state.sel = null; render({ fit: true }); break;
    case 'fav': state.fav.has(d.id) ? state.fav.delete(d.id) : state.fav.add(d.id); saveFav(); render(); break;
    case 'go': { const s = byId(d.id); setPoint('to', { name: s.name, lat: s.lat, lng: s.lng }); break; }
    case 'place': { const p = T.places.find(x => x.name === d.name); setPoint('to', p); break; }
    case 'mode': state.mode = d.mode; if (state.tab === 'route') compute(); else render(); break;
    case 'guide': state.guide = 0; render({ fit: false }); focusStep(); break;
    case 'gnext': { const n = stepsOf(state.plan.kind === 'mixed' ? (state.plan.mix || state.plan.base) : state.plan).length;
      if (state.guide >= n - 1) { state.guide = null; toast('도착했어요! 🎉'); render({ fit: true }); } else { state.guide++; render(); focusStep(); } break; }
    case 'gprev': state.guide = Math.max(0, state.guide - 1); render(); focusStep(); break;
    case 'ev': state.ev = +d.i; state.after = false; render({ fit: true }); break;
    case 'after': state.after = !state.after; render({ fit: true }); break;
  }
}
function focusStep() {
  const p = state.plan; if (!p || state.guide == null) return;
  const s = stepsOf(p.kind === 'mixed' ? (p.mix || p.base) : p)[state.guide];
  if (s) map.flyTo([s.at.lat, s.at.lng], 17);
}

/* ───────── 이벤트 연결 ───────── */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  e.stopPropagation(); act(b.dataset.act, b.dataset);
});
$$('.tabbar button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$$('#seg button').forEach(b => b.onclick = () => act('mode', { mode: b.dataset.mode }));
$('#info').onclick = () => $('#about').showModal();
$('#loc').onclick = locate;
$('#swap').onclick = () => {
  if (!state.dest) return;
  [state.origin, state.dest] = [state.dest, state.origin]; compute();
};

// 검색 자동완성 (장소 + 대여소 이름)
const sugg = $('#sugg');
const candidates = () => [...T.places, ...realStations().map(s => ({ name: s.name, lat: s.lat, lng: s.lng, station: true }))];
function showSugg(field) {
  const q = $('#' + field).value.trim(), hit = candidates().filter(c => !q || c.name.includes(q)).slice(0, 8);
  const items = (field === 'from' ? [{ me: true, name: '현재 위치' }] : []).concat(hit);
  sugg.innerHTML = items.map((c, i) => `<li data-i="${i}">${c.me ? '📍' : c.station ? '🚲' : '📌'} ${c.name}<small>${c.me ? 'GPS' : c.station ? '대여소' : ''}</small></li>`).join('');
  sugg._items = items; sugg._field = field; sugg.hidden = !items.length;
}
['from', 'to'].forEach(f => {
  const el = $('#' + f);
  el.addEventListener('focus', () => { state.field = f; el.select(); showSugg(f); });
  el.addEventListener('input', () => showSugg(f));
  el.addEventListener('blur', () => setTimeout(() => sugg.hidden = true, 150));
});
sugg.addEventListener('pointerdown', e => {
  e.preventDefault();
  const li = e.target.closest('li'); if (!li) return;
  const c = sugg._items[+li.dataset.i]; sugg.hidden = true; document.activeElement.blur();
  if (c.me) return locate();
  setPoint(sugg._field, { name: c.name, lat: c.lat, lng: c.lng });
});

// 지도 클릭 → 마지막으로 선택한 입력칸(기본: 도착지) 지정
map.on('click', e => {
  if (state.tab !== 'map' && state.tab !== 'route') return;
  setPoint(state.field, { name: '지도에서 선택한 위치', lat: e.latlng.lat, lng: e.latlng.lng });
});

const setPill = () => { $('.sample').textContent = !T.flags.realLines ? '재고·버스 샘플' : T.flags.liveBikes ? '대수 실시간' : '재고 추정값'; };
async function refreshLive() {                          // 타슈 실시간 대수 (키가 없으면 조용히 추정값 유지)
  if (!(await T.liveBikes())) return;
  setPill();
  if (state.tab === 'map' || state.tab === 'fav') render();
}
T.load().then(() => {
  setPill();
  render({ fit: true });
  refreshLive();
  setInterval(() => { if (!document.hidden) refreshLive(); }, 60000);
});
