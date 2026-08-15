import companiesFixture from "@/fixtures/companies.json";
import { fixtureResearch } from "./research";
import { scoreIcpRules, scoreAndAdvise } from "./score";
import type { Company } from "./types";

const companies = companiesFixture as Company[];

const TARGET = { minHot: 3, minWarm: 1, maxCold: 1 };

interface CalibrationRow {
  domain: string;
  industry: string;
  employees: number | string;
  rulesScore: number;
  agentScore: number;
  verdict: string;
  scoreSource: string;
}

// Runs the real scorer (deterministic rules + the analyst agent) against
// every fixture's own pre-baked research — not a live web search, so this
// stays reproducible and cheap to run on every boot. Pure lib code (no
// Node-only fs/url imports) so instrumentation.ts's edge-compatible bundle
// can import it directly; scripts/calibrate.ts is the CLI wrapper around it.
export async function runCalibration(): Promise<CalibrationRow[]> {
  return Promise.all(
    companies.map(async (company): Promise<CalibrationRow> => {
      const research = fixtureResearch(company);
      const rules = scoreIcpRules(company, research);
      const { score: agent } = await scoreAndAdvise(company, research, rules);

      return {
        domain: company.domain,
        industry: company.industry ?? "unknown",
        employees: company.employeeCount ?? "unknown",
        rulesScore: rules.score,
        agentScore: agent.score,
        verdict: agent.verdict,
        scoreSource: agent.scoreSource ?? "agent",
      };
    }),
  );
}

export function printCalibration(rows: CalibrationRow[]): boolean {
  console.log("\n[t60] ICP calibration — six fixtures through the full scoring path:");
  console.table(
    rows.map((r) => ({
      domain: r.domain,
      industry: r.industry,
      employees: r.employees,
      "rules score": r.rulesScore,
      "agent score": r.agentScore,
      verdict: r.verdict,
      source: r.scoreSource,
    })),
  );

  const hot = rows.filter((r) => r.verdict === "hot").length;
  const warm = rows.filter((r) => r.verdict === "warm").length;
  const cold = rows.filter((r) => r.verdict === "cold").length;
  const ok = hot >= TARGET.minHot && warm >= TARGET.minWarm && cold <= TARGET.maxCold;

  console.log(
    `[t60] distribution: ${hot} hot, ${warm} warm, ${cold} cold ` +
      `(target: >=${TARGET.minHot} hot, >=${TARGET.minWarm} warm, <=${TARGET.maxCold} cold) — ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}
