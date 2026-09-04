# 승하차 데이터

`7016-schoolbound-stops.json`은 API가 없을 때 사용하는 학교 방향 54개 정류장 fallback 목록입니다.

실제 서울시 월간 승하차 CSV를 `data/raw/` 등에 저장한 뒤:

```bash
npm run import:passengers -- "data/raw/파일.csv"
```

를 실행하면 `7016-passenger-profile.json`이 생성됩니다.
