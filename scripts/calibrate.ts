import { runCalibration, printCalibration } from "../lib/calibration";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local, or already loaded — fine, scoreAndAdvise() falls back
  // to the rules score when OPENAI_API_KEY isn't set.
}

runCalibration()
  .then((rows) => {
    const ok = printCalibration(rows);
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("[t60] calibration crashed:", err);
    process.exit(1);
  });
