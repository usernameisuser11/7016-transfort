const $ = (id) => document.getElementById(id);

const ROUTES = ['7016', '서대문08', '종로13'];
const LOCATION_CONSENT_KEY = 'smu-location-consent-v5';
const SAFETY_BUFFER_SEC = 90;
const FINAL_CAMPUS_WALK_SEC = 120;
const MAX_ACCESS_WALK_SEC = 25 * 60;
const CANDIDATES_PER_ROUTE = 2;

let currentPosition = null;
let routeBootstraps = new Map();
let rankedOptions = [];
let activeOption = null;
let refreshTimer = null;
let walkApiAvailable = null;
let calculating = false;
let originRevision = 0;
let originLabel = "현재 위치";
let originSearchRevision = 0;

function formatMinutes(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const value = Math.max(0, Number(sec));
  if (value < 60) return '1분 미만';
  return `${Math.max(1, Math.round(value / 60))}분`;
}
function formatClockFromNow(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  return new Date(Date.now() + Number(sec) * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatDistance(m) {
  if (!Number.isFinite(Number(m))) return '-';
  const n = Number(m);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}km` : `${Math.round(n / 10) * 10}m`;
}
function destinationSeqs(bootstrap) {
  const many = Array.isArray(bootstrap?.destinationSeqs) ? bootstrap.destinationSeqs.map(Number).filter(Number.isFinite) : [];
  if (many.length) return many.sort((a, b) => a - b);
  const one = Number(bootstrap?.destinationSeq);
  return Number.isFinite(one) ? [one] : [];
}
function destinationForStation(bootstrap, seq) {
  return destinationSeqs(bootstrap).find((x) => x > Number(seq)) ?? null;
}
function haversineMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const r = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function stationCoordinates(station) {
  const lon = Number(station?.gpsX);
  const lat = Number(station?.gpsY);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
function setMode(text, live = false) {
  const badge = $('modeBadge');
  badge.textContent = text;
  badge.className = `status-dot${live ? ' live' : ''}`;
}
function setLoading(title, detail = '') {
  $('loadingCard').hidden = false;
  $('recommendationCard').hidden = true;
  $('loadingTitle').textContent = title;
  $('loadingDetail').textContent = detail;
}
function hideLoading() { $('loadingCard').hidden = true; }
function showInfo(title, html) {
  $('infoSheetTitle').textContent = title;
  $('infoSheetBody').innerHTML = html;
  $('infoSheet').hidden = false;
}
function locationConsentValue() { return localStorage.getItem(LOCATION_CONSENT_KEY); }
function showLocationSheet() { $('locationSheet').hidden = false; }
function hideLocationSheet() { $('locationSheet').hidden = true; }

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
async function loadBootstrap(route, force = false) {
  if (!force && routeBootstraps.has(route)) return routeBootstraps.get(route);
  const data = await fetchJson(`/api/bootstrap?route=${encodeURIComponent(route)}&_=${Date.now()}`);
  routeBootstraps.set(route, data);
  return data;
}
async function loadAvailableBootstraps(force = false) {
  if (force) routeBootstraps.clear();
  const results = await Promise.allSettled(ROUTES.map(async (route) => [route, await loadBootstrap(route, force)]));
  return results.filter((x) => x.status === 'fulfilled').map((x) => x.value);
}
function boardableStations(bootstrap) {
  const dests = destinationSeqs(bootstrap);
  return (bootstrap?.stations || []).filter((station) => {
    const coord = stationCoordinates(station);
    return coord && !/상명대정문/.test(station.stationNm || '') && dests.some((dest) => dest > Number(station.seq));
  });
}
function nearestCandidates(position, route, bootstrap) {
  const stations = boardableStations(bootstrap);
  return stations.map((station) => {
    const c = stationCoordinates(station);
    const straightM = haversineMeters(position.lat, position.lon, c.lat, c.lon);
    return { route, bootstrap, station, straightM, destinationSeq: destinationForStation(bootstrap, station.seq) };
  }).filter((x) => Number.isFinite(x.straightM) && Number.isFinite(x.destinationSeq))
    .sort((a, b) => a.straightM - b.straightM)
    .slice(0, CANDIDATES_PER_ROUTE);
}
function fallbackWalk(candidate) {
  const distanceM = Math.max(80, candidate.straightM * 1.28);
  const durationSec = Math.round(distanceM / 1.28);
  return { distanceM, durationSec, source: 'estimate', note: '도로망 API 연결 전 · 거리 기반 임시 추정' };
}
async function walkingEstimate(position, candidate) {
  if (walkApiAvailable !== false) {
    try {
      const c = stationCoordinates(candidate.station);
      const res = await fetch('/api/walk', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startX: position.lon,
          startY: position.lat,
          endX: c.lon,
          endY: c.lat
        })
      });
      if (res.status === 404 || res.status === 501) {
        walkApiAvailable = false;
      } else if (res.ok) {
        const data = await res.json();
        const durationSec = Number(data.durationSec ?? data.totalTime);
        const distanceM = Number(data.distanceM ?? data.totalDistance);
        if (Number.isFinite(durationSec) && Number.isFinite(distanceM)) {
          walkApiAvailable = true;
          return { durationSec, distanceM, source: data.source || 'walking-route', note: data.note || '실제 보행 경로 기준' };
        }
      }
    } catch {
      // walking API failure must not break commute calculation
    }
  }
  return fallbackWalk(candidate);
}
async function loadDashboard(route, stationSeq, destinationSeq) {
  const params = new URLSearchParams({ route, boardOrd: String(stationSeq), destOrd: String(destinationSeq), _: String(Date.now()) });
  return fetchJson(`/api/dashboard?${params}`);
}
function chooseCatchableBus(dashboard, walkSec) {
  const buses = Array.isArray(dashboard?.buses) ? dashboard.buses.filter((b) => Number.isFinite(Number(b?.etaSec))) : [];
  const required = Number(walkSec) + SAFETY_BUFFER_SEC;
  return buses.find((bus) => Number(bus.etaSec) >= required) || null;
}
async function buildOption(candidate, walk) {
  try {
    const dashboard = await loadDashboard(candidate.route, candidate.station.seq, candidate.destinationSeq);
    const chosenBus = chooseCatchableBus(dashboard, walk.durationSec);
    if (!chosenBus) return { ...candidate, walk, dashboard, viable: false, reason: '현재 표시된 차량은 도보 이동시간상 탑승하기 어려움' };
    const busEtaSec = Number(chosenBus.etaSec);
    const rideSec = Number(chosenBus.destinationRideSec ?? (Number(chosenBus.destinationEtaSec) - busEtaSec));
    const waitSec = Math.max(0, busEtaSec - walk.durationSec);
    const totalSec = Number(chosenBus.destinationEtaSec) + FINAL_CAMPUS_WALK_SEC;
    if (![rideSec, totalSec].every(Number.isFinite)) return { ...candidate, walk, dashboard, viable: false, reason: '학교 도착시간 계산 불가' };
    return {
      ...candidate,
      walk,
      dashboard,
      chosenBus,
      busEtaSec,
      rideSec,
      waitSec,
      finalWalkSec: FINAL_CAMPUS_WALK_SEC,
      totalSec,
      slackSec: busEtaSec - walk.durationSec - SAFETY_BUFFER_SEC,
      viable: true
    };
  } catch (error) {
    return { ...candidate, walk, viable: false, reason: error.message };
  }
}
async function calculateSmartCommute({ refreshBootstraps = false } = {}) {
  if (!currentPosition || calculating) return;
  const revision = originRevision;
  calculating = true;
  clearInterval(refreshTimer);
  setLoading('가까운 학교행 정류장을 비교하고 있어요', '거리만 보지 않고 학교까지 총 소요시간을 계산합니다.');
  setMode('계산 중');
  try {
    const loaded = await loadAvailableBootstraps(refreshBootstraps);
    if (revision !== originRevision) return;
    if (!loaded.length) throw new Error('버스 노선 정보를 불러오지 못했습니다.');
    const rawCandidates = loaded.flatMap(([route, bootstrap]) => nearestCandidates(currentPosition, route, bootstrap));
    if (!rawCandidates.length) throw new Error('위치 좌표가 포함된 학교행 정류장을 찾지 못했습니다.');

    const withWalk = await Promise.all(rawCandidates.map(async (candidate) => ({ candidate, walk: await walkingEstimate(currentPosition, candidate) })));
    if (revision !== originRevision) return;
    const accessible = withWalk.filter((x) => x.walk.durationSec <= MAX_ACCESS_WALK_SEC);
    if (!accessible.length) throw new Error('선택한 출발지에서 지원 노선의 승차 정류장까지 도보 25분 이내인 경로를 찾지 못했어요. 학교행 전체 대중교통 경로를 검색하는 서비스는 아니에요.');

    const options = await Promise.all(accessible.map((x) => buildOption(x.candidate, x.walk)));
    if (revision !== originRevision) return;
    rankedOptions = options.filter((x) => x.viable).sort((a, b) => a.totalSec - b.totalSec);
    if (!rankedOptions.length) throw new Error('현재 위치에서 바로 탈 수 있는 차량을 찾지 못했습니다. 잠시 후 다시 확인해 주세요.');

    activeOption = rankedOptions[0];
    renderOption(activeOption);
    renderAlternatives();
    hideLoading();
    $('recommendationCard').hidden = false;
    setMode(activeOption.dashboard?.mode === 'live' ? 'LIVE' : 'DEMO', activeOption.dashboard?.mode === 'live');
    refreshTimer = setInterval(() => {
      if (!document.hidden && currentPosition) calculateSmartCommute();
    }, 30000);
  } catch (error) {
    if (revision !== originRevision) return;
    setLoading('자동 경로를 만들지 못했어요', error.message);
    setMode('확인 필요');
    $('manualSection').hidden = false;
    await prepareManualMode();
  } finally {
    calculating = false;
    if (revision !== originRevision && currentPosition) queueMicrotask(() => calculateSmartCommute());
  }
}

function leaveGuidance(option) {
  const slack = Number(option.slackSec);
  if (slack >= 300) return { chip: '여유 있어요', cls: 'good', headline: `${Math.max(1, Math.floor(slack / 60))}분 뒤 출발해도 돼요`, reason: `정류장까지 ${formatMinutes(option.walk.durationSec)}, 버스는 ${formatMinutes(option.busEtaSec)} 후 도착 예정입니다.` };
  if (slack >= 90) return { chip: '곧 출발', cls: 'good', headline: `${Math.max(1, Math.floor(slack / 60))}분 안에 출발하세요`, reason: `안전 여유 ${formatMinutes(SAFETY_BUFFER_SEC)}를 포함해 계산했습니다.` };
  if (slack >= 0) return { chip: '지금 출발', cls: 'now', headline: '지금 출발하세요', reason: `현재 속도로 걸으면 약 ${formatMinutes(SAFETY_BUFFER_SEC + Math.max(0, slack))}의 탑승 여유가 있습니다.` };
  return { chip: '탑승 위험', cls: 'miss', headline: '다음 차량을 확인하세요', reason: '현재 차량은 정류장 도착 전에 지나갈 가능성이 있습니다.' };
}
function routeDecisionText(option) {
  const others = rankedOptions.filter((x) => x !== option);
  const nearestByWalk = [...rankedOptions].sort((a, b) => a.walk.durationSec - b.walk.durationSec)[0];
  if (nearestByWalk && nearestByWalk !== option) {
    const walkDiff = Math.max(1, Math.round((option.walk.durationSec - nearestByWalk.walk.durationSec) / 60));
    const totalGain = Math.max(1, Math.round((nearestByWalk.totalSec - option.totalSec) / 60));
    return `${nearestByWalk.station.stationNm}이 도보로 약 ${walkDiff}분 더 가깝지만, 현재 버스 도착·이동시간까지 합치면 이 경로가 학교에 약 ${totalGain}분 빨리 도착합니다.`;
  }
  if (others.length) {
    const diff = Math.max(1, Math.round((others[0].totalSec - option.totalSec) / 60));
    return `현재 이용 가능한 다른 경로보다 상명대 도착이 약 ${diff}분 빠릅니다. 가장 가까운 정류장이 아니라 전체 통학시간을 기준으로 계산합니다.`;
  }
  return '선택한 출발지에서 현실적으로 이용 가능한 학교행 정류장 중 총 통학시간이 짧은 경로입니다.';
}
function renderOption(option) {
  activeOption = option;
  const guide = leaveGuidance(option);
  const chip = $('leaveStatusChip');
  chip.textContent = guide.chip;
  chip.className = `leave-chip ${guide.cls}`;
  $('leaveHeadline').textContent = guide.headline;
  $('leaveReason').textContent = guide.reason;
  $('arrivalClock').textContent = formatClockFromNow(option.totalSec);
  $('routePill').textContent = option.route;
  $('boardingName').textContent = option.station.stationNm;
  $('boardingMeta').textContent = `${option.station.arsId ? `ARS ${option.station.arsId} · ` : ''}학교 방향`;
  $('totalTime').textContent = formatMinutes(option.totalSec);
  $('walkTime').textContent = formatMinutes(option.walk.durationSec);
  $('walkDistance').textContent = formatDistance(option.walk.distanceM);
  $('busEta').textContent = formatMinutes(option.busEtaSec);
  $('busRide').textContent = `탑승 후 약 ${formatMinutes(option.rideSec)}`;
  $('campusWalk').textContent = formatMinutes(option.finalWalkSec);
  $('walkSource').textContent = option.walk.source === 'estimate' ? '도보: 거리 기반 임시 추정' : '도보: 실제 보행 경로';
  $('updatedAt').textContent = `갱신 ${new Date(option.dashboard.updatedAt || Date.now()).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;

  $('detailWalk').textContent = `${formatDistance(option.walk.distanceM)} · 약 ${formatMinutes(option.walk.durationSec)}`;
  $('detailWalkBadge').textContent = `도보 ${formatMinutes(option.walk.durationSec)}`;
  $('detailBoarding').textContent = option.station.stationNm;
  $('detailBusWait').textContent = `${option.route} · 정류장 도착 후 약 ${formatMinutes(option.waitSec)} 대기`;
  $('detailBusBadge').textContent = `${option.route} · 약 ${formatMinutes(option.rideSec)}`;
  $('detailDestination').textContent = option.dashboard.destination?.stationNm || '상명대정문';
  $('detailRide').textContent = `버스 탑승 후 약 ${formatMinutes(option.rideSec)}`;
  $('detailFinalWalkBadge').textContent = `도보 ${formatMinutes(option.finalWalkSec)}`;
  $('detailArrival').textContent = `${formatClockFromNow(option.totalSec)} 도착 예상 · 총 ${formatMinutes(option.totalSec)}`;
  $('routeDecisionNote').textContent = routeDecisionText(option);
  $('detailOrigin').textContent = originLabel;
  $('originContext').hidden = originLabel === '현재 위치';
  $('originContext').textContent = `${originLabel}에서 지금 출발한다고 가정한 예상 시간이에요. 실제 이동 직전에 다시 확인하세요.`;

  renderMiniInfo(option.dashboard, option);
  renderHistorical(option.dashboard?.historical);
}
function renderAlternatives() {
  const list = $('alternativesList');
  list.innerHTML = '';
  const alternatives = rankedOptions.filter((x) => x !== activeOption).slice(0, 3);
  if (!alternatives.length) {
    list.innerHTML = '<div class="detail-note">현재 위치에서는 다른 현실적인 경로가 확인되지 않았습니다.</div>';
    return;
  }
  alternatives.forEach((option) => {
    const item = document.createElement('div');
    item.className = 'alternative-item';
    const button = document.createElement('button');
    button.type = 'button';
    const route = document.createElement('span'); route.className = 'alt-route'; route.textContent = option.route;
    const copy = document.createElement('div'); copy.className = 'alt-copy'; copy.innerHTML = `<strong>${option.station.stationNm}</strong><small>도보 ${formatMinutes(option.walk.durationSec)} · 버스 ${formatMinutes(option.busEtaSec)} 후</small>`;
    const time = document.createElement('div'); time.className = 'alt-time'; time.innerHTML = `<strong>${formatMinutes(option.totalSec)}</strong><small>${formatClockFromNow(option.totalSec)} 도착</small>`;
    button.append(route, copy, time);
    button.addEventListener('click', () => { renderOption(option); renderAlternatives(); $('alternativesSection').hidden = true; window.scrollTo({ top: 0, behavior: 'smooth' }); });
    item.appendChild(button); list.appendChild(item);
  });
}
function renderMiniInfo(dashboard) {
  const buses = dashboard?.buses || [];
  $('firstBusMini').textContent = formatMinutes(buses[0]?.etaSec);
  $('firstBusMiniSub').textContent = buses[0]?.arrMsg || '실시간 도착정보';
  $('nextBusMini').textContent = formatMinutes(buses[1]?.etaSec);
  $('nextBusMiniSub').textContent = buses[1]?.arrMsg || '두 번째 차량';
  const h = dashboard?.historical;
  $('demandMini').textContent = h?.available ? (h.level === 'high' ? '높음' : h.level === 'medium' ? '보통' : '낮음') : '-';
}
function renderHistorical(h) {
  const bars = $('hourlyBars'); bars.innerHTML = '';
  if (!h?.available) {
    $('histHour').textContent = '-'; $('histBoard').textContent = '-'; $('histAlight').textContent = '-'; $('histLevel').textContent = '미적재';
    $('passengerSource').textContent = '통계 미적재';
    $('histNote').textContent = '선택 경로의 월간 교통카드 승하차 데이터가 없거나 정류장 매칭이 되지 않았습니다.';
    return;
  }
  $('histHour').textContent = `${String(h.hour).padStart(2,'0')}~${String((h.hour + 1) % 24).padStart(2,'0')}시`;
  $('histBoard').textContent = `${Number(h.board || 0).toFixed(1)}명`;
  $('histAlight').textContent = `${Number(h.alight || 0).toFixed(1)}명`;
  $('histLevel').textContent = h.level === 'high' ? '높음' : h.level === 'medium' ? '보통' : '낮음';
  $('passengerSource').textContent = `${h.sourceMonth || '월간 데이터'} · 통계 기반`;
  const max = Math.max(1, ...(h.hours || []).map((x) => Number(x.board || 0)));
  (h.hours || []).forEach((x) => {
    const bar = document.createElement('div'); bar.className = `hour-bar${Number(x.hour) === Number(h.hour) ? ' current' : ''}`;
    bar.style.height = `${Math.max(3, Math.round(Number(x.board || 0) / max * 100))}%`; bars.appendChild(bar);
  });
  $('histNote').textContent = '실시간 혼잡도가 아니라 월간 교통카드 시간대별 일평균을 이용한 참고 정보입니다.';
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('이 브라우저는 위치 기능을 지원하지 않습니다.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: Number(pos.coords.latitude), lon: Number(pos.coords.longitude), accuracy: Number(pos.coords.accuracy) }),
      (err) => reject(new Error(err.code === 1 ? '위치 권한이 허용되지 않았습니다.' : '현재 위치를 확인하지 못했습니다.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  });
}
async function startLocationMode() {
  const revision = ++originRevision;
  setLoading('현재 위치를 확인하고 있어요', '정확한 좌표는 서버 DB에 저장하지 않습니다.');
  $('manualSection').hidden = true;
  try {
    const position = await getCurrentPosition();
    if (revision !== originRevision) return;
    currentPosition = position;
    originLabel = '현재 위치';
    $('originText').textContent = currentPosition.accuracy <= 50 ? '현재 위치 · 정확도 좋음' : `현재 위치 · 오차 약 ${Math.round(currentPosition.accuracy)}m`;
    await calculateSmartCommute({ refreshBootstraps: true });
  } catch (error) {
    if (revision !== originRevision) return;
    currentPosition = null;
    $('originText').textContent = '위치를 사용할 수 없음';
    setLoading('위치 없이도 이용할 수 있어요', error.message);
    $('manualSection').hidden = false;
    await prepareManualMode();
  }
}
async function refreshLocation() {
  if (locationConsentValue() !== 'granted') { showLocationSheet(); return; }
  await startLocationMode();
}

async function prepareManualMode() {
  const route = $('manualRoute').value;
  const select = $('manualStop'); select.innerHTML = '<option>불러오는 중</option>';
  try {
    const bootstrap = await loadBootstrap(route, true);
    const dests = destinationSeqs(bootstrap);
    const stations = (bootstrap.stations || []).filter((s) => !/상명대정문/.test(s.stationNm || '') && dests.some((d) => d > Number(s.seq)));
    select.innerHTML = '';
    stations.forEach((s) => { const o = document.createElement('option'); o.value = String(s.seq); o.textContent = `${s.stationNm}${s.arsId ? ` · ${s.arsId}` : ''}`; select.appendChild(o); });
  } catch (error) {
    select.innerHTML = `<option>${error.message}</option>`;
  }
}
async function runManualSearch() {
  ++originRevision;
  currentPosition = null;
  clearInterval(refreshTimer);
  originLabel = '직접 선택한 정류장';
  const route = $('manualRoute').value;
  const seq = Number($('manualStop').value);
  try {
    const bootstrap = await loadBootstrap(route);
    const dest = destinationForStation(bootstrap, seq);
    if (!Number.isFinite(dest)) throw new Error('학교 방향 목적지를 찾지 못했습니다.');
    setLoading('실시간 버스 정보를 확인하고 있어요', '직접 선택한 정류장을 기준으로 표시합니다.');
    const dashboard = await loadDashboard(route, seq, dest);
    const station = (bootstrap.stations || []).find((s) => Number(s.seq) === seq) || { stationNm: '선택 정류장', seq };
    const first = dashboard.buses?.[0];
    if (!first) throw new Error('도착 차량 정보가 없습니다.');
    const option = {
      route, bootstrap, station, destinationSeq: dest, dashboard, chosenBus: first,
      walk: { durationSec: 0, distanceM: 0, source: 'manual', note: '위치 미사용' },
      busEtaSec: Number(first.etaSec || 0), rideSec: Number(first.destinationRideSec || 0), waitSec: Number(first.etaSec || 0), finalWalkSec: FINAL_CAMPUS_WALK_SEC,
      totalSec: Number(first.destinationEtaSec || 0) + FINAL_CAMPUS_WALK_SEC, slackSec: 0, viable: true
    };
    rankedOptions = [option]; activeOption = option;
    renderOption(option); renderAlternatives(); hideLoading(); $('recommendationCard').hidden = false;
    $('walkTime').textContent = '직접 선택'; $('walkDistance').textContent = '위치 미사용'; $('walkSource').textContent = '위치 기능을 사용하지 않는 수동 모드';
    $('leaveStatusChip').textContent = '수동 모드'; $('leaveStatusChip').className = 'leave-chip good';
    $('leaveHeadline').textContent = `${route} 도착정보`;
    $('leaveReason').textContent = '현재 위치를 사용하지 않아 출발 시점과 총 도보시간은 계산하지 않습니다.';
    $('totalTime').textContent = first.destinationEtaSec ? formatMinutes(option.totalSec) : '-';
    setMode(dashboard.mode === 'live' ? 'LIVE' : 'DEMO', dashboard.mode === 'live');
  } catch (error) {
    setLoading('정류장 정보를 불러오지 못했어요', error.message);
  }
}

function openOriginSearch() {
  hideLocationSheet();
  $('originSearchPanel').hidden = false;
  $('originSearchPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('originQuery').focus({ preventScroll: true });
}
async function searchOriginPlaces(event) {
  event.preventDefault();
  const query = $('originQuery').value.trim();
  const status = $('originSearchStatus');
  const results = $('originSearchResults');
  const revision = ++originSearchRevision;
  results.replaceChildren();
  if (query.length < 2) { status.textContent = '장소나 주소를 두 글자 이상 입력해 주세요.'; return; }
  status.textContent = '장소를 검색하고 있어요…';
  try {
    const data = await fetchJson(`/api/places?query=${encodeURIComponent(query)}`);
    if (revision !== originSearchRevision) return;
    if (!data.places?.length) { status.textContent = '검색 결과가 없어요. 장소명을 조금 다르게 입력해 주세요.'; return; }
    status.textContent = '검색 결과에서 출발지를 선택하세요.';
    data.places.forEach((place) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'origin-result';
      const title = document.createElement('strong');
      title.textContent = place.name;
      const address = document.createElement('small');
      address.textContent = place.address || '주소 정보 없음';
      button.append(title, address);
      button.addEventListener('click', () => selectOriginPlace(place));
      results.appendChild(button);
    });
  } catch (error) {
    if (revision === originSearchRevision) status.textContent = error.message || '장소 검색에 실패했어요.';
  }
}
async function selectOriginPlace(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  ++originRevision;
  ++originSearchRevision;
  clearInterval(refreshTimer);
  currentPosition = { lat, lon, accuracy: 0 };
  originLabel = place.name;
  $('originText').textContent = `직접 설정 · ${place.name}`;
  $('originSearchPanel').hidden = true;
  $('manualSection').hidden = true;
  $('recommendationCard').hidden = true;
  $('routeDetail').hidden = true;
  $('alternativesSection').hidden = true;
  setLoading('선택한 출발지에서 학교행 경로를 찾고 있어요', `${place.name}에서 지금 출발하는 상황을 가정합니다.`);
  await calculateSmartCommute({ refreshBootstraps: false });
}
$('searchOriginFromSheet').addEventListener('click', () => {
  localStorage.setItem(LOCATION_CONSENT_KEY, 'manual');
  openOriginSearch();
});
$('openOriginSearch').addEventListener('click', openOriginSearch);
$('closeOriginSearch').addEventListener('click', () => { $('originSearchPanel').hidden = true; });
$('originSearchForm').addEventListener('submit', searchOriginPlaces);
$('useCurrentOrigin').addEventListener('click', async () => {
  $('originSearchPanel').hidden = true;
  ++originRevision;
  ++originSearchRevision;
  clearInterval(refreshTimer);
  currentPosition = null;
  originLabel = '현재 위치';
  await refreshLocation();
});
$('locationConsentCheck').addEventListener('change', (event) => { $('allowLocationButton').disabled = !event.target.checked; });
$('allowLocationButton').addEventListener('click', async () => { localStorage.setItem(LOCATION_CONSENT_KEY, 'granted'); hideLocationSheet(); await startLocationMode(); });
$('manualModeButton').addEventListener('click', async () => { localStorage.setItem(LOCATION_CONSENT_KEY, 'manual'); hideLocationSheet(); ++originRevision; clearInterval(refreshTimer); currentPosition = null; $('originText').textContent = '위치 미사용'; $('loadingCard').hidden = true; $('manualSection').hidden = false; await prepareManualMode(); });
$('termsButton').addEventListener('click', () => showInfo('위치정보 이용 안내', '<p><strong>이용 목적</strong><br>현재 위치에서 학교행 정류장까지의 거리와 이동시간, 통학 경로를 계산하기 위해 위치정보를 사용합니다.</p><p><strong>저장 원칙</strong><br>정확한 위도·경도는 서비스 DB에 영구 저장하지 않는 구조를 전제로 합니다. 실제 공개 운영 전에는 위치기반서비스 이용약관과 신고 의무를 별도로 최종 검토해야 합니다.</p>'));
$('privacyButton').addEventListener('click', () => showInfo('개인정보 처리 원칙', '<p><strong>최소 수집</strong><br>경로 계산에 필요한 현재 위치만 요청합니다.</p><p><strong>대체 이용</strong><br>위치 권한을 허용하지 않아도 노선과 정류장을 직접 선택해 실시간 버스정보를 확인할 수 있습니다.</p><p><strong>외부 경로 API</strong><br>실제 보행 경로 API를 연결할 경우 해당 사업자의 이용약관·보관 제한·표시 의무를 함께 적용해야 합니다.</p>'));
$('closeInfoSheet').addEventListener('click', () => { $('infoSheet').hidden = true; });
$('refreshLocationButton').addEventListener('click', refreshLocation);
$('showRouteButton').addEventListener('click', () => { $('routeDetail').hidden = !$('routeDetail').hidden; if (!$('routeDetail').hidden) $('routeDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('closeRouteButton').addEventListener('click', () => { $('routeDetail').hidden = true; });
$('showAlternativesButton').addEventListener('click', () => { $('alternativesSection').hidden = !$('alternativesSection').hidden; if (!$('alternativesSection').hidden) $('alternativesSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('closeAlternativesButton').addEventListener('click', () => { $('alternativesSection').hidden = true; });
$('manualRoute').addEventListener('change', prepareManualMode);
$('manualSearchButton').addEventListener('click', runManualSearch);
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPosition && !calculating) calculateSmartCommute(); });

async function init() {
  const consent = locationConsentValue();
  if (consent === 'granted') {
    await startLocationMode();
  } else if (consent === 'manual') {
    $('originText').textContent = '위치 미사용';
    $('loadingCard').hidden = true;
    $('manualSection').hidden = false;
    await prepareManualMode();
    setMode('수동 모드');
  } else {
    setLoading('현재 위치를 기준으로 통학 경로를 계산해요', '위치정보 이용 안내를 확인한 뒤 시작할 수 있습니다.');
    showLocationSheet();
  }
}

init();
