import type { Company, IcpScore, Research } from "./types";

// The ICP, spelled out as data rather than buried in logic, so it reads
// clearly when this file is projected on stage. Every number here is a
// point value the reasons below can point back to.
export const ICP_CONFIG = {
  employeeRange: { min: 200, max: 5000 },
  targetIndustries: [
    "Payments Infrastructure",
    "Financial Data Infrastructure",
    "Corporate Fintech",
    "Spend Management Fintech",
    "Card Issuing Infrastructure",
  ],
  positiveKeywords: ["payments", "pci", "latency", "incident", "scaling", "sre hiring", "observability", "downtime"],
  negativeKeywords: ["layoffs", "hiring freeze", "acquisition", "acquired", "bankruptcy", "shutting down", "wind down", "restructuring"],
  weights: {
    industryMatch: 30,
    employeeRangeMatch: 30,
    perPositiveKeyword: 10,
    positiveKeywordCap: 30,
    perNegativeKeyword: 20,
    negativeKeywordCap: 40,
  },
} as const;

function collectSearchableText(research: Research): string {
  return [research.summary, ...research.signals.map((s) => s.text), ...research.techHints].join(" ").toLowerCase();
}

function matchKeywords(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

function formatList(items: string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

// Deterministic on purpose: no LLM call, no randomness. Same company and
// research in, same score and reasons out, every time — so every point on
// this number can be defended on stage by pointing at ICP_CONFIG.
export function scoreIcp(company: Company, research: Research): IcpScore {
  const { weights } = ICP_CONFIG;
  const reasons: string[] = [];
  let points = 0;

  if (company.industry && (ICP_CONFIG.targetIndustries as readonly string[]).includes(company.industry)) {
    points += weights.industryMatch;
    reasons.push(`${company.industry} is a core market we sell into, worth ${weights.industryMatch} points.`);
  }

  const { min, max } = ICP_CONFIG.employeeRange;
  if (company.employeeCount !== undefined && company.employeeCount >= min && company.employeeCount <= max) {
    points += weights.employeeRangeMatch;
    reasons.push(
      `At ${company.employeeCount} employees, this company sits right in our target size range, worth ${weights.employeeRangeMatch} points.`,
    );
  }

  const text = collectSearchableText(research);

  const positiveHits = matchKeywords(text, ICP_CONFIG.positiveKeywords);
  if (positiveHits.length > 0) {
    const awarded = Math.min(positiveHits.length * weights.perPositiveKeyword, weights.positiveKeywordCap);
    points += awarded;
    reasons.push(`Recent activity mentions ${formatList(positiveHits)} — strong buying signals, worth ${awarded} points.`);
  }

  const negativeHits = matchKeywords(text, ICP_CONFIG.negativeKeywords);
  if (negativeHits.length > 0) {
    const deducted = Math.min(negativeHits.length * weights.perNegativeKeyword, weights.negativeKeywordCap);
    points -= deducted;
    reasons.push(`Recent activity mentions ${formatList(negativeHits)} — a risk sign, so we deducted ${deducted} points.`);
  }

  if (reasons.length === 0) {
    reasons.push(`No strong ICP signals found yet for ${company.name}, so the score stays low.`);
  }

  const score = Math.max(0, Math.min(100, Math.round(points)));
  const verdict = score >= 70 ? "hot" : score >= 45 ? "warm" : "cold";

  return { score, reasons: reasons.slice(0, 4), verdict };
}
