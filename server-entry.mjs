import express from 'express';

const originalPost = express.application.post;
const originalListen = express.application.listen;
const TMAP_APP_KEY = String(process.env.TMAP_APP_KEY || '').trim();
const walkCache = new Map();

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
  express.application.listen = originalListen;
  return originalListen.apply(this, args);
};

try {
  await import('./server.js');
} finally {
  express.application.post = originalPost;
  express.application.listen = originalListen;
}
