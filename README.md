# 7016 · 상명대 통학 V4 · Deploy Ready

7016 학교 방향의 **전체 승차 정류장 + 실시간 배차/혼잡도 + 시간대별 승하차 패턴**을 합쳐
`이번 차를 탈지 다음 차를 기다릴지` 판단하는 MVP입니다.

## V2에서 달라진 점

- 데모 정류장 5개 → **학교 방향 fallback 정류장 54개**
- LIVE API 연결 시 7016 전체 노선을 받아 **첫 상명대정문까지 학교 방향만 자동 추출**
- 선택 정류장 검색 범위 확대
- 서울시 월간 `버스노선별 정류장별 시간대별 승하차 인원` CSV import 도구 추가
- 선택 정류장의 현재 시간대 평균 승차/하차 인원 표시
- 24시간 승차 수요 막대 그래프
- 실시간 혼잡도 + 과거 수요를 추천 로직에서 함께 참고

## 현재 공식 승하차 데이터 상태

서울 열린데이터광장 데이터셋은 월 단위이며 매월 초 전월 데이터가 갱신됩니다.
2026-09-04 기준 웹에서 확인되는 최신 파일은 `2026년 07월` 데이터입니다.

## 실행

```bash
npm install
cp .env.example .env
npm run dev
```

API 키가 없으면:
- 54개 학교 방향 정류장
- 실시간 버스 DEMO
- 승하차 패턴 DEMO

로 UI 전체를 확인할 수 있습니다.

## 실제 실시간 버스 연결

`.env`

```env
DATA_GO_KR_SERVICE_KEY=발급받은_키
PORT=3000
PASSENGER_PROFILE_FILE=data/7016-passenger-profile.json
```

## 실제 2026-07 승하차 데이터 넣기

서울 열린데이터광장에서 다음 파일을 내려받습니다.

`2026년_버스노선별_정류장별_시간대별_승하차_인원_정보(07월).csv`

CSV 인코딩이 UTF-8이 아니면 Excel에서 `CSV UTF-8`로 다시 저장합니다.

그 후:

```bash
npm run import:passengers -- "data/raw/2026-07-bus-passengers.csv"
```

생성:

```text
data/7016-passenger-profile.json
```

서버 재시작 후 실제 7016 시간대별 승하차 패턴이 표시됩니다.

## 추천 로직

현재는 규칙 기반 MVP입니다.

1. 첫 차/두 번째 차 실제 ETA 비교
2. 차량 실시간 혼잡도 비교
3. 첫 차가 혼잡하고 다음 차가 6분 안쪽이며 다음 차가 여유/보통 → 다음 차 추천
4. 그 외에는 시간 절약 우선
5. 선택 정류장의 현재 시간대 과거 승차 수요가 높으면 추천 설명에 반영

## 다음 단계

- 2026-05~07 3개월 데이터를 합쳐 평일/주말 분리
- 대학교 수업 시작 시간 입력
- 강의 시작까지 남은 시간 기반 `지각 위험도`
- 실제 관측 ETA를 DB에 저장해 정류장별 통행시간 모델 학습
- 7016 vs 1020/1711/7018 + 도보 비교


## Gemini API 추가

V3에서는 Gemini를 **교통 데이터 원본 대신 의사결정 보조 레이어**로 사용합니다.

기존 서버가 먼저 계산하는 값:

- 첫 번째/두 번째 7016 ETA
- 실제 배차 간격
- 차량별 실시간 혼잡도
- 상명대 예상 도착시간
- 과거 시간대별 승하차 수요
- 기존 규칙 기반 추천

사용자가 `Gemini 분석` 버튼을 누르면 이 값들만 Gemini에 전달합니다.
따라서 Gemini가 버스 위치나 승객 수를 임의로 조회하거나 만들어내지 않습니다.

### 설정

Google AI Studio에서 Gemini API 키를 만든 뒤 `.env`에 넣습니다.

```env
GEMINI_API_KEY=발급받은_Gemini_API_키
GEMINI_MODEL=gemini-3.8-flash
```

API 키는 브라우저 코드에 들어가지 않고 Express 서버에서만 사용합니다.

### 호출 방식

- 자동 30초 갱신: Gemini 호출 안 함
- `Gemini 분석` 버튼: 필요할 때만 호출
- 같은 데이터 조합은 서버에서 약 3분간 캐시
- Gemini 오류 또는 API 키 미설정: 기존 규칙 기반 추천으로 자동 fallback

### Gemini가 반환하는 값

- `decision`: 이번 차 / 다음 차 / 중립
- `headline`: 짧은 결론
- `reason`: 데이터 기반 이유
- `risk`: ETA 추정 등 불확실성
- `tip`: 바로 실행할 행동 팁

현재 Google Gemini JS SDK의 Interactions API 및 structured JSON output 방식을 사용합니다.


## V4 새로고침 수정

이전 버전은 네트워크 요청 중 `disabled` 상태를 사용했기 때문에 사용자가 버튼이 눌리지 않는 것처럼 느낄 수 있었습니다.

V4에서는:

- 새로고침 버튼을 disabled 하지 않음
- 연속 클릭 시 이전 fetch 요청을 `AbortController`로 취소
- 새 요청에 timestamp nonce를 붙여 브라우저/API 캐시 우회
- 클릭 즉시 `갱신 중` UI 표시
- 완료 시 초 단위 갱신 시간 표시
- 실패 후에도 버튼 즉시 재사용 가능
- API 응답에 `Cache-Control: no-store` 적용

## Render 배포

루트에 `render.yaml`을 추가했습니다.

설정:

- Service: Web Service
- Runtime: Node
- Plan: Free
- Build: `npm install`
- Start: `npm start`
- Health check: `/api/health`
- Node: `24.14.1`
- 외부 비밀값은 Blueprint에서 `sync: false`

Render에서 최초 생성 시 입력할 비밀 환경변수:

```text
DATA_GO_KR_SERVICE_KEY
GEMINI_API_KEY
```

고정값:

```text
GEMINI_MODEL=gemini-3.8-flash
PASSENGER_PROFILE_FILE=data/7016-passenger-profile.json
```

무료 Render Web Service는 일정 시간 요청이 없으면 sleep될 수 있으므로 첫 접속이 느릴 수 있습니다.
