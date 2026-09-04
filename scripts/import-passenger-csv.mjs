import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
const output = process.argv[3] || 'data/7016-passenger-profile.json';

if (!input) {
  console.error('사용법: npm run import:passengers -- <서울시 승하차 CSV> [출력 JSON]');
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

// 서울시 월간 CSV에는 일부 행의 따옴표가 엄격한 CSV 파서에서 오류를 내는 경우가 있다.
// 한 행씩 독립적으로 읽는 관대한 파서를 사용해 정상 행은 최대한 보존한다.
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }

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
  if (values.length < 4) {
    skippedRows += 1;
    continue;
  }

  const row = {};
  for (let j = 0; j < headers.length; j++) {
    row[headers[j]] = values[j] ?? '';
  }
  rows.push(row);
}

const norm = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .replace(/[()_\-]/g, '')
  .toLowerCase();

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
  console.error('인식된 헤더:', headers);
  process.exit(4);
}

const routeRows = rows.filter(r => String(r[routeHeader] ?? '').trim() === '7016');
if (!routeRows.length) {
  console.error('7016 행을 찾지 못했습니다.');
  console.error(`전체 파싱 행: ${rows.length}, 건너뛴 행: ${skippedRows}`);
  process.exit(5);
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
  skippedRows,
  byId,
  byName,
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(`7016 승하차 프로필 생성 완료: ${output}`);
console.log(`7016 원본 행: ${routeRows.length}`);
console.log(`정류장 프로필: ${Object.keys(byId).length}`);
console.log(`전체 파싱 행: ${rows.length}, 건너뛴 행: ${skippedRows}`);
