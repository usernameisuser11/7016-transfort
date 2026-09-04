const raw = process.env.DATA_GO_KR_SERVICE_KEY;
if (raw) {
  try {
    process.env.DATA_GO_KR_SERVICE_KEY = decodeURIComponent(raw);
  } catch {
    process.env.DATA_GO_KR_SERVICE_KEY = raw;
  }
}
