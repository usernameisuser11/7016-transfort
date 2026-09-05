import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const APP_VERSION = String(packageJson.version || '0.9.0');
const SERVICE_KEY = String(process.env.DATA_GO_KR_SERVICE_KEY || '').trim();
const PASSENGER_PROFILE_FILE = process.env.PASSENGER_PROFILE_FILE || 'data/7016-passenger-profile.json';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const BUS_API = 'http://ws.bus.go.kr/api/rest';
const SEOUL_TIME_ZONE = 'Asia/Seoul';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

const ROUTES = {
  '종로13': { label: '종로13', historical: false, suggested: /상명대입구|홍지파크/ },
  '서대문08': { label: '서대문08', historical: false, suggested: /홍은초등학교|홍지문35통/ },
  '7016': { label: '7016', historical: true, suggested: /경복궁역.*3번출구/ }
};
const ROUTE_LIST = Object.keys(ROUTES);

app.use(express.json({ limit: '64kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static('public', {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '10m' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const fallback7016Stops = JSON.parse(fs.readFileSync('data/7016-schoolbound-stops.json', 'utf8'));
let passengerProfile = null;

function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function firstDefined(...v) { return v.find(x => x !== undefined && x !== null && x !== ''); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function normName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\(\s*\d+\s*\)\s*$/g, '')
    .replace(/\s+/g, '')
    .replace(/[()_\-]/g, '')
    .toLowerCase();
}
function normalizeRouteName(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}
function resolveRouteName(value) {
  const normalized = normalizeRouteName(value || '7016');
  return ROUTE_LIST.find(route => normalizeRouteName(route) === normalized) || null;
}
function seoulHour(date = new Date()) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: SEOUL_TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(date);
  return Number(value);
}
function daysInSourceMonth(sourceMonth) {
  const m = String(sourceMonth || '').match(/^(\d{4})[-.]?(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function cloneProfile(p) {
  return { ...p, hours: Array.isArray(p?.hours) ? p.hours.map(h => ({ ...h })) : [] };
}

function preparePassengerProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const byId = profile.byId || {};
  if (!profile.valueBasis) {
    const groups = new Map();
    for (const p of Object.values(byId)) {
      const key = normName(p?.stopName);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const aggregate = group.find(p => p?.ambiguousName === true);
      if (!aggregate) continue;
      const others = group.filter(p => p !== aggregate);
      aggregate.hours = (aggregate.hours || []).map((h, i) => {
        const otherBoard = others.reduce((sum, p) => sum + Number(p.hours?.[i]?.board || 0), 0);
        const otherAlight = others.reduce((sum, p) => sum + Number(p.hours?.[i]?.alight || 0), 0);
        const board = Math.max(0, Number(h.board || 0) - otherBoard);
        const alight = Math.max(0, Number(h.alight || 0) - otherAlight);
        return { hour: Number(h.hour ?? i), board, alight, net: board - alight };
      });
      delete aggregate.ambiguousName;
    }
  }
  const byName = {};
  for (const p of Object.values(byId)) {
    const key = normName(p?.stopName);
    if (!key) continue;
    if (!byName[key]) {
      byName[key] = cloneProfile(p);
      continue;
    }
    const aggregate = byName[key];
    aggregate.ambiguousName = true;
    for (let i = 0; i < 24; i++) {
      const board = Number(aggregate.hours?.[i]?.board || 0) + Number(p.hours?.[i]?.board || 0);
      const alight = Number(aggregate.hours?.[i]?.alight || 0) + Number(p.hours?.[i]?.alight || 0);
      aggregate.hours[i] = { hour: i, board, alight, net: board - alight };
    }
  }
  profile.byName = byName;
  return profile;
}
function reloadPassengerProfile() {
  try {
    const loaded = JSON.parse(fs.readFileSync(PASSENGER_PROFILE_FILE, 'utf8'));
    passengerProfile = preparePassengerProfile(loaded);
  } catch (err) {
    console.error('Passenger profile load error:', err.message);
    passengerProfile = null;
  }
}
reloadPassengerProfile();

const cache = new Map();
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) { cache.set(key, { at: Date.now(), value }); }

function xmlItems(xml) {
  const parsed = parser.parse(xml);
  const result = parsed?.ServiceResult;
  const header = result?.msgHeader || {};
  if (String(header.headerCd ?? '0') !== '0') throw new Error(header.headerMsg || '서울시 버스 API 오류');
  return asArray(result?.msgBody?.itemList);
}
async function busFetch(pathname, params = {}, ttlMs = 15000) {
  if (!SERVICE_KEY) throw new Error('NO_SERVICE_KEY');
  const qs = new URLSearchParams({ ServiceKey: SERVICE_KEY, ...params });
  const url = `${BUS_API}/${pathname}?${qs}`;
  const cached = cacheGet(url, ttlMs);
  if (cached) return cached;
  const res = await fetch(url, { headers: { 'User-Agent': `smu-campus-bus/${APP_VERSION}` } });
  if (!res.ok) throw new Error(`서울 버스 API HTTP ${res.status}`);
  const items = xmlItems(await res.text());
  cacheSet(url, items);
  return items;
}
async function getRoute(routeName) {
  const allowed = resolveRouteName(routeName);
  if (!allowed) throw new Error('지원하지 않는 노선입니다.');
  const routes = await busFetch('busRouteInfo/getBusRouteList', { strSrch: allowed }, 21600000);
  const exact = routes.find(r => normalizeRouteName(r.busRouteNm) === normalizeRouteName(allowed));
  if (!exact) throw new Error(`${allowed} 노선을 찾지 못했습니다.`);
  return exact;
}
async function getStations(routeId) {
  const rows = await busFetch('busRouteInfo/getStaionByRoute', { busRouteId: routeId }, 21600000);
  return rows.map((s, idx) => ({
    seq: toNumber(firstDefined(s.seq, s.stationSeq, s.ord), idx + 1),
    station: String(firstDefined(s.station, s.stationId, s.stId, '')),
    stationNm: String(firstDefined(s.stationNm, s.stNm, `정류장 ${idx + 1}`)),
    arsId: String(firstDefined(s.arsId, '')),
    gpsX: toNumber(firstDefined(s.gpsX, s.tmX)),
    gpsY: toNumber(firstDefined(s.gpsY, s.tmY))
  })).sort((a, b) => a.seq - b.seq);
}
function schoolDestinationSeqs(stations) {
  return stations.filter(s => /상명대정문/.test(s.stationNm)).map(s => Number(s.seq)).filter(Number.isFinite).sort((a, b) => a - b);
}
function commuteStations(stations) {
  const destinationSeqs = schoolDestinationSeqs(stations);
  if (!destinationSeqs.length) throw new Error('이 노선에서 상명대정문 정류장을 찾지 못했습니다.');
  const maxDestination = destinationSeqs.at(-1);
  return { stations: stations.filter(s => s.seq <= maxDestination), destinationSeqs };
}
function nextDestinationSeq(destinationSeqs, boardOrd) {
  return destinationSeqs.find(seq => seq > boardOrd) ?? null;
}
function normalizeArrival(a) {
  return {
    stId: String(firstDefined(a.stId, a.station, '')),
    arsId: String(firstDefined(a.arsId, '')),
    stationNm: String(firstDefined(a.stNm, a.stationNm, '')),
    ord: toNumber(firstDefined(a.ord, a.seq)),
    term: toNumber(a.term),
    arrmsg1: String(firstDefined(a.arrmsg1, '정보 없음')),
    arrmsg2: String(firstDefined(a.arrmsg2, '정보 없음')),
    traTime1: toNumber(a.traTime1),
    traTime2: toNumber(a.traTime2),
    vehId1: String(firstDefined(a.vehId1, '')),
    vehId2: String(firstDefined(a.vehId2, '')),
    plainNo1: String(firstDefined(a.plainNo1, '')),
    plainNo2: String(firstDefined(a.plainNo2, '')),
    isFullFlag1: toNumber(a.isFullFlag1, 0),
    isFullFlag2: toNumber(a.isFullFlag2, 0),
  };
}
function congestionMeta(code, fullFlag = 0) {
  if (Number(fullFlag) === 1) return { code: 7, label: '만차', level: 'very-busy' };
  return ({
    0: { code: 0, label: '정보 없음', level: 'unknown' },
    3: { code: 3, label: '여유', level: 'easy' },
    4: { code: 4, label: '보통', level: 'normal' },
    5: { code: 5, label: '혼잡', level: 'busy' },
    6: { code: 6, label: '매우 혼잡', level: 'very-busy' }
  })[Number(code || 0)] || { code: Number(code || 0), label: '정보 없음', level: 'unknown' };
}

function haversineKm(a, b) {
  const lat1 = Number(a?.gpsY), lon1 = Number(a?.gpsX);
  const lat2 = Number(b?.gpsY), lon2 = Number(b?.gpsX);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function routeDistanceKm(stations, boardOrd, destOrd) {
  const segment = stations.filter(s => s.seq >= boardOrd && s.seq <= destOrd).sort((a, b) => a.seq - b.seq);
  if (segment.length < 2) return null;
  let total = 0;
  for (let i = 1; i < segment.length; i++) {
    const d = haversineKm(segment[i - 1], segment[i]);
    if (d == null || d > 5) return null;
    total += d;
  }
  return total > 0 ? total : null;
}
function routeEstimateSeconds(stations, boardOrd, destOrd) {
  const stopGap = Math.max(1, destOrd - boardOrd);
  const distanceKm = routeDistanceKm(stations, boardOrd, destOrd);
  if (distanceKm == null) return stopGap * 115;
  const raw = (distanceKm / 15) * 3600 + stopGap * 20;
  return Math.round(clamp(raw, stopGap * 55, stopGap * 240));
}
function vehicleEtaAt(arrival, vehId) {
  if (!arrival || !vehId) return null;
  if (arrival.vehId1 === vehId) return arrival.traTime1;
  if (arrival.vehId2 === vehId) return arrival.traTime2;
  return null;
}
function estimateDestinationTravel(board, arrivals, idx, stations, boardOrd, destOrd) {
  const vehId = idx === 1 ? board.vehId1 : board.vehId2;
  const boardEta = idx === 1 ? board.traTime1 : board.traTime2;
  if (!vehId || boardEta == null) return { seconds: routeEstimateSeconds(stations, boardOrd, destOrd), source: 'route-estimate' };
  const candidates = arrivals
    .filter(a => a.ord != null && a.ord > boardOrd && a.ord <= destOrd)
    .map(a => ({ ord: a.ord, eta: vehicleEtaAt(a, vehId) }))
    .filter(x => x.eta != null && x.eta >= boardEta)
    .sort((a, b) => a.ord - b.ord);
  const destinationMatch = candidates.find(x => x.ord === destOrd);
  if (destinationMatch) return { seconds: Math.max(0, destinationMatch.eta - boardEta), source: 'vehicle-match' };
  const routeBase = routeEstimateSeconds(stations, boardOrd, destOrd);
  const farthest = candidates.at(-1);
  if (!farthest) return { seconds: routeBase, source: 'route-estimate' };
  const coveredStops = farthest.ord - boardOrd;
  const observedRide = Math.max(0, farthest.eta - boardEta);
  if (coveredStops <= 0 || observedRide <= 0) return { seconds: routeBase, source: 'route-estimate' };
  const secondsPerStop = clamp(observedRide / coveredStops, 50, 240);
  const remainingStops = Math.max(0, destOrd - farthest.ord);
  const extrapolated = observedRide + remainingStops * secondsPerStop;
  const blended = extrapolated * 0.7 + routeBase * 0.3;
  const stopGap = Math.max(1, destOrd - boardOrd);
  const bounded = clamp(blended, Math.max(stopGap * 45, routeBase * 0.55), Math.max(stopGap * 240, routeBase * 1.8));
  return { seconds: Math.round(bounded), source: 'vehicle-extrapolation' };
}
function makeBusCard(board, arrivals, positions, idx, stations, boardOrd, destOrd) {
  const vehId = idx === 1 ? board.vehId1 : board.vehId2;
  const etaSec = idx === 1 ? board.traTime1 : board.traTime2;
  const arrMsg = idx === 1 ? board.arrmsg1 : board.arrmsg2;
  const plainNo = idx === 1 ? board.plainNo1 : board.plainNo2;
  const full = idx === 1 ? board.isFullFlag1 : board.isFullFlag2;
  const pos = positions.find(p => String(p.vehId) === vehId);
  const congestion = congestionMeta(firstDefined(pos?.congetion, 0), firstDefined(pos?.isFullFlag, full, 0));
  const estimate = estimateDestinationTravel(board, arrivals, idx, stations, boardOrd, destOrd);
  const rideSec = estimate.seconds;
  return {
    index: idx,
    vehId,
    plainNo: plainNo || String(pos?.plainNo || ''),
    etaSec,
    arrMsg,
    congestion,
    lowFloor: Number(pos?.busType) === 1,
    sectionOrd: toNumber(pos?.sectOrd),
    destinationRideSec: rideSec,
    destinationEtaSec: etaSec == null ? null : etaSec + rideSec,
    destinationEtaSource: estimate.source
  };
}
function recommendation(first, second, historical) {
  if (!first || first.etaSec == null) return { action: 'WAIT', title: '도착 정보를 기다리는 중', reason: '첫 번째 차량 ETA가 아직 없습니다.' };
  if (!second || second.etaSec == null) return { action: 'TAKE_NOW', title: '이번 버스 타기', reason: '다음 차량 정보가 없어 현재 차량을 추천합니다.' };
  const gap = Math.max(0, second.etaSec - first.etaSec);
  const firstBad = ['busy', 'very-busy'].includes(first.congestion.level);
  const secondGood = ['easy', 'normal'].includes(second.congestion.level);
  if (firstBad && secondGood && gap <= 360) return { action: 'WAIT_NEXT', title: '다음 버스 추천', reason: `첫 차는 ${first.congestion.label}이고 다음 차까지 약 ${Math.max(1, Math.round(gap / 60))}분입니다.` };
  if (first.congestion.level === 'very-busy' && gap <= 480) return { action: 'WAIT_NEXT', title: '다음 버스 고려', reason: `첫 차가 ${first.congestion.label}이고 다음 차가 약 ${Math.max(1, Math.round(gap / 60))}분 뒤입니다.` };
  const histNote = historical?.level === 'high' ? ' 이 시간대 승차 수요도 높은 편입니다.' : '';
  return { action: 'TAKE_NOW', title: '이번 버스 타기', reason: `다음 차와 약 ${Math.max(1, Math.round(gap / 60))}분 차이라 지금 타는 편이 빠릅니다.${histNote}` };
}

function historicalForStation(station, routeName) {
  if (routeName !== '7016') return { available: false, routeUnsupported: true, routeName };
  if (!passengerProfile) return null;
  const byId = passengerProfile.byId || {};
  const byName = passengerProfile.byName || {};
  const exact = byId[String(station.station || '')];
  const named = byName[normName(station.stationNm)];
  const p = exact || named;
  if (!p) return { available: false, sourceMonth: passengerProfile.sourceMonth || null, sourceFile: passengerProfile.sourceFile || null };
  const days = Number(passengerProfile.daysInMonth) || daysInSourceMonth(passengerProfile.sourceMonth) || 1;
  const divisor = passengerProfile.valueBasis === 'daily-average' ? 1 : days;
  const hours = (p.hours || []).map((x, hour) => {
    const board = Number(x.board || 0) / divisor;
    const alight = Number(x.alight || 0) / divisor;
    return { hour: Number(x.hour ?? hour), board, alight, net: board - alight };
  });
  const hour = seoulHour();
  const h = hours[hour] || { hour, board: 0, alight: 0, net: 0 };
  const maxBoard = Math.max(1, ...hours.map(x => Number(x.board || 0)));
  const ratio = Number(h.board || 0) / maxBoard;
  const level = ratio >= .72 ? 'high' : ratio >= .38 ? 'medium' : 'low';
  return {
    available: true,
    match: exact ? 'station-id' : 'station-name',
    ambiguousName: Boolean(p.ambiguousName && !exact),
    sourceMonth: passengerProfile.sourceMonth || null,
    sourceFile: passengerProfile.sourceFile || null,
    valueBasis: 'daily-average',
    daysInMonth: days,
    hour,
    board: Number(h.board || 0),
    alight: Number(h.alight || 0),
    net: Number(h.net || 0),
    level,
    hours
  };
}

function suggestedBoarding(stations, destinationSeqs, routeName) {
  const boardable = stations.filter(s => !/상명대정문/.test(s.stationNm) && nextDestinationSeq(destinationSeqs, s.seq) != null);
  const regex = ROUTES[routeName]?.suggested;
  const preferred = regex ? boardable.find(s => regex.test(s.stationNm)) : null;
  if (preferred) return preferred;
  const firstDestination = destinationSeqs[0];
  const beforeFirst = boardable.filter(s => s.seq < firstDestination);
  return beforeFirst[Math.max(0, beforeFirst.length - 4)] || boardable[0];
}
function demoBootstrap() {
  return {
    mode: 'demo',
    routes: ROUTE_LIST,
    selectedRoute: '7016',
    route: { busRouteId: 'DEMO-7016', busRouteNm: '7016', stStationNm: '은평공영차고지', edStationNm: '상명대정문', term: 9 },
    stations: fallback7016Stops,
    stopCount: fallback7016Stops.length,
    suggestedBoardingSeq: fallback7016Stops.find(s => /경복궁역3번출구/.test(s.stationNm))?.seq || 47,
    destinationSeq: fallback7016Stops.length,
    destinationSeqs: [fallback7016Stops.length],
    passengerData: { available: Boolean(passengerProfile), sourceMonth: passengerProfile?.sourceMonth || null },
    geminiConfigured: Boolean(GEMINI_API_KEY)
  };
}

app.get('/api/bootstrap', async (req, res) => {
  const routeName = resolveRouteName(req.query.route || '7016');
  if (!routeName) return res.status(400).json({ error: '지원하지 않는 노선입니다.' });
  if (!SERVICE_KEY) {
    if (routeName === '7016') return res.json(demoBootstrap());
    return res.status(503).json({ error: `${routeName}은 실시간 API 연결이 필요합니다.` });
  }
  try {
    const route = await getRoute(routeName);
    const all = await getStations(String(route.busRouteId));
    const commute = commuteStations(all);
    const suggested = suggestedBoarding(commute.stations, commute.destinationSeqs, routeName);
    const initialDestination = suggested ? nextDestinationSeq(commute.destinationSeqs, suggested.seq) : commute.destinationSeqs[0];
    res.json({
      mode: 'live',
      routes: ROUTE_LIST,
      selectedRoute: routeName,
      route: {
        busRouteId: String(route.busRouteId),
        busRouteNm: String(route.busRouteNm || routeName),
        stStationNm: String(route.stStationNm || ''),
        edStationNm: String(route.edStationNm || ''),
        term: toNumber(route.term),
        firstBusTm: String(route.firstBusTm || ''),
        lastBusTm: String(route.lastBusTm || '')
      },
      stations: commute.stations,
      stopCount: commute.stations.length,
      suggestedBoardingSeq: suggested?.seq ?? commute.stations[0]?.seq,
      destinationSeq: initialDestination,
      destinationSeqs: commute.destinationSeqs,
      passengerData: { available: routeName === '7016' && Boolean(passengerProfile), sourceMonth: routeName === '7016' ? passengerProfile?.sourceMonth || null : null },
      geminiConfigured: Boolean(GEMINI_API_KEY)
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || 'bootstrap 실패' });
  }
});

function demoDashboard(boardOrd, destOrd) {
  const board = fallback7016Stops.find(s => s.seq === boardOrd) || fallback7016Stops[46];
  const dest = fallback7016Stops.find(s => s.seq === destOrd) || fallback7016Stops.at(-1);
  const hist = passengerProfile ? historicalForStation(board, '7016') : null;
  const buses = [
    { index: 1, vehId: 'demo-1', plainNo: '서울74사7016', etaSec: 210, arrMsg: '약 3분 30초 후', congestion: { code: 4, label: '보통', level: 'normal' }, lowFloor: true, sectionOrd: Math.max(1, boardOrd - 2), destinationRideSec: 780, destinationEtaSec: 990, destinationEtaSource: 'vehicle-match' },
    { index: 2, vehId: 'demo-2', plainNo: '서울74사7716', etaSec: 690, arrMsg: '약 11분 30초 후', congestion: { code: 3, label: '여유', level: 'easy' }, lowFloor: true, sectionOrd: Math.max(1, boardOrd - 7), destinationRideSec: 760, destinationEtaSec: 1450, destinationEtaSource: 'route-estimate' }
  ];
  return {
    mode: 'demo', routeName: '7016', updatedAt: new Date().toISOString(),
    boarding: { ord: boardOrd, station: board.station, stationNm: board.stationNm, arsId: board.arsId },
    destination: { ord: destOrd, stationNm: dest.stationNm, arsId: dest.arsId },
    scheduledTermMin: 9, actualHeadwayMin: 8, buses,
    recommendation: recommendation(buses[0], buses[1], hist), runningBusCount: 24, historical: hist
  };
}

app.get('/api/dashboard', async (req, res) => {
  const routeName = resolveRouteName(req.query.route || '7016');
  const boardOrd = Number(req.query.boardOrd);
  if (!routeName) return res.status(400).json({ error: '지원하지 않는 노선입니다.' });
  if (!Number.isFinite(boardOrd)) return res.status(400).json({ error: 'boardOrd가 필요합니다.' });
  if (!SERVICE_KEY) {
    const destOrd = Number(req.query.destOrd);
    if (routeName === '7016' && Number.isFinite(destOrd)) return res.json(demoDashboard(boardOrd, destOrd));
    return res.status(503).json({ error: '실시간 API 연결이 필요합니다.' });
  }
  try {
    const route = await getRoute(routeName);
    const routeId = String(route.busRouteId);
    const [allStations, arrivalRows, positionRows] = await Promise.all([
      getStations(routeId),
      busFetch('arrive/getArrInfoByRouteAll', { busRouteId: routeId }, 10000),
      busFetch('buspos/getBusPosByRtid', { busRouteId: routeId }, 10000)
    ]);
    const commute = commuteStations(allStations);
    const destOrd = nextDestinationSeq(commute.destinationSeqs, boardOrd);
    if (destOrd == null) throw new Error('선택한 정류장 이후에 상명대정문 정류장이 없습니다.');
    const arrivals = arrivalRows.map(normalizeArrival);
    const activePositions = positionRows.filter(p => String(firstDefined(p.isrunyn, '1')) !== '0');
    const boardingStation = commute.stations.find(s => s.seq === boardOrd);
    const destinationStation = commute.stations.find(s => s.seq === destOrd);
    if (!boardingStation || !destinationStation) throw new Error('선택한 정류장을 상명대 방향 구간에서 찾지 못했습니다.');
    const board = arrivals.find(a => (a.ord != null && a.ord === boardOrd) || a.stId === boardingStation.station);
    if (!board) throw new Error('선택한 승차 정류장의 도착정보를 찾지 못했습니다.');
    const segmentStations = commute.stations.filter(s => s.seq >= boardOrd && s.seq <= destOrd);
    const bus1 = makeBusCard(board, arrivals, activePositions, 1, segmentStations, boardOrd, destOrd);
    const bus2 = makeBusCard(board, arrivals, activePositions, 2, segmentStations, boardOrd, destOrd);
    const gap = bus1.etaSec != null && bus2.etaSec != null ? Math.max(0, bus2.etaSec - bus1.etaSec) : null;
    const historical = historicalForStation(boardingStation, routeName);
    res.json({
      mode: 'live', routeName, updatedAt: new Date().toISOString(),
      boarding: { ord: boardOrd, station: boardingStation.station, stationNm: boardingStation.stationNm, arsId: boardingStation.arsId },
      destination: { ord: destOrd, stationNm: destinationStation.stationNm, arsId: destinationStation.arsId },
      scheduledTermMin: board.term ?? toNumber(route.term),
      actualHeadwayMin: gap == null ? null : Math.round(gap / 60),
      buses: [bus1, bus2], recommendation: recommendation(bus1, bus2, historical),
      runningBusCount: activePositions.length, historical
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || 'dashboard 실패' });
  }
});

const aiAdviceCache = new Map();
const aiRateLimit = new Map();
function aiRequestAllowed(req) {
  const key = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const limit = 12;
  const recent = (aiRateLimit.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  aiRateLimit.set(key, recent);
  if (aiRateLimit.size > 300) {
    for (const [k, times] of aiRateLimit) if (!times.some(t => now - t < windowMs)) aiRateLimit.delete(k);
  }
  return true;
}
function safeAiContext(body = {}) {
  const bus = (b = {}) => ({
    etaSec: toNumber(b.etaSec),
    congestion: String(b?.congestion?.label || '정보 없음').slice(0, 20),
    destinationEtaSec: toNumber(b.destinationEtaSec),
    destinationEtaSource: String(b.destinationEtaSource || '').slice(0, 40),
    lowFloor: Boolean(b.lowFloor),
  });
  const h = body.historical || null;
  return {
    route: String(body.routeName || '7016').slice(0, 20),
    boarding: String(body?.boarding?.stationNm || '').slice(0, 80),
    destination: String(body?.destination?.stationNm || '').slice(0, 80),
    scheduledTermMin: toNumber(body.scheduledTermMin),
    actualHeadwayMin: toNumber(body.actualHeadwayMin),
    firstBus: bus(body?.buses?.[0]), secondBus: bus(body?.buses?.[1]),
    historical: h ? {
      available: Boolean(h.available), hour: toNumber(h.hour), averageBoard: toNumber(h.board), averageAlight: toNumber(h.alight),
      demandLevel: String(h.level || '').slice(0, 20), sourceMonth: String(h.sourceMonth || '').slice(0, 30), demo: Boolean(h.demo),
    } : null,
    ruleRecommendation: {
      action: String(body?.recommendation?.action || '').slice(0, 30),
      title: String(body?.recommendation?.title || '').slice(0, 80),
      reason: String(body?.recommendation?.reason || '').slice(0, 240),
    },
    updatedAt: String(body.updatedAt || '').slice(0, 40),
  };
}
function fallbackAiAdvice(ctx) {
  const action = ctx.ruleRecommendation.action || 'NEUTRAL';
  return {
    decision: action === 'WAIT_NEXT' ? 'WAIT_NEXT' : action === 'TAKE_NOW' ? 'TAKE_NOW' : 'NEUTRAL',
    headline: ctx.ruleRecommendation.title || '현재 데이터 기준으로 판단하세요',
    reason: ctx.ruleRecommendation.reason || '현재 실시간 도착정보를 기준으로 판단했습니다.',
    risk: 'Gemini 응답을 사용할 수 없어 기존 규칙 기반 판단을 표시합니다.',
    tip: '실시간 도착정보는 계속 갱신되므로 탑승 직전에 한 번 더 확인하세요.',
    source: 'rule-fallback',
  };
}
async function getGeminiAdvice(ctx) {
  if (!gemini) return fallbackAiAdvice(ctx);
  const cacheKey = JSON.stringify(ctx);
  const cached = aiAdviceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 3 * 60 * 1000) return cached.value;
  const schema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['TAKE_NOW', 'WAIT_NEXT', 'NEUTRAL'] },
      headline: { type: 'string' }, reason: { type: 'string' }, risk: { type: 'string' }, tip: { type: 'string' }
    },
    required: ['decision', 'headline', 'reason', 'risk', 'tip']
  };
  const prompt = [
    '너는 상명대학교 서울캠퍼스 통학 버스 의사결정 보조 AI다.',
    `선택 노선은 ${ctx.route}이다. 아래 데이터만 사용해 첫 번째 버스를 탈지 다음 버스를 기다릴지 판단하라.`,
    '없는 사실을 만들지 말고 실시간 데이터가 있으면 과거 통계보다 우선하라.',
    '상명대 도착 ETA source가 vehicle-match가 아니면 추정치임을 risk에 밝혀라.',
    '답변은 짧고 자연스러운 한국어로 하라.',
    JSON.stringify(ctx)
  ].join('\n');
  try {
    const interaction = await gemini.interactions.create({ model: GEMINI_MODEL, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema } });
    const parsed = JSON.parse(interaction.output_text || '{}');
    const value = {
      decision: ['TAKE_NOW', 'WAIT_NEXT', 'NEUTRAL'].includes(parsed.decision) ? parsed.decision : 'NEUTRAL',
      headline: String(parsed.headline || 'AI 분석 완료').slice(0, 100),
      reason: String(parsed.reason || '').slice(0, 500), risk: String(parsed.risk || '').slice(0, 300), tip: String(parsed.tip || '').slice(0, 300),
      source: 'gemini', model: GEMINI_MODEL,
    };
    aiAdviceCache.set(cacheKey, { at: Date.now(), value });
    if (aiAdviceCache.size > 80) aiAdviceCache.delete(aiAdviceCache.keys().next().value);
    return value;
  } catch (err) {
    console.error('Gemini advice error:', err);
    return { ...fallbackAiAdvice(ctx), risk: 'Gemini 호출 오류로 기존 규칙 기반 판단을 표시합니다.', errorCode: 'GEMINI_CALL_FAILED' };
  }
}
app.post('/api/ai-advice', async (req, res) => {
  if (!aiRequestAllowed(req)) return res.status(429).json({ error: 'AI 분석 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  const ctx = safeAiContext(req.body || {});
  if (!ctx.boarding || !ctx.destination) return res.status(400).json({ error: '현재 통학 데이터가 필요합니다.' });
  const advice = await getGeminiAdvice(ctx);
  res.json({ ok: true, configured: Boolean(gemini), advice });
});

app.post('/api/reload-passenger-profile', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  reloadPassengerProfile();
  res.json({ ok: true, available: Boolean(passengerProfile), sourceMonth: passengerProfile?.sourceMonth || null });
});
app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'smu-campus-bus',
  version: APP_VERSION,
  routes: ROUTE_LIST,
  timeZone: SEOUL_TIME_ZONE,
  liveApiConfigured: Boolean(SERVICE_KEY),
  passengerProfileLoaded: Boolean(passengerProfile),
  passengerSourceMonth: passengerProfile?.sourceMonth || null,
  passengerValueBasis: passengerProfile?.valueBasis || (passengerProfile ? 'legacy-monthly-total/normalized-at-runtime' : null),
  geminiConfigured: Boolean(GEMINI_API_KEY),
  geminiModel: GEMINI_API_KEY ? GEMINI_MODEL : null
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SMU Campus Bus v${APP_VERSION}: http://localhost:${PORT}`);
  console.log(`지원 노선: ${ROUTE_LIST.join(', ')}`);
  console.log(`7016 정류장 fallback: ${fallback7016Stops.length}개`);
  console.log(`승하차 프로필: ${passengerProfile ? 'loaded' : 'not loaded'}`);
});