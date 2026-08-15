// Next.js calls register() once when the server process starts (dev and
// prod both) — the one true "on boot" hook. Used for diagnostics that
// should be known within seconds of starting, not discovered at demo time.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { agentSelfCheck } = await import("./lib/agent");
  await agentSelfCheck();

  const { runCalibration, printCalibration } = await import("./lib/calibration");
  const rows = await runCalibration();
  printCalibration(rows);
}
