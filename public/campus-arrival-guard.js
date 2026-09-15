const LOCATION_CONSENT_KEY = 'smu-location-consent-v5';
const ROUTES = ['7016', '서대문08', '종로13'];
const CAMPUS_RADIUS_M = 320;
const MAX_ACCURACY_PADDING_M = 40;

let campusArrived = false;
let campusDistanceM = null;
let anchorPromise = null;
let observersInstalled = false;
let applyingArrivalState = false;
let recheckTimer = null;

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const r = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function stationCoordinates(station) {
  const lon = Number(station?.gpsX);
  const lat = Number(station?.gpsY);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function destinationSeqs(bootstrap) {
  const many = Array.isArray(bootstrap?.destinationSeqs)
    ? bootstrap.destinationSeqs.map(Number).filter(Number.isFinite)
    : [];
  if (many.length) return many;
  const one = Number(bootstrap?.destinationSeq);
  return Number.isFinite(one) ? [one] : [];
}

async function fetchBootstrap(route) {
  const res = await fetch(`/api/bootstrap?route=${encodeURIComponent(route)}&_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`bootstrap ${route}: HTTP ${res.status}`);
  return res.json();
}

async function loadCampusAnchors() {
  if (anchorPromise) return anchorPromise;
  anchorPromise = (async () => {
    const results = await Promise.allSettled(ROUTES.map(fetchBootstrap));
    const anchors = [];

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const bootstrap = result.value;
      const dests = new Set(destinationSeqs(bootstrap));
      for (const station of bootstrap?.stations || []) {
        if (!dests.has(Number(station.seq)) && !/상명대정문|상명대학교정문/.test(station.stationNm || '')) continue;
        const coord = stationCoordinates(station);
        if (coord) anchors.push(coord);
      }
    }

    const unique = [];
    for (const anchor of anchors) {
      if (!unique.some((x) => haversineMeters(x.lat, x.lon, anchor.lat, anchor.lon) < 20)) unique.push(anchor);
    }
    return unique;
  })().catch((error) => {
    anchorPromise = null;
    throw error;
  });
  return anchorPromise;
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('geolocation unavailable'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Number(pos.coords.latitude),
        lon: Number(pos.coords.longitude),
        accuracy: Number(pos.coords.accuracy || 0)
      }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

function setHidden(target, hidden) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (el && el.hidden !== hidden) el.hidden = hidden;
}

function applyCampusArrivalState() {
  if (!campusArrived || applyingArrivalState) return;
  applyingArrivalState = true;
  try {
    document.documentElement.dataset.campusArrived = 'true';

    setHidden('loadingCard', true);
    setHidden('recommendationCard', false);
    setHidden('manualSection', true);
    setHidden('routeDetail', true);
    setHidden('alternativesSection', true);
    setHidden('showRouteButton', true);
    setHidden('showAlternativesButton', true);
    setHidden(document.querySelector('.quick-info-grid'), true);
    setHidden(document.querySelector('.stats-panel'), true);

    setText('originText', '상명대학교 서울캠퍼스 · 도착');
    setText('modeBadge', '도착');
    const modeBadge = document.getElementById('modeBadge');
    if (modeBadge && modeBadge.className !== 'status-dot live') modeBadge.className = 'status-dot live';

    setText('leaveStatusChip', '도착 완료');
    const chip = document.getElementById('leaveStatusChip');
    if (chip && chip.className !== 'leave-chip good') chip.className = 'leave-chip good';

    setText('arrivalClock', '도착 완료');
    setText('leaveHeadline', '이미 상명대학교에 도착했어요');
    const distanceText = Number.isFinite(campusDistanceM)
      ? ` 상명대정문 정류장 기준 약 ${Math.max(0, Math.round(campusDistanceM / 10) * 10)}m 범위입니다.`
      : '';
    setText('leaveReason', `현재 위치가 캠퍼스 도착 범위로 확인되어 통학 버스 추천을 종료했습니다.${distanceText}`);

    setText('routePill', '도착');
    setText('boardingName', '상명대학교 서울캠퍼스');
    setText('boardingMeta', '현재 위치가 학교 도착 범위로 확인됨');
    setText('totalTime', '0분');
    setText('walkTime', '완료');
    setText('walkDistance', '교내');
    setText('busEta', '불필요');
    setText('busRide', '버스 추천 종료');
    setText('campusWalk', '도착');
    setText('walkSource', '캠퍼스 도착 감지 · 위치 좌표 비저장');
    setText('updatedAt', `확인 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  } finally {
    applyingArrivalState = false;
  }
}

function installArrivalObservers() {
  if (observersInstalled) return;
  observersInstalled = true;

  const targets = [
    document.getElementById('loadingCard'),
    document.getElementById('recommendationCard'),
    document.getElementById('manualSection'),
    document.getElementById('modeBadge')
  ].filter(Boolean);

  const observer = new MutationObserver(() => {
    if (campusArrived) queueMicrotask(applyCampusArrivalState);
  });

  for (const target of targets) {
    observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  }
}

async function checkCampusArrival() {
  if (localStorage.getItem(LOCATION_CONSENT_KEY) !== 'granted') return;

  try {
    const [anchors, position] = await Promise.all([loadCampusAnchors(), getCurrentPosition()]);
    if (!anchors.length) return;

    const nearest = Math.min(...anchors.map((anchor) => haversineMeters(position.lat, position.lon, anchor.lat, anchor.lon)));
    const threshold = CAMPUS_RADIUS_M + Math.min(MAX_ACCURACY_PADDING_M, Math.max(0, position.accuracy || 0));
    const arrivedNow = Number.isFinite(nearest) && nearest <= threshold;
    const wasArrived = campusArrived;

    campusDistanceM = nearest;
    campusArrived = arrivedNow;

    if (arrivedNow) {
      installArrivalObservers();
      applyCampusArrivalState();
      return;
    }

    if (wasArrived) location.reload();
  } catch {
    // 기존 통학 계산을 방해하지 않도록 도착 판정 실패는 조용히 무시한다.
  }
}

function scheduleRecheck(delay = 500) {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(checkCampusArrival, delay);
}

window.addEventListener('load', () => scheduleRecheck(700));
document.getElementById('refreshLocationButton')?.addEventListener('click', () => scheduleRecheck(900));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRecheck(400);
});
setInterval(() => {
  if (!document.hidden && localStorage.getItem(LOCATION_CONSENT_KEY) === 'granted') checkCampusArrival();
}, 60000);
