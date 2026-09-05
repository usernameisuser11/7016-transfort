import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
const outputDir = process.argv[3] || 'data';
const TARGET_ROUTES = ['7016', '종로13', '서대문08'];

if (!input) {
  console.error('사용법: npm run import:passengers -- <서울시 승하차 CSV> [출력 디렉토리]');
  process.exit(1);
}

function readTextAuto(file) {
  const buf = fs.readFileSync(file);
  const utf8 = buf.toString('utf8');
  const replacementRatio = (utf8.match(/�/g)?.length || 0) / Math.max(1, utf8.length);
  if (replacementRatio > 0.0005) {
    throw new Error('CSV 인코딩이 UTF-8이 아닙니다. CSV UTF-8로 변환한 뒤 다시 실행해 주세요.');
  }
  return utf8.replace(/^\uFEFF/, '');
}

function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

const text = readTextAuto(input);
const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
if (lines.length < 2) {
  console.error('CSV에 데이터가 없습니다.');
  process.exit(2);
}

const headers = splitCsvLine(lines[0]).map(h => h.trim());
const rows = [];
let skippedRows = 0;
for (let i = 1; i < lines.length; i++) {
  const values = splitCsvLine(lines[i]);
  if (values.length < 4) { skippedRows += 1; continue; }
  const row = {};
  for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] ?? '';
  rows.push(row);
}

const norm = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/\(\s*\d+\s*\)\s*$/g, '')
  .replace(/\s+/g, '')
  .replace(/[()_\-]/g, '')
  .toLowerCase();
const normRoute = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

const headerNorm = new Map(headers.map(h => [h, norm(h)]));
function pickHeader(patterns) {
  return headers.find(h => patterns.some(p => p.test(headerNorm.get(h))));
}
const routeHeader = pickHeader([/노선번호/, /^노선$/, /busroute(no|nm|name)?/]);
const stopIdHeader = pickHeader([/표준버스정류장(id|아이디)/, /정류장(id|아이디)/, /stationid/]);
const stopNameHeader = pickHeader([/정류장명/, /^역명$/, /stationname/, /stationnm/]);
const monthHeader = pickHeader([/사용년월/, /기준년월/, /useym/, /month/]);
if (!routeHeader || !stopNameHeader) {
  console.error('헤더를 자동 인식하지 못했습니다.');
  console.error('인식된 헤더:', headers);
  process.exit(3);
}

function hourFromHeader(h, kind) {
  const n = norm(h);
  if (!n.includes(kind)) return null;
  const m = n.match(/(?:^|[^0-9])([0-9]{1,2})(?:시|hour|h)/) || n.match(/([0-9]{2})(?=시)/);
  if (!m) return null;
  const hour = Number(m[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}
const hourCols = [];
for (const h of headers) {
  const boardHour = hourFromHeader(h, '승차');
  if (boardHour != null) hourCols.push({ header: h, hour: boardHour, kind: 'board' });
  const alightHour = hourFromHeader(h, '하차');
  if (alightHour != null) hourCols.push({ header: h, hour: alightHour, kind: 'alight' });
}
if (!hourCols.length) {
  console.error('시간대별 승/하차 컬럼을 찾지 못했습니다.');
  process.exit(4);
}

function daysInMonth(sourceMonth) {
  const m = String(sourceMonth || '').match(/^(\d{4})[-.]?(\d{2})$/);
  if (!m) return 1;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return 1;
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}
function emptyProfile(stopId, stopName, routeSeq = null) {
  return {
    stopId: String(stopId || ''),
    stopName: String(stopName || ''),
    routeSeq: Number.isFinite(Number(routeSeq)) ? Number(routeSeq) : null,
    samples: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, board: 0, alight: 0, net: 0 }))
  };
}
function routeSeqFromStopName(stopName) {
  const m = String(stopName || '').match(/\(\s*(\d{1,5})\s*\)\s*$/);
  return m ? Number(m[1]) : null;
}
function addRowToProfile(profile, row) {
  profile.samples += 1;
  for (const hc of hourCols) {
    const v = Number(String(row[hc.header] ?? '0').replace(/,/g, '')) || 0;
    if (hc.kind === 'board') profile.hours[hc.hour].board += v;
    else profile.hours[hc.hour].alight += v;
  }
}
function normalizeDaily(profile, divisor) {
  profile.hours = profile.hours.map(h => {
    const board = Number((h.board / divisor).toFixed(2));
    const alight = Number((h.alight / divisor).toFixed(2));
    return { ...h, board, alight, net: Number((board - alight).toFixed(2)) };
  });
}
function buildProfile(routeName, routeRows) {
  const byId = {};
  const bySeq = {};
  let month = null;
  for (const row of routeRows) {
    const stopId = stopIdHeader ? String(row[stopIdHeader] ?? '').trim() : '';
    const stopName = String(row[stopNameHeader] ?? '').trim();
    const routeSeq = routeSeqFromStopName(stopName);
    month ||= monthHeader ? String(row[monthHeader] ?? '').trim() : '';

    const idKey = stopId || `name:${norm(stopName)}`;
    const existingId = byId[idKey];
    // Some circular village-bus routes visit the same physical stop more than
    // once. The app's commute flow uses the earliest school-bound occurrence,
    // so keep the lowest route sequence as the byId fallback. Exact occurrences
    // are all preserved in bySeq below.
    if (!existingId || (routeSeq != null && (existingId.routeSeq == null || routeSeq < existingId.routeSeq))) {
      const idProfile = emptyProfile(stopId, stopName, routeSeq);
      addRowToProfile(idProfile, row);
      byId[idKey] = idProfile;
    }

    if (routeSeq != null) {
      const seqKey = String(routeSeq);
      const seqProfile = bySeq[seqKey] ||= emptyProfile(stopId, stopName, routeSeq);
      addRowToProfile(seqProfile, row);
    }
  }

  const sourceDays = daysInMonth(month);
  // byId keeps one deterministic school-bound occurrence per physical stop.
  // bySeq below preserves every loop occurrence exactly.
  for (const p of Object.values(byId)) normalizeDaily(p, Math.max(1, p.samples) * sourceDays);
  // bySeq is the preferred exact route-occurrence lookup. If an upstream file
  // unexpectedly repeats the same route sequence, average those duplicate rows.
  for (const p of Object.values(bySeq)) normalizeDaily(p, Math.max(1, p.samples) * sourceDays);

  const byName = {};
  for (const p of Object.values(byId)) {
    const nk = norm(p.stopName);
    const copy = { ...p, hours: p.hours.map(h => ({ ...h })) };
    const existing = byName[nk];
    if (!existing) { byName[nk] = copy; continue; }
    existing.ambiguousName = true;
    for (let i = 0; i < 24; i++) {
      const board = Number((Number(existing.hours[i]?.board || 0) + Number(copy.hours[i]?.board || 0)).toFixed(2));
      const alight = Number((Number(existing.hours[i]?.alight || 0) + Number(copy.hours[i]?.alight || 0)).toFixed(2));
      existing.hours[i] = { hour: i, board, alight, net: Number((board - alight).toFixed(2)) };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(input),
    sourceMonth: month || null,
    daysInMonth: sourceDays,
    valueBasis: 'daily-average',
    route: routeName,
    rowCount: routeRows.length,
    skippedRows,
    byId,
    bySeq,
    byName,
  };
}

fs.mkdirSync(outputDir, { recursive: true });
let created = 0;
for (const routeName of TARGET_ROUTES) {
  const routeRows = rows.filter(r => normRoute(r[routeHeader]) === normRoute(routeName));
  if (!routeRows.length) {
    console.warn(`${routeName}: CSV에서 행을 찾지 못해 건너뜁니다.`);
    continue;
  }
  const result = buildProfile(routeName, routeRows);
  const output = path.join(outputDir, `${routeName}-passenger-profile.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  created += 1;
  console.log(`${routeName} 승하차 프로필 생성 완료: ${output}`);
  console.log(`  원본 행 ${routeRows.length} · 정류장 ${Object.keys(result.byId).length} · 노선순번 ${Object.keys(result.bySeq || {}).length} · ${result.sourceMonth || '월 미확인'} ${result.daysInMonth}일 기준`);
}

if (!created) {
  console.error(`대상 노선(${TARGET_ROUTES.join(', ')}) 데이터를 찾지 못했습니다.`);
  process.exit(5);
}
console.log(`전체 파싱 행: ${rows.length}, 건너뛴 행: ${skippedRows}, 생성 프로필: ${created}/${TARGET_ROUTES.length}`);
