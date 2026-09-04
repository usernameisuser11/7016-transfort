import 'dotenv/config';

const raw = process.env.DATA_GO_KR_SERVICE_KEY;
if (raw) {
  const trimmed = String(raw).trim();
  try {
    // data.go.kr exposes both encoded and decoded service keys.
    // Normalize to the decoded value once, then URLSearchParams in server.js encodes it exactly once.
    process.env.DATA_GO_KR_SERVICE_KEY = decodeURIComponent(trimmed);
  } catch {
    process.env.DATA_GO_KR_SERVICE_KEY = trimmed;
  }
}
