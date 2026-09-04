import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || '';
const PASSENGER_PROFILE_FILE = process.env.PASSENGER_PROFILE_FILE || 'data/7016-passenger-profile.json';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const BUS_API = 'http://ws.bus.go.kr/api/rest';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

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
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const fallbackStops = JSON.parse(fs.readFileSync('data/7016-schoolbound-stops.json', 'utf8'));
let passengerProfile = null;

function reloadPassengerProfile() {
  try {
    passengerProfile = JSON.parse(fs.readFileSync(PASSENGER_PROFILE_FILE, 'utf8'));
  } catch {
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
function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function firstDefined(...v) { return v.find(x => x !== undefined && x !== null && x !== ''); }
function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function normName(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[()_\-]/g, '').toLowerCase();
}
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
  const res = await fetch(url, { headers: { 'User-Agent': '7016-campus-bus/0.2' } });
  if (!res.ok) throw new Error(`서울 버스 API HTTP ${res.status}`);
  const items = xmlItems(await res.text());
  cacheSet(url, items);
  return items;
}
async function get7016Route() {
  const routes = await busFetch('busRouteInfo/getBusRouteList', { strSrch: '7016' }, 21600000);
  const exact = routes.find(r => String(r.busRouteNm).trim() === '7016');
  if (!exact) throw new Error('7016 노선을 찾지 못했습니다.');
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
  })).sort((a,b) => a.seq - b.seq);
}
function schoolboundSlice(stations) {
  const destIndexes = stations
    .map((s, i) => ({ s, i }))
    .filter(x => /상명대정문/.test(x.s.stationNm));
  if (!destIndexes.length) return stations;
  // 첫 상명대정문이 학교 방향 종점이고, 이후는 회차 후 반대 방향.
  return stations.slice(0, destIndexes[0].i + 1);
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
    0:{code:0,label:'정보 없음',level:'unknown'},
    3:{code:3,label:'여유',level:'easy'},
    4:{code:4,label:'보통',level:'normal'},
    5:{code:5,label:'혼잡',level:'busy'},
    6:{code:6,label:'매우 혼잡',level:'very-busy'}
  })[Number(code || 0)] || { code:Number(code||0), label:'정보 없음', level:'unknown' };
}
function matchDestinationTravel(board, destination, idx) {
  const vehId = idx === 1 ? board.vehId1 : board.vehId2;
  const boardEta = idx === 1 ? board.traTime1 : board.traTime2;
  if (!vehId || boardEta == null || !destination) return null;
  let destEta = null;
  if (destination.vehId1 === vehId) destEta = destination.traTime1;
  if (destination.vehId2 === vehId) destEta = destination.traTime2;
  if (destEta == null || destEta < boardEta) return null;
  return Math.max(0, destEta - boardEta);
}
function fallbackTravelSeconds(boardOrd, destOrd, positions) {
  const stopGap = Math.max(1, destOrd - boardOrd);
  const nextTimes = positions
    .filter(p => {
      const ord = toNumber(p.sectOrd);
      return ord != null && ord >= boardOrd && ord <= destOrd;
    })
    .map(p => toNumber(p.nextStTm))
    .filter(v => v != null && v >= 20 && v <= 1200);
  const avgSection = nextTimes.length ? nextTimes.reduce((a,b)=>a+b,0)/nextTimes.length : 82;
  return Math.round(stopGap * avgSection * 1.10);
}
function makeBusCard(board, destination, positions, idx, boardOrd, destOrd) {
  const vehId = idx === 1 ? board.vehId1 : board.vehId2;
  const etaSec = idx === 1 ? board.traTime1 : board.traTime2;
  const arrMsg = idx === 1 ? board.arrmsg1 : board.arrmsg2;
  const plainNo = idx === 1 ? board.plainNo1 : board.plainNo2;
  const full = idx === 1 ? board.isFullFlag1 : board.isFullFlag2;
  const pos = positions.find(p => String(p.vehId) === vehId);
  const congestion = congestionMeta(firstDefined(pos?.congetion, 0), firstDefined(pos?.isFullFlag, full, 0));
  const matched = matchDestinationTravel(board, destination, idx);
  const rideSec = matched ?? fallbackTravelSeconds(boardOrd, destOrd, positions);
  return {
    index: idx, vehId, plainNo: plainNo || String(pos?.plainNo || ''),
    etaSec, arrMsg, congestion,
    lowFloor: Number(pos?.busType) === 1,
    sectionOrd: toNumber(pos?.sectOrd),
    destinationRideSec: rideSec,
    destinationEtaSec: etaSec == null ? null : etaSec + rideSec,
    destinationEtaSource: matched != null ? 'vehicle-match' : 'section-estimate'
  };
}
function recommendation(first, second, historical) {
  if (!first || first.etaSec == null) return { action:'WAIT', title:'도착 정보를 기다리는 중', reason:'첫 번째 차량 ETA가 아직 없습니다.' };
  if (!second || second.etaSec == null) return { action:'TAKE_NOW', title:'이번 버스 타기', reason:'다음 차량 정보가 없어 현재 차량을 추천합니다.' };
  const gap = second.etaSec - first.etaSec;
  const firstBad = ['busy','very-busy'].includes(first.congestion.level);
  const secondGood = ['easy','normal'].includes(second.congestion.level);
  if (firstBad && secondGood && gap <= 360) return { action:'WAIT_NEXT', title:'다음 버스 추천', reason:`첫 차는 ${first.congestion.label}이고 다음 차까지 약 ${Math.max(1,Math.round(gap/60))}분입니다.` };
  if (first.congestion.level === 'very-busy' && gap <= 480) return { action:'WAIT_NEXT', title:'다음 버스 고려', reason:`첫 차가 ${first.congestion.label}이고 다음 차가 약 ${Math.max(1,Math.round(gap/60))}분 뒤입니다.` };
  const histNote = historical?.level === 'high' ? ' 이 시간대 승차 수요도 높은 편입니다.' : '';
  return { action:'TAKE_NOW', title:'이번 버스 타기', reason:`다음 차와 약 ${Math.max(1,Math.round(gap/60))}분 차이라 지금 타는 편이 빠릅니다.${histNote}` };
}
function historicalForStation(station) {
  if (!passengerProfile) return null;
  const byId = passengerProfile.byId || {};
  const byName = passengerProfile.byName || {};
  const exact = byId[String(station.station || '')];
  const named = byName[normName(station.stationNm)];
  const p = exact || named;
  if (!p) return {
    available: false,
    sourceMonth: passengerProfile.sourceMonth || null,
    sourceFile: passengerProfile.sourceFile || null
  };
  const hour = new Date().getHours();
  const h = p.hours?.[hour] || { hour, board:0, alight:0, net:0 };
  const maxBoard = Math.max(1, ...p.hours.map(x => Number(x.board || 0)));
  const ratio = Number(h.board || 0) / maxBoard;
  const level = ratio >= .72 ? 'high' : ratio >= .38 ? 'medium' : 'low';
  return {
    available: true,
    match: exact ? 'station-id' : 'station-name',
    ambiguousName: Boolean(p.ambiguousName && !exact),
    sourceMonth: passengerProfile.sourceMonth || null,
    sourceFile: passengerProfile.sourceFile || null,
    hour,
    board: Number(h.board || 0),
    alight: Number(h.alight || 0),
    net: Number(h.net || 0),
    level,
    hours: p.hours
  };
}

function demoPassenger(station) {
  const hour = new Date().getHours();
  const base = Math.max(3, 24 - Math.abs(hour - 9) * 2);
  const factor = /경복궁|서울역|홍대|공덕/.test(station.stationNm) ? 1.45 : 1;
  const board = Math.round(base * factor);
  const alight = Math.max(1, Math.round(board * .35));
  const hours = Array.from({length:24},(_,h)=>{
    const b = Math.max(1, Math.round((24-Math.abs(h-9)*2)*factor));
    return {hour:h, board:b, alight:Math.max(1,Math.round(b*.35)), net:Math.round(b*.65)};
  });
  return { available:true, demo:true, sourceMonth:'2026-07 DEMO', hour, board, alight, net:board-alight, level:board>25?'high':board>12?'medium':'low', hours };
}

function demoBootstrap() {
  return {
    mode:'demo',
    route:{busRouteId:'DEMO-7016',busRouteNm:'7016',stStationNm:'은평공영차고지',edStationNm:'상명대정문',term:9},
    stations:fallbackStops,
    stopCount:fallbackStops.length,
    suggestedBoardingSeq:fallbackStops.find(s=>/경복궁역3번출구/.test(s.stationNm))?.seq || 47,
    destinationSeq:fallbackStops.length,
    passengerData:{available:Boolean(passengerProfile), sourceMonth:passengerProfile?.sourceMonth || null},
    geminiConfigured:Boolean(GEMINI_API_KEY)
  };
}

app.get('/api/bootstrap', async (req,res)=>{
  if (!SERVICE_KEY) return res.json(demoBootstrap());
  try {
    const route = await get7016Route();
    const all = await getStations(String(route.busRouteId));
    const stations = schoolboundSlice(all);
    const destination = stations[stations.length-1];
    const suggested = stations.find(s=>/경복궁역.*3번출구/.test(s.stationNm)) || stations[Math.max(0,stations.length-8)];
    res.json({
      mode:'live',
      route:{
        busRouteId:String(route.busRouteId),busRouteNm:String(route.busRouteNm||'7016'),
        stStationNm:String(route.stStationNm||''),edStationNm:String(route.edStationNm||''),
        term:toNumber(route.term),firstBusTm:String(route.firstBusTm||''),lastBusTm:String(route.lastBusTm||'')
      },
      stations, stopCount:stations.length,
      suggestedBoardingSeq:suggested?.seq ?? stations[0]?.seq,
      destinationSeq:destination?.seq,
      passengerData:{available:Boolean(passengerProfile),sourceMonth:passengerProfile?.sourceMonth || null},
      geminiConfigured:Boolean(GEMINI_API_KEY)
    });
  } catch(err) {
    console.error(err);
    res.status(502).json({error:err.message || 'bootstrap 실패'});
  }
});

function demoDashboard(boardOrd,destOrd) {
  const board = fallbackStops.find(s=>s.seq===boardOrd) || fallbackStops[46];
  const dest = fallbackStops.find(s=>s.seq===destOrd) || fallbackStops.at(-1);
  const hist = passengerProfile ? historicalForStation(board) : demoPassenger(board);
  const buses = [
    {index:1,vehId:'demo-1',plainNo:'서울74사7016',etaSec:210,arrMsg:'약 3분 30초 후',congestion:{code:4,label:'보통',level:'normal'},lowFloor:true,sectionOrd:Math.max(1,boardOrd-2),destinationRideSec:780,destinationEtaSec:990,destinationEtaSource:'vehicle-match'},
    {index:2,vehId:'demo-2',plainNo:'서울74사7716',etaSec:690,arrMsg:'약 11분 30초 후',congestion:{code:3,label:'여유',level:'easy'},lowFloor:true,sectionOrd:Math.max(1,boardOrd-7),destinationRideSec:760,destinationEtaSec:1450,destinationEtaSource:'section-estimate'}
  ];
  return {
    mode:'demo',updatedAt:new Date().toISOString(),
    boarding:{ord:boardOrd,station:board.station,stationNm:board.stationNm,arsId:board.arsId},
    destination:{ord:destOrd,stationNm:dest.stationNm,arsId:dest.arsId},
    scheduledTermMin:9,actualHeadwayMin:8,buses,
    recommendation:recommendation(buses[0],buses[1],hist),
    runningBusCount:24,historical:hist
  };
}

app.get('/api/dashboard', async (req,res)=>{
  const boardOrd = Number(req.query.boardOrd), destOrd = Number(req.query.destOrd);
  if (!Number.isFinite(boardOrd)||!Number.isFinite(destOrd)) return res.status(400).json({error:'boardOrd와 destOrd가 필요합니다.'});
  if (!SERVICE_KEY) return res.json(demoDashboard(boardOrd,destOrd));

  try {
    const route = await get7016Route();
    const routeId = String(route.busRouteId);
    const [allStations,arrivalRows,positionRows] = await Promise.all([
      getStations(routeId),
      busFetch('arrive/getArrInfoByRouteAll',{busRouteId:routeId},10000),
      busFetch('buspos/getBusPosByRtid',{busRouteId:routeId},10000)
    ]);
    const stations = schoolboundSlice(allStations);
    const arrivals = arrivalRows.map(normalizeArrival);
    const boardingStation = stations.find(s=>s.seq===boardOrd);
    const destinationStation = stations.find(s=>s.seq===destOrd);
    if (!boardingStation||!destinationStation) throw new Error('선택한 정류장을 학교 방향 노선에서 찾지 못했습니다.');
    const board = arrivals.find(a => (a.ord!=null&&a.ord===boardOrd) || a.stId===boardingStation.station);
    const dest = arrivals.find(a => (a.ord!=null&&a.ord===destOrd) || a.stId===destinationStation.station);
    if (!board) throw new Error('선택한 승차 정류장의 도착정보를 찾지 못했습니다.');
    const bus1=makeBusCard(board,dest,positionRows,1,boardOrd,destOrd);
    const bus2=makeBusCard(board,dest,positionRows,2,boardOrd,destOrd);
    const gap=bus1.etaSec!=null&&bus2.etaSec!=null ? Math.max(0,bus2.etaSec-bus1.etaSec) : null;
    const historical=historicalForStation(boardingStation);
    res.json({
      mode:'live',updatedAt:new Date().toISOString(),
      boarding:{ord:boardOrd,station:boardingStation.station,stationNm:boardingStation.stationNm,arsId:boardingStation.arsId},
      destination:{ord:destOrd,stationNm:destinationStation.stationNm,arsId:destinationStation.arsId},
      scheduledTermMin:board.term??toNumber(route.term),
      actualHeadwayMin:gap==null?null:Math.round(gap/60),
      buses:[bus1,bus2],
      recommendation:recommendation(bus1,bus2,historical),
      runningBusCount:positionRows.length,
      historical
    });
  } catch(err) {
    console.error(err);
    res.status(502).json({error:err.message || 'dashboard 실패'});
  }
});


const aiAdviceCache = new Map();

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
    boarding: String(body?.boarding?.stationNm || '').slice(0, 80),
    destination: String(body?.destination?.stationNm || '').slice(0, 80),
    scheduledTermMin: toNumber(body.scheduledTermMin),
    actualHeadwayMin: toNumber(body.actualHeadwayMin),
    firstBus: bus(body?.buses?.[0]),
    secondBus: bus(body?.buses?.[1]),
    historical: h ? {
      available: Boolean(h.available),
      hour: toNumber(h.hour),
      averageBoard: toNumber(h.board),
      averageAlight: toNumber(h.alight),
      demandLevel: String(h.level || '').slice(0, 20),
      sourceMonth: String(h.sourceMonth || '').slice(0, 30),
      demo: Boolean(h.demo),
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
  const firstCong = ctx.firstBus.congestion;
  const secondCong = ctx.secondBus.congestion;
  return {
    decision: action === 'WAIT_NEXT' ? 'WAIT_NEXT' : action === 'TAKE_NOW' ? 'TAKE_NOW' : 'NEUTRAL',
    headline: ctx.ruleRecommendation.title || '현재 데이터 기준으로 판단하세요',
    reason: ctx.ruleRecommendation.reason || `첫 차 ${firstCong}, 다음 차 ${secondCong} 상태입니다.`,
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
      decision: {
        type: 'string',
        enum: ['TAKE_NOW', 'WAIT_NEXT', 'NEUTRAL'],
        description: '추천 행동'
      },
      headline: {
        type: 'string',
        description: '20자 안팎의 매우 짧은 한국어 결론'
      },
      reason: {
        type: 'string',
        description: '실시간 ETA, 배차, 혼잡도, 과거 수요 중 실제 제공된 수치를 근거로 한 1~2문장 설명'
      },
      risk: {
        type: 'string',
        description: '불확실성 또는 주의점 한 문장'
      },
      tip: {
        type: 'string',
        description: '사용자가 바로 행동할 수 있는 짧은 팁 한 문장'
      }
    },
    required: ['decision', 'headline', 'reason', 'risk', 'tip']
  };

  const prompt = [
    '너는 서울 7016번 버스로 상명대학교에 통학하는 사람을 돕는 교통 의사결정 보조 AI다.',
    '아래 데이터만 사용해서 지금 오는 첫 번째 버스를 탈지, 다음 버스를 기다릴지 판단하라.',
    '규칙:',
    '1. 없는 사실이나 승객 수를 만들어내지 말 것.',
    '2. 실시간 차량 혼잡도가 있으면 과거 승하차 평균보다 우선할 것.',
    '3. 과거 승하차 데이터가 DEMO이면 판단 근거로 강하게 사용하지 말 것.',
    '4. 상명대 도착 ETA가 추정치(section-estimate)면 그 불확실성을 risk에 밝힐 것.',
    '5. 두 차량의 시간 차이가 크면 시간 절약을 우선하고, 차이가 작고 첫 차가 혼잡하면 쾌적함을 고려할 것.',
    '6. 기존 ruleRecommendation을 참고하되 그대로 복사할 필요는 없다.',
    '7. 답변은 짧고 자연스러운 한국어로 할 것.',
    '',
    JSON.stringify(ctx)
  ].join('\n');

  try {
    const interaction = await gemini.interactions.create({
      model: GEMINI_MODEL,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema
      }
    });
    const parsed = JSON.parse(interaction.output_text || '{}');
    const value = {
      decision: ['TAKE_NOW','WAIT_NEXT','NEUTRAL'].includes(parsed.decision) ? parsed.decision : 'NEUTRAL',
      headline: String(parsed.headline || 'AI 분석 완료').slice(0, 100),
      reason: String(parsed.reason || '').slice(0, 500),
      risk: String(parsed.risk || '').slice(0, 300),
      tip: String(parsed.tip || '').slice(0, 300),
      source: 'gemini',
      model: GEMINI_MODEL,
    };
    aiAdviceCache.set(cacheKey, { at: Date.now(), value });
    if (aiAdviceCache.size > 80) {
      const oldest = aiAdviceCache.keys().next().value;
      aiAdviceCache.delete(oldest);
    }
    return value;
  } catch (err) {
    console.error('Gemini advice error:', err);
    return {
      ...fallbackAiAdvice(ctx),
      risk: `Gemini 호출 오류로 기존 규칙 기반 판단을 표시합니다.`,
      errorCode: 'GEMINI_CALL_FAILED'
    };
  }
}

app.post('/api/ai-advice', async (req, res) => {
  const ctx = safeAiContext(req.body || {});
  if (!ctx.boarding || !ctx.destination) {
    return res.status(400).json({ error: '현재 통학 데이터가 필요합니다.' });
  }
  const advice = await getGeminiAdvice(ctx);
  res.json({
    ok: true,
    configured: Boolean(gemini),
    advice
  });
});

app.post('/api/reload-passenger-profile',(req,res)=>{
  reloadPassengerProfile();
  res.json({ok:true,available:Boolean(passengerProfile),sourceMonth:passengerProfile?.sourceMonth||null});
});
app.get('/api/health',(req,res)=>res.json({
  ok:true,service:'7016-campus-bus',version:'0.2.0',
  liveApiConfigured:Boolean(SERVICE_KEY),
  passengerProfileLoaded:Boolean(passengerProfile),
  passengerSourceMonth:passengerProfile?.sourceMonth||null,
  geminiConfigured:Boolean(GEMINI_API_KEY),
  geminiModel:GEMINI_API_KEY ? GEMINI_MODEL : null
}));

app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`7016 Campus Bus V2: http://localhost:${PORT}`);
  console.log(`정류장 fallback: ${fallbackStops.length}개`);
  console.log(`승하차 프로필: ${passengerProfile ? 'loaded' : 'not loaded'}`);
});
