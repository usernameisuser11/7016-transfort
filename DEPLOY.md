# 7016 배포 체크리스트

## GitHub
1. 새 빈 저장소 생성: `7016-smu-bus`
2. 이 프로젝트 ZIP의 내용물을 저장소 루트에 업로드
3. `.env`는 절대 업로드하지 않음 (`.gitignore` 포함)

## Render
1. GitHub 저장소 연결
2. Blueprint 또는 Web Service 생성
3. `render.yaml` 사용
4. Secret 환경변수 입력
   - `DATA_GO_KR_SERVICE_KEY`
   - `GEMINI_API_KEY`
5. Deploy
6. `/api/health`에서 `ok: true` 확인

## 배포 후 확인
- 메인 화면 열림
- 학교 방향 정류장 54개 또는 LIVE API 실제 개수 표시
- 새로고침 클릭 시 `갱신 중` → `HH:MM:SS 갱신 완료`
- 첫/둘째 버스 ETA 변경
- Gemini 분석 버튼 동작
- 15분 이상 미사용 후 첫 접속은 Render Free sleep 때문에 느릴 수 있음
