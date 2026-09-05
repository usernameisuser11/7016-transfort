const $ = (id) => document.getElementById(id);

const ROUTES = ['종로13', '서대문08', '7016'];
let selectedRoute = ROUTES.includes(localStorage.getItem('smu-route')) ? localStorage.getItem('smu-route') : '7016';
let bootstrap = null;
let timer = null;
let currentDashboard = null;
let dashboardController = null;
let dashboardRequestId = 0;
let boardingStations = [];

function formatMinutes(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const s = Math.max(0, Number(sec));
  if (s < 60) return `${Math.max(1, Math.round(s))}초`;
  return `${Math.max(1, Math.round(s / 60))}분`;
}
function formatClockFromNow(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const d = new Date(Date.now() + Number(sec) * 1000);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatSourceMonth(value) {
  const s = String(value || '');
  const m = s.match(/^(\d{4})[-.]?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : s;
}
function stationLabel(s) {
  if (!s) return '정류장 선택';
  return `${String(s.seq).padStart(2, '0')} · ${s.stationNm}${s.arsId ? ` · ${s.arsId}` : ''}`;
}
function boardStorageKey() { return `smu-board-${selectedRoute}`; }
function routeDestinationSeqs() {
  const list = Array.isArray(bootstrap?.destinationSeqs) ? bootstrap.destinationSeqs.map(Number).filter(Number.isFinite) : [];
  if (list.length) return list.sort((a, b) => a - b);
  const single = Number(bootstrap?.destinationSeq);
  return Number.isFinite(single) ? [single] : [];
}
function destinationForBoarding(seq) {
  return routeDestinationSeqs().find(dest => dest > Number(seq)) ?? null;
}
function setRouteIdentity(route = selectedRoute) {
  $('routeBadge').textContent = route;
  $('pageHeading').textContent = `${route} 상명대 통학`;
  document.title = `${route} · 상명대 통학`;
  $('recommendationReason').textContent = `${route}의 도착시간과 혼잡도를 비교합니다`;
  $('runningRouteNote').textContent = `현재 ${route} 노선`;
  document.querySelectorAll('.route-choice').forEach(button => {
    const active = button.dataset.route === route;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}
function setBusy(v, status = '') {
  const button = $('refreshButton');
  button.disabled = Boolean(v);
  button.classList.toggle('is-loading', Boolean(v));
  button.setAttribute('aria-busy', v ? 'true' : 'false');
  button.textContent = v ? '갱신 중' : '새로고침';
  document.querySelectorAll('.route-choice').forEach(x => { x.disabled = Boolean(v); });
  if (status) $('refreshStatus').textContent = status;
}
function setModeBadge(mode, note = '') {
  const badge = $('modeBadge');
  badge.className = mode === 'live' ? 'status-chip live' : 'status-chip';
  if (mode === 'live') badge.textContent = 'LIVE API';
  else if (mode === 'demo') badge.textContent = 'DEMO';
  else if (mode === 'fallback') badge.textContent = 'API 확인 필요';
  else if (mode === 'stale') badge.textContent = 'STALE';
  else badge.textContent = note || '연결 중';
}
function clearRealtimeData() {
  $('nextBusEta').textContent = '-';
  $('nextBusMessage').textContent = '도착 정보 없음';
  $('actualHeadway').textContent = '-';
  $('scheduledHeadway').textContent = '공식 배차 -';
  $('schoolEta').textContent = '-';
  $('rideTime').textContent = '예상 이동시간 -';
  $('runningCount').textContent = '-';
  for (const idx of [1, 2]) {
    $('busEta' + idx).textContent = '-';
    $('busArrMsg' + idx).textContent = '도착정보 없음';
    $('busNo' + idx).textContent = '-';
    $('busSchool' + idx).textContent = '-';
    $('lowFloor' + idx).textContent = '-';
    const badge = $('congestion' + idx);
    badge.className = 'congestion unknown';
    badge.textContent = '정보 없음';
    $('busMarker' + idx).style.display = 'none';
  }
  const routeSummary = $('routePositionSummary');
  if (routeSummary) routeSummary.textContent = '실시간 차량 위치를 기다리는 중입니다';
}
function setPickerOpen(open) {
  const menu = $('boardingPickerMenu');
  const button = $('boardingPickerButton');
  menu.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    $('boardingSearch').value = '';
    renderBoardingOptions('');
    requestAnimationFrame(() => $('boardingSearch').focus());
  }
}
function renderBoardingOptions(query = '') {
  const box = $('boardingOptions');
  const q = String(query).trim().toLowerCase().replace(/\s+/g, '');
  const selected = Number($('boardingSelect').value);
  const matches = boardingStations.filter((s) => {
    if (!q) return true;
    const hay = `${s.seq}${s.stationNm}${s.arsId || ''}`.toLowerCase().replace(/\s+/g, '');
    return hay.includes(q);
  });
  box.innerHTML = '';
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = '검색 결과가 없어';
    box.appendChild(empty);
    return;
  }
  for (const s of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker-option${Number(s.seq) === selected ? ' selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', Number(s.seq) === selected ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'picker-option-name';
    name.textContent = s.stationNm;
    const meta = document.createElement('span');
    meta.className = 'picker-option-meta';
    meta.textContent = `${String(s.seq).padStart(2, '0')}${s.arsId ? ` · ${s.arsId}` : ''}`;
    button.append(name, meta);
    button.addEventListener('click', () => selectBoardingStation(Number(s.seq), true));
    box.appendChild(button);
  }
}
function applyDestinationForBoarding(seq) {
  const destSeq = destinationForBoarding(seq);
  const stations = Array.isArray(bootstrap?.stations) ? bootstrap.stations : [];
  const destination = stations.find(s => Number(s.seq) === Number(destSeq));
  $('destinationSelect').value = Number.isFinite(Number(destSeq)) ? String(destSeq) : '';
  $('destinationText').textContent = destination?.stationNm || '상명대정문';
  $('routeEndLabel').textContent = destination?.stationNm || '상명대정문';
  return destSeq;
}
function selectBoardingStation(seq, reload = false) {
  const station = boardingStations.find((s) => Number(s.seq) === Number(seq));
  if (!station) return;
  $('boardingSelect').value = String(station.seq);
  $('boardingPickerText').textContent = stationLabel(station);
  $('routeStartLabel').textContent = station.stationNm;
  applyDestinationForBoarding(station.seq);
  localStorage.setItem(boardStorageKey(), String(station.seq));
  setPickerOpen(false);
  if (reload && bootstrap?.mode !== 'fallback') {
    loadDashboard({ manual: true });
  } else if (reload && bootstrap?.mode === 'fallback') {
    $('recommendationTitle').textContent = `${station.stationNm} 선택 완료`;
    $('recommendationReason').textContent = '정류장 목록은 정상입니다. 실시간 서울 버스 API 인증을 확인하면 도착정보가 표시됩니다.';
  }
}
function populateStations() {
  const stations = Array.isArray(bootstrap?.stations) ? bootstrap.stations : [];
  const destinations = routeDestinationSeqs();
  boardingStations = stations.filter(s => !/상명대정문/.test(s.stationNm) && destinations.some(dest => dest > Number(s.seq)));
  if (!boardingStations.length) {
    $('boardingPickerText').textContent = '등교 방향 정류장을 찾지 못했어';
    $('boardingPickerButton').classList.add('has-error');
    $('stopCountBadge').textContent = '정류장 오류';
    return false;
  }
  $('boardingPickerButton').classList.remove('has-error');
  const saved = Number(localStorage.getItem(boardStorageKey()));
  const savedStation = boardingStations.find((s) => Number(s.seq) === saved);
  const suggested = boardingStations.find((s) => Number(s.seq) === Number(bootstrap.suggestedBoardingSeq));
  const defaultStation = savedStation || suggested || boardingStations[0];
  selectBoardingStation(defaultStation.seq, false);
  renderBoardingOptions('');
  $('stopCountBadge').textContent = `등교 방향 ${boardingStations.length}개`;
  return true;
}
function renderBus(bus, idx) {
  $('busEta' + idx).textContent = formatMinutes(bus?.etaSec);
  $('busArrMsg' + idx).textContent = bus?.arrMsg || '도착정보 없음';
  $('busNo' + idx).textContent = bus?.plainNo || '-';
  if (bus?.destinationEtaSec != null) {
    const sourceNote = bus.destinationEtaSource === 'vehicle-match' ? '' : ' · 추정';
    $('busSchool' + idx).textContent = `${formatClockFromNow(bus.destinationEtaSec)} · ${formatMinutes(bus.destinationEtaSec)}${sourceNote}`;
  } else {
    $('busSchool' + idx).textContent = '-';
  }
  $('lowFloor' + idx).textContent = bus?.lowFloor ? '예' : '아니오/미확인';
  const badge = $('congestion' + idx);
  badge.className = `congestion ${bus?.congestion?.level || 'unknown'}`;
  badge.textContent = bus?.congestion?.label || '정보 없음';
}
function renderMarkers(data) {
  const boardOrd = Number(data?.boarding?.ord);
  const destOrd = Number(data?.destination?.ord);
  const span = Math.max(1, destOrd - boardOrd);
  const statuses = [];
  [1, 2].forEach((n) => { $('busMarker' + n).style.display = 'none'; });
  (data.buses || []).slice(0, 2).forEach((bus, i) => {
    const marker = $('busMarker' + (i + 1));
    const ord = Number(bus?.sectionOrd);
    const label = i === 0 ? '첫 버스' : '다음 버스';
    const etaText = bus?.etaSec != null ? ` · 약 ${formatMinutes(bus.etaSec)}` : '';
    if (!Number.isFinite(ord)) { statuses.push(`${label} 위치 확인 중${etaText}`); return; }
    if (ord < boardOrd) { statuses.push(`${label} ${Math.max(1, Math.round(boardOrd - ord))}정류장 전${etaText}`); return; }
    if (ord > destOrd) { statuses.push(`${label} 상명대 통과`); return; }
    marker.style.display = 'grid';
    marker.style.left = `${Math.max(0, Math.min(1, (ord - boardOrd) / span)) * 100}%`;
    statuses.push(ord === boardOrd ? `${label} 승차 정류장 구간${etaText}` : `${label} 상명대 방향 운행 중`);
  });
  $('routePositionSummary').textContent = statuses.length ? statuses.join(' / ') : '실시간 차량 위치를 확인할 수 없습니다';
}
function demandLabel(level) { return level === 'high' ? '높음' : level === 'medium' ? '보통' : '낮음'; }
function renderHistorical(h) {
  const bars = $('hourlyBars');
  bars.innerHTML = '';
  if (!h || !h.available) {
    $('histHour').textContent = '-';
    $('histBoard').textContent = '-';
    $('histAlight').textContent = '-';
    $('histLevel').textContent = '미적재';
    if (h?.routeUnsupported) {
      $('passengerSource').textContent = `${selectedRoute} · 승하차 데이터 미적재`;
      $('histNote').textContent = `${selectedRoute} 월간 승하차 데이터는 아직 추가하지 않았습니다`;
    } else {
      $('passengerSource').textContent = h?.sourceMonth ? `${formatSourceMonth(h.sourceMonth)} · 정류장 매칭 없음` : '승하차 데이터 미적재';
      $('histNote').textContent = '선택 정류장의 월간 승하차 데이터를 찾지 못했습니다';
    }
    return;
  }
  $('histHour').textContent = `${String(h.hour).padStart(2, '0')}~${String((h.hour + 1) % 24).padStart(2, '0')}시`;
  $('histBoard').textContent = `${Number(h.board).toFixed(1)}명`;
  $('histAlight').textContent = `${Number(h.alight).toFixed(1)}명`;
  $('histLevel').textContent = demandLabel(h.level);
  const sourceMonth = formatSourceMonth(h.sourceMonth || '월간 데이터');
  $('passengerSource').textContent = `${sourceMonth}${h.valueBasis === 'daily-average' ? ' · 시간대 일평균' : ''}${h.demo ? ' · DEMO' : ''}`;
  $('histNote').textContent = h.ambiguousName
    ? '정류장 ID를 매칭하지 못해 같은 이름의 양방향 정류장을 합산한 일평균 참고값입니다'
    : '해당 월의 시간대별 일평균 교통카드 승하차 패턴입니다';
  const max = Math.max(1, ...(h.hours || []).map((x) => Number(x.board || 0)));
  (h.hours || []).forEach((x) => {
    const bar = document.createElement('div');
    bar.className = 'hour-bar' + (x.hour === h.hour ? ' current' : '');
    bar.style.height = `${Math.max(3, Math.round(Number(x.board || 0) / max * 100))}%`;
    bar.dataset.label = `${String(x.hour).padStart(2, '0')}시 일평균 ${Number(x.board || 0).toFixed(1)}명`;
    bars.appendChild(bar);
  });
}
function render(data) {
  currentDashboard = data;
  const routeName = data.routeName || selectedRoute;
  selectedRoute = routeName;
  setRouteIdentity(routeName);
  setModeBadge(data.mode || bootstrap?.mode || 'live');
  const rec = data.recommendation || {};
  $('recommendationTitle').textContent = rec.title || `${routeName} 확인`;
  $('recommendationReason').textContent = rec.reason || '';
  $('recommendationIcon').textContent = rec.action === 'WAIT_NEXT' ? 'NEXT' : routeName;
  const b1 = data.buses?.[0];
  $('nextBusEta').textContent = formatMinutes(b1?.etaSec);
  $('nextBusMessage').textContent = b1?.arrMsg || '도착 정보 없음';
  $('actualHeadway').textContent = data.actualHeadwayMin == null ? '-' : `${data.actualHeadwayMin}분`;
  $('scheduledHeadway').textContent = `공식 배차 ${data.scheduledTermMin ?? '-'}분`;
  $('schoolEta').textContent = formatClockFromNow(b1?.destinationEtaSec);
  if (b1?.destinationEtaSec == null) $('rideTime').textContent = '예상 이동시간 -';
  else $('rideTime').textContent = `지금부터 약 ${formatMinutes(b1.destinationEtaSec)} · ${b1.destinationEtaSource === 'vehicle-match' ? '실시간 예측' : '구간 추정'}`;
  $('runningCount').textContent = data.runningBusCount == null ? '-' : `${data.runningBusCount}대`;
  renderBus(data.buses?.[0], 1);
  renderBus(data.buses?.[1], 2);
  renderHistorical(data.historical);
  $('routeStartLabel').textContent = data.boarding?.stationNm || '승차';
  $('routeEndLabel').textContent = data.destination?.stationNm || '상명대정문';
  $('destinationText').textContent = data.destination?.stationNm || '상명대정문';
  $('updatedAt').textContent = `갱신 ${new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  renderMarkers(data);
}
async function loadDashboard(options = {}) {
  if (!bootstrap) return;
  const manual = Boolean(options.manual);
  const requestId = ++dashboardRequestId;
  if (bootstrap.mode === 'fallback' && !manual) return;
  if (dashboardController) dashboardController.abort();
  dashboardController = new AbortController();
  const boardOrd = Number($('boardingSelect').value);
  if (!Number.isFinite(boardOrd)) {
    $('recommendationTitle').textContent = '정류장 정보를 확인해줘';
    $('recommendationReason').textContent = '승차 정류장 정보가 아직 준비되지 않았어';
    return;
  }
  applyDestinationForBoarding(boardOrd);
  localStorage.setItem(boardStorageKey(), String(boardOrd));
  setBusy(true, manual ? '수동 새로고침 중…' : `${selectedRoute} 실시간 데이터 갱신 중…`);
  try {
    const params = new URLSearchParams({ route: selectedRoute, boardOrd: String(boardOrd), _: String(Date.now()) });
    const destOrd = Number($('destinationSelect').value);
    if (Number.isFinite(destOrd)) params.set('destOrd', String(destOrd));
    const res = await fetch(`/api/dashboard?${params}`, { cache: 'no-store', signal: dashboardController.signal, headers: { 'Cache-Control': 'no-cache' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `실시간 API HTTP ${res.status}`);
    if (requestId !== dashboardRequestId) return;
    render(data);
    $('refreshStatus').textContent = `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 갱신 완료`;
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== dashboardRequestId) return;
    currentDashboard = null;
    clearRealtimeData();
    setModeBadge('stale');
    $('recommendationTitle').textContent = `${selectedRoute} 실시간 API 연결 확인 필요`;
    $('recommendationReason').textContent = err.message;
    $('refreshStatus').textContent = 'API 연결 실패 · 실시간 값 숨김';
    $('updatedAt').textContent = '갱신 실패';
  } finally {
    if (requestId === dashboardRequestId) setBusy(false);
  }
}
function renderAiAdvice(payload) {
  const advice = payload?.advice;
  if (!advice) return;
  $('aiEmpty').hidden = true;
  $('aiResult').hidden = false;
  const badge = $('aiDecisionBadge');
  if (advice.decision === 'TAKE_NOW') { badge.textContent = '이번 차'; badge.className = 'ai-decision take'; }
  else if (advice.decision === 'WAIT_NEXT') { badge.textContent = '다음 차'; badge.className = 'ai-decision wait'; }
  else { badge.textContent = '참고'; badge.className = 'ai-decision neutral'; }
  $('aiHeadline').textContent = advice.headline || 'AI 분석 완료';
  $('aiReason').textContent = advice.reason || '-';
  $('aiRisk').textContent = advice.risk || '-';
  $('aiTip').textContent = advice.tip || '-';
  $('aiModel').textContent = advice.source === 'gemini'
    ? `Gemini · ${advice.model || 'configured model'} · 현재 데이터 기준`
    : (payload.configured ? 'Gemini 호출 실패 · 규칙 기반 fallback' : 'Gemini 미설정 · 규칙 기반 fallback');
}
async function loadAiAdvice() {
  if (!currentDashboard) {
    $('aiEmpty').hidden = false;
    $('aiResult').hidden = true;
    $('aiEmpty').textContent = '먼저 실시간 버스 데이터를 불러와야 AI 분석을 사용할 수 있어';
    return;
  }
  const button = $('aiAdviceButton');
  button.disabled = true;
  button.textContent = '분석 중';
  try {
    const res = await fetch('/api/ai-advice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentDashboard) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gemini 분석 실패');
    renderAiAdvice(data);
  } catch (err) {
    $('aiEmpty').hidden = false;
    $('aiResult').hidden = true;
    $('aiEmpty').textContent = `AI 분석 오류: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Gemini 분석';
  }
}
async function loadFallbackBootstrap(apiError) {
  if (selectedRoute !== '7016') throw new Error(apiError || `${selectedRoute} 실시간 API를 불러오지 못했습니다.`);
  const res = await fetch(`/7016-schoolbound-stops.json?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('정류장 fallback 파일도 불러오지 못했습니다.');
  const stations = await res.json();
  const destination = stations.find((s) => /상명대정문/.test(s.stationNm)) || stations.at(-1);
  const suggested = stations.find((s) => /경복궁역3번출구/.test(s.stationNm)) || stations[Math.max(0, stations.length - 8)];
  return {
    mode: 'fallback', routes: ROUTES, selectedRoute: '7016', stations, stopCount: stations.length,
    suggestedBoardingSeq: suggested?.seq, destinationSeq: destination?.seq, destinationSeqs: [destination?.seq],
    geminiConfigured: false, apiError
  };
}
async function init() {
  clearInterval(timer);
  if (dashboardController) dashboardController.abort();
  setRouteIdentity(selectedRoute);
  setBusy(true, `${selectedRoute} 노선 정보 불러오는 중…`);
  currentDashboard = null;
  clearRealtimeData();
  $('boardingPickerText').textContent = '정류장 불러오는 중';
  try {
    let apiError = null;
    try {
      const res = await fetch(`/api/bootstrap?route=${encodeURIComponent(selectedRoute)}&_=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `서울 버스 API HTTP ${res.status}`);
      bootstrap = data;
    } catch (err) {
      apiError = err.message;
      bootstrap = await loadFallbackBootstrap(apiError);
    }
    setModeBadge(bootstrap.mode);
    const populated = populateStations();
    if (!populated) throw new Error('등교 방향 정류장 목록이 비어 있습니다.');
    if (bootstrap.mode === 'fallback') {
      clearRealtimeData();
      $('recommendationTitle').textContent = '정류장 목록은 정상적으로 불러왔어';
      $('recommendationReason').textContent = `실시간 서울 버스 API는 연결 확인이 필요해 · ${bootstrap.apiError}`;
      $('refreshStatus').textContent = '7016 정류장 목록 fallback 사용 중';
      return;
    }
    if (!bootstrap.geminiConfigured) $('aiEmpty').textContent = 'Gemini API 키를 넣으면 현재 배차와 혼잡도를 추가 분석할 수 있어';
    await loadDashboard({ manual: false });
    timer = setInterval(() => loadDashboard({ manual: false }), 30000);
  } catch (err) {
    clearRealtimeData();
    setModeBadge('error', 'ERROR');
    $('recommendationTitle').textContent = `${selectedRoute} 불러오기 실패`;
    $('recommendationReason').textContent = err.message;
    $('boardingPickerText').textContent = '정류장 로드 실패';
  } finally {
    setBusy(false);
  }
}

$('boardingPickerButton').addEventListener('click', (event) => { event.stopPropagation(); setPickerOpen($('boardingPickerMenu').hidden); });
$('boardingPickerMenu').addEventListener('click', (event) => event.stopPropagation());
$('boardingSearch').addEventListener('input', (event) => renderBoardingOptions(event.target.value));
document.addEventListener('click', () => setPickerOpen(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPickerOpen(false); });
$('aiAdviceButton').addEventListener('click', loadAiAdvice);
$('refreshButton').addEventListener('click', () => { if (bootstrap?.mode === 'fallback') init(); else loadDashboard({ manual: true }); });
document.querySelectorAll('.route-choice').forEach(button => {
  button.addEventListener('click', () => {
    const route = button.dataset.route;
    if (!ROUTES.includes(route) || route === selectedRoute) return;
    selectedRoute = route;
    localStorage.setItem('smu-route', route);
    setPickerOpen(false);
    init();
  });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && bootstrap?.mode !== 'fallback') loadDashboard({ manual: false }); });

setRouteIdentity(selectedRoute);
init();