import express from 'express';

const originalPost = express.application.post;
const originalListen = express.application.listen;
const TMAP_APP_KEY = String(process.env.TMAP_APP_KEY || '').trim();
const walkCache = new Map();
const placeCache = new Map();

function numberInRange(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function walkCacheKey(startX, startY, endX, endY) {
  const round = (n) => Number(n).toFixed(5);
  return [round(startX), round(startY), round(endX), round(endY)].join(':');
}

async function walkHandler(req, res) {
  if (!TMAP_APP_KEY) {
    return res.status(501).json({ error: 'TMAP_APP_KEY_NOT_CONFIGURED', source: 'fallback-required' });
  }

  const body = req.body || {};
  const startX = numberInRange(body.startX, -180, 180);
  const startY = numberInRange(body.startY, -90, 90);
  const endX = numberInRange(body.endX, -180, 180);
  const endY = numberInRange(body.endY, -90, 90);
  if ([startX, startY, endX, endY].some((v) => v == null)) {
    return res.status(400).json({ error: '유효한 출발/도착 좌표가 필요합니다.' });
  }

  const key = walkCacheKey(startX, startY, endX, endY);
  const cached = walkCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return res.json({ ...cached.value, cached: true });
  }

  try {
    const response = await fetch('https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        appKey: TMAP_APP_KEY
      },
      body: JSON.stringify({
        startX: String(startX),
        startY: String(startY),
        endX: String(endX),
        endY: String(endY),
        reqCoordType: 'WGS84GEO',
        resCoordType: 'WGS84GEO',
        startName: '현재 위치',
        endName: '버스 정류장',
        searchOption: '0'
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return res.status(502).json({ error: data?.error?.message || data?.error?.msg || `TMAP HTTP ${response.status}` });
    }

    const props = (data?.features || []).map((feature) => feature?.properties || {}).find((p) => Number.isFinite(Number(p.totalDistance)) && Number.isFinite(Number(p.totalTime)));
    const distanceM = Number(props?.totalDistance);
    const durationSec = Number(props?.totalTime);
    if (!Number.isFinite(distanceM) || !Number.isFinite(durationSec)) {
      return res.status(502).json({ error: 'TMAP 보행 경로 응답에서 거리/시간을 찾지 못했습니다.' });
    }

    const value = {
      distanceM,
      durationSec,
      source: 'tmap-pedestrian',
      note: 'TMAP 실제 보행 경로 기준'
    };
    walkCache.set(key, { at: Date.now(), value });
    if (walkCache.size > 120) walkCache.delete(walkCache.keys().next().value);
    return res.json(value);
  } catch (error) {
    return res.status(502).json({ error: `보행 경로 API 오류: ${error.message}` });
  }
}

// TMAP POI name/address search. No GPS permission required; keys stay server-side.
async function placeHandler(req, res) {
  if (!TMAP_APP_KEY) return res.status(501).json({ error: '장소 검색 API가 설정되지 않았습니다. 정류장 직접 선택을 이용해 주세요.' });
  const query = String(req.query.query || '').trim();
  if (query.length < 2 || query.length > 80) return res.status(400).json({ error: '장소명이나 주소를 2~80자로 입력해 주세요.' });
  const cacheKey = query.toLocaleLowerCase('ko-KR');
  const cached = placeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return res.json(cached.value);
  const url = new URL('https://apis.openapi.sk.com/tmap/pois');
  for (const [key, value] of Object.entries({
    version: '1', searchKeyword: query, searchType: 'all', searchtypCd: 'A',
    page: '1', count: '10', resCoordType: 'WGS84GEO',
    reqCoordType: 'WGS84GEO', multiPoint: 'N', poiGroupYn: 'N'
  })) url.searchParams.set(key, value);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', appKey: TMAP_APP_KEY }, signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      // Avoid leaking the server-side API key if an upstream error echoes it.
      const responseBody = JSON.stringify(data ?? null).replaceAll(TMAP_APP_KEY, '[REDACTED]').slice(0, 2000);
      console.error('[TMAP 장소 검색 오류]', { status: response.status, error: responseBody });
      return res.status(502).json({ error: '장소 검색 서버가 응답하지 않았어요. 잠시 후 다시 시도해 주세요.' });
    }
    const items = data?.searchPoiInfo?.pois?.poi || [];
    const places = (Array.isArray(items) ? items : [items]).map((item) => {
      const lat = Number(item.noorLat || item.frontLat);
      const lon = Number(item.noorLon || item.frontLon);
      return {
        name: String(item.name || '').trim(),
        address: [item.upperAddrName, item.middleAddrName, item.lowerAddrName, item.detailAddrName].filter(Boolean).join(' '),
        lat, lon
      };
    }).filter((item) => item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon)
        && item.lat >= 33 && item.lat <= 39 && item.lon >= 124 && item.lon <= 132);
    const value = { places: places.slice(0, 10) };
    placeCache.set(cacheKey, { at: Date.now(), value });
    if (placeCache.size > 100) placeCache.delete(placeCache.keys().next().value);
    return res.json(value);
  } catch (error) {
    console.error('[TMAP 장소 검색 요청 오류]', { name: error?.name, message: error?.message });
    return res.status(502).json({ error: '장소 검색에 실패했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

// V5는 AI를 사용하지 않는다. 이전 서버의 AI 엔드포인트가 등록되더라도 비활성화한다.
express.application.post = function patchedPost(path, ...handlers) {
  if (path === '/api/ai-advice') {
    return originalPost.call(this, path, (_req, res) => res.status(404).json({ error: 'AI_DISABLED_IN_V5' }));
  }
  return originalPost.call(this, path, ...handlers);
};

// server.js가 listen 하기 직전에 위치 기반 도보 경로 API를 추가한다.
express.application.listen = function patchedListen(...args) {
  this.post('/api/walk', walkHandler);
  this.get('/api/places', placeHandler);
  express.application.listen = originalListen;
  return originalListen.apply(this, args);
};

try {
  await import('./server.js');
} finally {
  express.application.post = originalPost;
  express.application.listen = originalListen;
}
