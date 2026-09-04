const $ = (id) => document.getElementById(id);
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

function stationLabel(s) {
  if (!s) return '정류장 선택';
  return `${String(s.seq).padStart(2, '0')} · ${s.stationNm}${s.arsId ? ` · ${s.arsId}` : ''}`;
}

function setBusy(v, status = '') {
  const button = $('refreshButton');
  button.disabled = false;
  button.classList.toggle('is-loading', Boolean(v));
  button.setAttribute('aria-busy', v ? 'true' : 'false');
  button.textContent = v ? '갱신 중' : '새로고침';
  if (status) $('refreshStatus').textContent = status;
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

function selectBoardingStation(seq, reload = false) {
  const station = boardingStations.find((s) => Number(s.seq) === Number(seq));
  if (!station) return;
  $('boardingSelect').value = String(station.seq);
  $('boardingPickerText').textContent = stationLabel(station);
  localStorage.setItem('7016-board-seq', String(station.seq));
  setPickerOpen(false);
  if (reload) loadDashboard({ manual: true });
}

function populateStations() {
  const stations = Array.isArray(bootstrap?.stations) ? bootstrap.stations : [];
  const destinationDefault = Number(bootstrap?.destinationSeq);
  const destination = stations.find((s) => Number(s.seq) === destinationDefault) || stations.find((s) => /상명대정문/.test(s.stationNm));

  boardingStations = stations.filter((s) => Number(s.seq) < destinationDefault);
  $('destinationSelect').value = Number.isFinite(destinationDefault) ? String(destinationDefault) : '';
  $('destinationText').textContent = destination?.stationNm || '상명대정문';

  if (!boardingStations.length) {
    $('boardingPickerText').textContent = '정류장 목록을 불러오지 못했어';
    $('boardingPickerButton').classList.add('has-error');
    $('stopCountBadge').textContent = '정류장 오류';
    return;
  }

  $('boardingPickerButton').classList.remove('has-error');
  const saved = Number(localStorage.getItem('7016-board-seq'));
  const savedStation = boardingStations.find((s) => Number(s.seq) === saved);
  const suggested = boardingStations.find((s) => Number(s.seq) === Number(bootstrap.suggestedBoardingSeq));
  const defaultStation = savedStation || suggested || boardingStations[0];
  selectBoardingStation(defaultStation.seq, false);
  renderBoardingOptions('');
  $('stopCountBadge').textContent = `학교 방향 ${bootstrap.stopCount || stations.length}개`;
}

function renderBus(bus, idx) {
  $('busEta' + idx).textContent = formatMinutes(bus?.etaSec);
  $('busArrMsg' + idx).textContent = bus?.arrMsg || '도착정보 없음';
  $('busNo' + idx).textContent = bus?.plainNo || '-';
  $('busSchool' + idx).textContent = bus?.destinationEtaSec != null
    ? `${formatClockFromNow(bus.destinationEtaSec)} · ${formatMinutes(bus.destinationEtaSec)}`
    : '-';
  $('lowFloor' + idx).textContent = bus?.lowFloor ? '예' : '아니오/미확인';
  const badge = $('congestion' + idx);
  badge.className = `congestion ${bus?.congestion?.level || 'unknown'}`;
  badge.textContent = bus?.congestion?.label || '정보 없음';
}

function renderMarkers(data) {
  const boardOrd = data.boarding.ord;
  const destOrd = data.destination.ord;
  const span = Math.max(1, destOrd - boardOrd);
  [1, 2].forEach((n) => { $('busMarker' + n).style.display = 'none'; });
  (data.buses || []).slice(0, 2).forEach((bus, i) => {
    const marker = $('busMarker' + (i + 1));
    const ord = Number(bus?.sectionOrd);
    if (!Number.isFinite(ord)) return;
    marker.style.display = 'grid';
    const progress = Math.max(0, Math.min(1, (ord - boardOrd) / span));
    marker.style.left = `${progress * 100}%`;
  });
}

function demandLabel(level) {
  return level === 'high' ? '높음' : level === 'medium' ? '보통' : '낮음';
}

function renderHistorical(h) {
  const bars = $('hourlyBars');
  bars.innerHTML = '';
  if (!h || !h.available) {
    $('histHour').textContent = '-';
    $('histBoard').textContent = '-';
    $('histAlight').textContent = '-';
    $('histLevel').textContent = '미적재';
    $('passengerSource').textContent = h?.sourceMonth ? `${h.sourceMonth} · 정류장 매칭 없음` : '승하차 데이터 미적재';
    $('histNote').textContent = '선택 정류장의 월간 승하차 데이터를 찾지 못했습니다';
    return;
  }

  $('histHour').textContent = `${String(h.hour).padStart(2, '0')}~${String((h.hour + 1) % 24).padStart(2, '0')}시`;
  $('histBoard').textContent = `${Number(h.board).toFixed(1)}명`;
  $('histAlight').textContent = `${Number(h.alight).toFixed(1)}명`;
  $('histLevel').textContent = demandLabel(h.level);
  $('passengerSource').textContent = `${h.sourceMonth || '월간 데이터'}${h.demo ? ' · DEMO' : ''}`;
  $('histNote').textContent = h.ambiguousName
    ? '같은 이름의 양방향 정류장을 합산한 참고값입니다'
    : '시간대별 교통카드 승하차 패턴입니다';

  const max = Math.max(1, ...(h.hours || []).map((x) => Number(x.board || 0)));
  (h.hours || []).forEach((x) => {
    const bar = document.createElement('div');
    bar.className = 'hour-bar' + (x.hour === h.hour ? ' current' : '');
    bar.style.height = `${Math.max(3, Math.round(Number(x.board || 0) / max * 100))}%`;
    bar.dataset.label = `${String(x.hour).padStart(2, '0')}시 ${Number(x.board || 0).toFixed(1)}명`;
    bars.appendChild(bar);
  });
}

function render(data) {
  currentDashboard = data;
  const rec = data.recommendation || {};
  $('recommendationTitle').textContent = rec.title || '7016 확인';
  $('recommendationReason').textContent = rec.reason || '';
  $('recommendationIcon').textContent = rec.action === 'WAIT_NEXT' ? '다음 차' : '이번 차';

  const b1 = data.buses?.[0];
  $('nextBusEta').textContent = formatMinutes(b1?.etaSec);
  $('nextBusMessage').textContent = b1?.arrMsg || '도착 정보 없음';
  $('actualHeadway').textContent = data.actualHeadwayMin == null ? '-' : `${data.actualHeadwayMin}분`;
  $('scheduledHeadway').textContent = `공식 배차 ${data.scheduledTermMin ?? '-'}분`;
  $('schoolEta').textContent = formatClockFromNow(b1?.destinationEtaSec);
  $('rideTime').textContent = b1?.destinationEtaSec == null ? '예상 이동시간 -' : `지금부터 약 ${formatMinutes(b1.destinationEtaSec)}`;
  $('runningCount').textContent = data.runningBusCount == null ? '-' : `${data.runningBusCount}대`;

  renderBus(data.buses?.[0], 1);
  renderBus(data.buses?.[1], 2);
  renderHistorical(data.historical);
  $('routeStartLabel').textContent = data.boarding.stationNm;
  $('routeEndLabel').textContent = data.destination.stationNm;
  $('updatedAt').textContent = `갱신 ${new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  renderMarkers(data);
}

async function loadDashboard(options = {}) {
  if (!bootstrap) return;
  const manual = Boolean(options.manual);
  const requestId = ++dashboardRequestId;

  if (dashboardController) dashboardController.abort();
  dashboardController = new AbortController();

  const boardOrd = Number($('boardingSelect').value);
  const destOrd = Number($('destinationSelect').value);
  if (!Number.isFinite(boardOrd) || !Number.isFinite(destOrd)) {
    $('recommendationTitle').textContent = '정류장 정보를 확인해줘';
    $('recommendationReason').textContent = '승차 정류장 또는 목적지 정보가 아직 준비되지 않았어';
    return;
  }

  localStorage.setItem('7016-board-seq', String(boardOrd));
  setBusy(true, manual ? '수동 새로고침 중…' : '실시간 데이터 갱신 중…');

  try {
    const nonce = Date.now();
    const res = await fetch(`/api/dashboard?boardOrd=${boardOrd}&destOrd=${destOrd}&_=${nonce}`, {
      cache: 'no-store',
      signal: dashboardController.signal,
      headers: { 'Cache-Control': 'no-cache' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '실시간 정보를 불러오지 못했습니다.');
    if (requestId !== dashboardRequestId) return;
    render(data);
    $('refreshStatus').textContent = `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 갱신 완료`;
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== dashboardRequestId) return;
    $('recommendationTitle').textContent = '데이터 연결 확인 필요';
    $('recommendationReason').textContent = err.message;
    $('refreshStatus').textContent = '갱신 실패 · 다시 눌러봐';
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
  if (advice.decision === 'TAKE_NOW') {
    badge.textContent = '이번 차';
    badge.className = 'ai-decision take';
  } else if (advice.decision === 'WAIT_NEXT') {
    badge.textContent = '다음 차';
    badge.className = 'ai-decision wait';
  } else {
    badge.textContent = '참고';
    badge.className = 'ai-decision neutral';
  }

  $('aiHeadline').textContent = advice.headline || 'AI 분석 완료';
  $('aiReason').textContent = advice.reason || '-';
  $('aiRisk').textContent = advice.risk || '-';
  $('aiTip').textContent = advice.tip || '-';
  $('aiModel').textContent = advice.source === 'gemini'
    ? `Gemini · ${advice.model || 'configured model'} · 현재 데이터 기준`
    : (payload.configured ? 'Gemini 호출 실패 · 규칙 기반 fallback' : 'Gemini 미설정 · 규칙 기반 fallback');
}

async function loadAiAdvice() {
  if (!currentDashboard) return;
  const button = $('aiAdviceButton');
  button.disabled = true;
  button.textContent = '분석 중';
  try {
    const res = await fetch('/api/ai-advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentDashboard)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gemini 분석 실패');
    renderAiAdvice(data);
  } catch (err) {
    $('aiEmpty').hidden = false;
    $('aiResult').hidden = true;
    $('aiEmpty').textContent = `AI 분석 오류: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'AI 분석';
  }
}

async function init() {
  setBusy(true);
  try {
    const res = await fetch(`/api/bootstrap?_=${Date.now()}`, { cache: 'no-store' });
    bootstrap = await res.json();
    if (!res.ok) throw new Error(bootstrap.error || '노선 정보를 불러오지 못했습니다.');
    $('modeBadge').className = bootstrap.mode === 'live' ? 'status-chip live' : 'status-chip';
    $('modeBadge').textContent = bootstrap.mode === 'live' ? 'LIVE' : 'DEMO';
    if (!bootstrap.geminiConfigured) $('aiEmpty').textContent = 'Gemini API 키가 없어 규칙 기반 추천만 사용합니다';
    populateStations();
    await loadDashboard({ manual: false });
    clearInterval(timer);
    timer = setInterval(() => loadDashboard({ manual: false }), 30000);
  } catch (err) {
    $('modeBadge').className = 'status-chip error';
    $('modeBadge').textContent = 'ERROR';
    $('boardingPickerText').textContent = '정류장 로드 실패';
    $('recommendationTitle').textContent = '초기화 실패';
    $('recommendationReason').textContent = err.message;
  } finally {
    setBusy(false);
  }
}

$('boardingPickerButton').addEventListener('click', (event) => {
  event.stopPropagation();
  setPickerOpen($('boardingPickerMenu').hidden);
});
$('boardingSearch').addEventListener('input', (event) => renderBoardingOptions(event.target.value));
$('boardingSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setPickerOpen(false);
    $('boardingPickerButton').focus();
  }
});
document.addEventListener('click', (event) => {
  const picker = $('boardingPickerButton').closest('.picker-field');
  if (!picker.contains(event.target)) setPickerOpen(false);
});
$('aiAdviceButton').addEventListener('click', loadAiAdvice);
$('refreshButton').addEventListener('click', () => loadDashboard({ manual: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDashboard({ manual: false }); });
init();
