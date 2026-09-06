import express from 'express';
import { GoogleGenAI } from '@google/genai';

const originalPost = express.application.post;
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const fastAiCache = new Map();
const fastAiRate = new Map();
const AI_TIMEOUT_MS = 4500;

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeContext(body = {}) {
  const bus = (b = {}) => ({
    etaSec: toNumber(b.etaSec),
    congestion: String(b?.congestion?.label || '정보 없음').slice(0, 20),
    destinationEtaSec: toNumber(b.destinationEtaSec),
    destinationEtaSource: String(b.destinationEtaSource || '').slice(0, 40),
    lowFloor: Boolean(b.lowFloor)
  });

  const h = body.historical || null;
  return {
    route: String(body.routeName || '7016').slice(0, 20),
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
      sourceMonth: String(h.sourceMonth || '').slice(0, 30)
    } : null,
    ruleRecommendation: {
      action: String(body?.recommendation?.action || '').slice(0, 30),
      title: String(body?.recommendation?.title || '').slice(0, 80),
      reason: String(body?.recommendation?.reason || '').slice(0, 240)
    }
  };
}

function fallbackAdvice(ctx, risk = 'Gemini 응답을 사용할 수 없어 기존 규칙 기반 판단을 표시합니다.') {
  const action = ctx.ruleRecommendation.action || 'NEUTRAL';
  return {
    decision: action === 'WAIT_NEXT' ? 'WAIT_NEXT' : action === 'TAKE_NOW' ? 'TAKE_NOW' : 'NEUTRAL',
    headline: ctx.ruleRecommendation.title || '현재 데이터 기준으로 판단하세요',
    reason: ctx.ruleRecommendation.reason || '현재 실시간 도착정보를 기준으로 판단했습니다.',
    risk,
    tip: '실시간 도착정보는 계속 바뀌므로 탑승 직전에 한 번 더 확인하세요.',
    source: 'rule-fallback'
  };
}

function stableCacheKey(ctx) {
  const round30 = (v) => v == null ? null : Math.round(Number(v) / 30) * 30;
  const busKey = (b) => ({
    etaSec: round30(b?.etaSec),
    congestion: b?.congestion || '정보 없음',
    destinationEtaSec: round30(b?.destinationEtaSec),
    destinationEtaSource: b?.destinationEtaSource || ''
  });
  return JSON.stringify({
    route: ctx.route,
    boarding: ctx.boarding,
    destination: ctx.destination,
    actualHeadwayMin: ctx.actualHeadwayMin == null ? null : Math.round(ctx.actualHeadwayMin),
    firstBus: busKey(ctx.firstBus),
    secondBus: busKey(ctx.secondBus),
    historical: ctx.historical ? {
      hour: ctx.historical.hour,
      demandLevel: ctx.historical.demandLevel,
      averageBoard: ctx.historical.averageBoard == null ? null : Math.round(ctx.historical.averageBoard)
    } : null,
    ruleAction: ctx.ruleRecommendation.action
  });
}

function requestAllowed(req) {
  const key = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (fastAiRate.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= 12) return false;
  recent.push(now);
  fastAiRate.set(key, recent);
  return true;
}

function parseJsonOutput(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Gemini JSON 응답을 해석하지 못했습니다.');
    return JSON.parse(match[0]);
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Gemini timeout');
      error.code = 'GEMINI_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fastGeminiHandler(req, res) {
  if (!requestAllowed(req)) {
    return res.status(429).json({ error: 'AI 분석 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }

  const ctx = safeContext(req.body || {});
  if (!ctx.boarding || !ctx.destination) {
    return res.status(400).json({ error: '현재 통학 데이터가 필요합니다.' });
  }

  if (!gemini) {
    return res.json({ ok: true, configured: false, advice: fallbackAdvice(ctx) });
  }

  const key = stableCacheKey(ctx);
  const cached = fastAiCache.get(key);
  if (cached && Date.now() - cached.at < 3 * 60 * 1000) {
    return res.json({ ok: true, configured: true, cached: true, advice: cached.value });
  }

  const schema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['TAKE_NOW', 'WAIT_NEXT', 'NEUTRAL'] },
      headline: { type: 'string' },
      reason: { type: 'string' },
      risk: { type: 'string' },
      tip: { type: 'string' }
    },
    required: ['decision', 'headline', 'reason', 'risk', 'tip']
  };

  const prompt = [
    '상명대학교 서울캠퍼스 통학 판단 보조',
    `노선:${ctx.route} 승차:${ctx.boarding} 목적지:${ctx.destination}`,
    '실시간 도착정보를 최우선으로 보고 이번 차/다음 차/중립 중 하나를 선택한다.',
    '없는 사실은 만들지 않는다. ETA source가 vehicle-match가 아니면 추정치라고 risk에 짧게 밝힌다.',
    '각 문장은 짧은 한국어로 쓴다.',
    JSON.stringify(ctx)
  ].join('\n');

  try {
    const interaction = await withTimeout(
      gemini.interactions.create({
        model: GEMINI_MODEL,
        store: false,
        input: prompt,
        generation_config: { thinking_level: 'low' },
        response_format: [
          {
            type: 'text',
            mime_type: 'application/json',
            schema
          }
        ]
      }, { timeout: AI_TIMEOUT_MS }),
      AI_TIMEOUT_MS + 300
    );

    const parsed = parseJsonOutput(interaction.output_text);
    const value = {
      decision: ['TAKE_NOW', 'WAIT_NEXT', 'NEUTRAL'].includes(parsed.decision) ? parsed.decision : 'NEUTRAL',
      headline: String(parsed.headline || 'AI 분석 완료').slice(0, 100),
      reason: String(parsed.reason || '').slice(0, 360),
      risk: String(parsed.risk || '').slice(0, 240),
      tip: String(parsed.tip || '').slice(0, 240),
      source: 'gemini',
      model: GEMINI_MODEL
    };

    fastAiCache.set(key, { at: Date.now(), value });
    if (fastAiCache.size > 80) fastAiCache.delete(fastAiCache.keys().next().value);
    return res.json({ ok: true, configured: true, advice: value });
  } catch (error) {
    const timeout = error?.code === 'GEMINI_TIMEOUT' || /timeout/i.test(String(error?.message || ''));
    console.error('Fast Gemini advice error:', error);
    const risk = timeout
      ? 'Gemini 응답이 오래 걸려 빠른 규칙 분석으로 전환했습니다.'
      : 'Gemini API 응답 오류로 빠른 규칙 분석으로 전환했습니다.';
    return res.json({
      ok: true,
      configured: true,
      fallbackReason: timeout ? 'timeout' : 'gemini-error',
      advice: fallbackAdvice(ctx, risk)
    });
  }
}

express.application.post = function patchedPost(path, ...handlers) {
  if (path === '/api/ai-advice') {
    return originalPost.call(this, path, fastGeminiHandler);
  }
  return originalPost.call(this, path, ...handlers);
};

try {
  await import('./server.js');
} finally {
  express.application.post = originalPost;
}
