import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const input = process.argv[2];
const output = process.argv[3] || 'data/7016-passenger-profile.json';

if (!input) {
  console.error('사용법: npm run import:passengers -- <서울시 승하차 CSV> [출력 JSON]');
  process.exit(1);
}

function readTextAuto(file) {
  const buf = fs.readFileSync(file);
  // 서울시 파일은 보통 CP949/EUC-KR 또는 UTF-8 계열이다.
  // Node 기본 환경에서는 UTF-8을 우선하고 깨짐이 심하면 iconv-lite 없이도
  // Windows에서 UTF-8로 저장 후 재실행하도록 명확히 오류를 낸다.
  const utf8 = buf.toString('utf8');
  const replacementRatio = (utf8.match(/�/g)?.length || 0) / Math.max(1, utf8.length);
  if (replacementRatio > 0.0005) {
    throw new Error('CSV 인코딩이 UTF-8이 아닙니다. Excel/메모장에서 CSV UTF-8로 다시 저장한 뒤 실행해 주세요.');
  }
  return utf8.replace(/^\uFEFF/, '');
}

const text = readTextAuto(input);
const rows = parse(text, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  relax_quotes: true,
  trim: true,
});

const norm = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .replace(/[()_\-]/g, '')
  .toLowerCase();

const headers = rows.length ? Object.keys(rows[0]) : [];
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
  process.exit(2);
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
  console.error('인식된 헤더:', headers);
  process.exit(3);
}

const routeRows = rows.filter(r => String(r[routeHeader] ?? '').trim() === '7016');
if (!routeRows.length) {
  console.error('7016 행을 찾지 못했습니다.');
  process.exit(4);
}

const byId = {};
const byName = {};
let month = null;

function emptyProfile(stopId, stopName) {
  return {
    stopId: String(stopId || ''),
    stopName: String(stopName || ''),
    samples: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour, board: 0, alight: 0, net: 0
    }))
  };
}

for (const row of routeRows) {
  const stopId = stopIdHeader ? String(row[stopIdHeader] ?? '').trim() : '';
  const stopName = String(row[stopNameHeader] ?? '').trim();
  month ||= monthHeader ? String(row[monthHeader] ?? '').trim() : '';

  const key = stopId || `name:${norm(stopName)}`;
  const p = byId[key] ||= emptyProfile(stopId, stopName);
  p.samples += 1;

  for (const hc of hourCols) {
    const v = Number(String(row[hc.header] ?? '0').replace(/,/g, '')) || 0;
    if (hc.kind === 'board') p.hours[hc.hour].board += v;
    else p.hours[hc.hour].alight += v;
  }
}

for (const p of Object.values(byId)) {
  p.hours = p.hours.map(h => ({
    ...h,
    board: Number((h.board / Math.max(1, p.samples)).toFixed(2)),
    alight: Number((h.alight / Math.max(1, p.samples)).toFixed(2)),
    net: Number(((h.board - h.alight) / Math.max(1, p.samples)).toFixed(2)),
  }));
  const nk = norm(p.stopName);
  const existing = byName[nk];
  if (!existing) byName[nk] = p;
  else {
    // 같은 이름 정류장이 양방향에 있을 때 이름 조회는 합산값으로 표시.
    existing.ambiguousName = true;
    for (let i = 0; i < 24; i++) {
      existing.hours[i].board += p.hours[i].board;
      existing.hours[i].alight += p.hours[i].alight;
      existing.hours[i].net = existing.hours[i].board - existing.hours[i].alight;
    }
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  sourceFile: path.basename(input),
  sourceMonth: month || null,
  route: '7016',
  rowCount: routeRows.length,
  byId,
  byName,
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(`7016 승하차 프로필 생성 완료: ${output}`);
console.log(`7016 원본 행: ${routeRows.length}`);
console.log(`정류장 프로필: ${Object.keys(byId).length}`);
