import { z } from "zod";
import { AgentError, runAgent } from "./agent";
import type { Company, IcpScore, Research, ScoreReason } from "./types";

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
  // "acquisition"/"acquired" deliberately excluded: a company ACQUIRING
  // someone is a growth signal, not distress, and a keyword match can't
  // tell the difference — the agent path reasons about direction instead
  // (see ANALYST_INSTRUCTIONS). Only this rules-only path is keyword-based,
  // and only as the fallback when the agent is unavailable.
  negativeKeywords: ["layoffs", "hiring freeze", "bankruptcy", "shutting down", "wind down", "restructuring"],
  weights: {
    industryMatch: 30,
    employeeRangeMatch: 30,
    perPositiveKeyword: 10,
    positiveKeywordCap: 30,
    perNegativeKeyword: 20,
    negativeKeywordCap: 40,
  },
} as const;

// Matches people.ts's PERSONA_RULES output set exactly, so a validated
// agent persona and a rules-fallback persona are always drawn from the same
// small, known list — never a surprise title on stage.
const PERSONA_TITLES = ["CTO", "Director of SRE", "Head of Payments", "VP Engineering"] as const;

const ANALYST_TIMEOUT_MS = 10_000;

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
// research in, same score and reasons out, every time. This is BOTH the
// fallback when the analyst agent is unavailable/invalid, and the muted
// "rules baseline" shown next to the agent score on every run — so every
// point on that baseline can be defended on stage by pointing at ICP_CONFIG.
export function scoreIcpRules(company: Company, research: Research): IcpScore {
  const { weights } = ICP_CONFIG;
  const reasons: ScoreReason[] = [];
  let points = 0;

  if (company.industry && (ICP_CONFIG.targetIndustries as readonly string[]).includes(company.industry)) {
    points += weights.industryMatch;
    reasons.push({
      factor: "Target industry",
      points: weights.industryMatch,
      explanation: `${company.industry} is a core market we sell into.`,
    });
  }

  const { min, max } = ICP_CONFIG.employeeRange;
  if (company.employeeCount !== undefined && company.employeeCount >= min && company.employeeCount <= max) {
    points += weights.employeeRangeMatch;
    reasons.push({
      factor: "Company size",
      points: weights.employeeRangeMatch,
      explanation: `At ${company.employeeCount} employees, this sits right in our target size range.`,
    });
  }

  const text = collectSearchableText(research);

  const positiveHits = matchKeywords(text, ICP_CONFIG.positiveKeywords);
  if (positiveHits.length > 0) {
    const awarded = Math.min(positiveHits.length * weights.perPositiveKeyword, weights.positiveKeywordCap);
    points += awarded;
    reasons.push({
      factor: "Buying signals",
      points: awarded,
      explanation: `Recent activity mentions ${formatList(positiveHits)}.`,
    });
  }

  const negativeHits = matchKeywords(text, ICP_CONFIG.negativeKeywords);
  if (negativeHits.length > 0) {
    const deducted = Math.min(negativeHits.length * weights.perNegativeKeyword, weights.negativeKeywordCap);
    points -= deducted;
    reasons.push({
      factor: "Risk signals",
      points: -deducted,
      explanation: `Recent activity mentions ${formatList(negativeHits)}.`,
    });
  }

  if (reasons.length === 0) {
    reasons.push({ factor: "No strong signals", points: 0, explanation: `No strong ICP signals found yet for ${company.name}.` });
  }

  const score = Math.max(0, Math.min(100, Math.round(points)));
  const verdict = score >= 70 ? "hot" : score >= 45 ? "warm" : "cold";

  return { score, reasons: reasons.slice(0, 4), verdict };
}

function isDemoSafe(): boolean {
  return process.env.DEMO_SAFE === "1";
}

const scoreReasonSchema = z
  .object({
    factor: z.string().min(1),
    points: z.number(),
    explanation: z.string().min(1),
  })
  .strict();

function buildAnalystSchema(signalCount: number) {
  return z
    .object({
      icpScore: z.number().min(0).max(100),
      verdict: z.enum(["hot", "warm", "cold"]),
      reasons: z.array(scoreReasonSchema).min(3).max(4),
      confidence: z.number().min(0).max(1),
      topSignal: z.number().int().nullable(),
      personaTitle: z.enum(PERSONA_TITLES),
      personaDepartment: z.string().min(1),
      whyThisPerson: z.string().min(1).max(400),
    })
    .strict()
    .superRefine((data, ctx) => {
      // Compare against the sum CLAMPED to 0-100, not the raw sum — a
      // strongly negative or >100 sum is expected to floor/cap, same as
      // scoreIcpRules() does, and shouldn't fail validation for it.
      const sum = data.reasons.reduce((acc, r) => acc + r.points, 0);
      const clampedSum = Math.max(0, Math.min(100, sum));
      if (Math.abs(clampedSum - data.icpScore) > 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Sum of reason points (${sum}, clamped ${clampedSum}) must be within 10 of icpScore (${data.icpScore})`,
          path: ["reasons"],
        });
      }

      const expectedVerdict = data.icpScore >= 70 ? "hot" : data.icpScore >= 45 ? "warm" : "cold";
      if (data.verdict !== expectedVerdict) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "${data.verdict}" does not match icpScore ${data.icpScore} (expected "${expectedVerdict}")`,
          path: ["verdict"],
        });
      }

      if (data.topSignal !== null && (data.topSignal < 0 || data.topSignal >= signalCount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `topSignal index ${data.topSignal} is out of range for ${signalCount} signal(s)`,
          path: ["topSignal"],
        });
      }
    });
}

type AnalystJson = z.infer<ReturnType<typeof buildAnalystSchema>>;

const ANALYST_INSTRUCTIONS = `You are a B2B sales analyst scoring inbound companies against a fixed ICP. Return STRICT JSON only — no Markdown, no code fences, no prose outside the JSON object.

Our Ideal Customer Profile:
- Industry: one of Payments Infrastructure, Financial Data Infrastructure, Corporate Fintech, Spend Management Fintech, Card Issuing Infrastructure. Anything outside this list (e.g. general retail, apparel, unrelated verticals) is a hard disqualifier — score near 0 regardless of size or signals.
- Company size: 200-5000 employees. This is a real constraint, not a minor factor: a company outside this range (either far smaller or far larger, e.g. 8000+ employees) should generally be capped below 70 (hot) even with strong buying signals — treat it as a firm ceiling, not something signals can fully compensate for. Being outside the range on top of a weak signal set should land the company in the 45-69 (warm) band or lower, not hot.
- Positive signals: evidence of scaling pain, reliability/incident pressure, SRE or on-call hiring, payments volume growth, PCI/compliance work, latency or uptime concerns, observability gaps.
- Negative signals: the company ITSELF going through layoffs, a hiring freeze, bankruptcy, wind-down, or being acquired AS THE TARGET. A company acquiring someone else, raising funding, or growing headcount is a positive growth signal, never a negative — do not penalize growth.

Score 0-100 by awarding and deducting points against this ICP explicitly — never guess a vibe. Every reason must state a concrete factor, a signed point value, and a one-sentence explanation tied to a specific fact from the research provided. The reason points must sum to within 10 of the total score, and the verdict must match the score (hot >= 70, warm >= 45, cold below 45).

Also choose the single best point-of-contact persona from the allowed list and explain why, tied to a specific signal.`;

function analystInput(company: Company, research: Research): string {
  const signalsList =
    research.signals.length > 0
      ? research.signals
          .map((s, i) => `${i}. [${s.category}] ${s.text}${s.date ? ` (${s.date})` : ""} — origin: ${s.origin}`)
          .join("\n")
      : "No research signals available.";

  return `Company: ${company.name} (${company.domain})
Industry: ${company.industry ?? "unknown"}
Employee count: ${company.employeeCount ?? "unknown"}
What they do: ${research.summary}

Research signals, indexed from 0 (topSignal must reference one of these indexes, or null if the list is empty):
${signalsList}

Tech hints: ${research.techHints.join(", ") || "none"}

Return exactly this JSON shape:
{
  "icpScore": 0-100 integer,
  "verdict": "hot" | "warm" | "cold",
  "reasons": [
    { "factor": "short label", "points": signed integer, "explanation": "one sentence tied to a specific fact above" }
  ],
  "confidence": 0 to 1,
  "topSignal": integer index of the single most-justifying signal above, or null if the list is empty,
  "personaTitle": one of "CTO", "Director of SRE", "Head of Payments", "VP Engineering",
  "personaDepartment": the department for that title,
  "whyThisPerson": "one sentence, max 25 words, tying this specific person to a specific signal or fact above"
}`;
}

export interface PersonaSuggestion {
  title: string;
  department: string;
  whyThisPerson: string;
}

export interface AnalystResult {
  score: IcpScore;
  // Present only when the agent produced it. Absent on rules-fallback —
  // callers fall back to people.ts's own PERSONA_RULES table (which knows
  // about page path and reasons independently), not a second, cruder
  // rules-based persona guess invented here.
  persona?: PersonaSuggestion;
}

// THE two-agent replacement for deterministic-only scoring: research() (see
// lib/research.ts) is agent call #1, this is #2. Always computes the rules
// score too — not just as a fallback, but as the permanent baseline shown
// next to the agent's number on the dashboard.
export async function scoreAndAdvise(company: Company, research: Research, rules: IcpScore): Promise<AnalystResult> {
  if (isDemoSafe() || !process.env.OPENAI_API_KEY) {
    console.log(`[t60] analyst MOCKED domain=${company.domain} — using rules score`);
    return { score: { ...rules, scoreSource: "rules-fallback" } };
  }

  try {
    const result = await runAgent<AnalystJson>({
      name: "analyst",
      instructions: ANALYST_INSTRUCTIONS,
      input: analystInput(company, research),
      schema: buildAnalystSchema(research.signals.length),
      timeoutMs: ANALYST_TIMEOUT_MS,
    });

    return {
      score: {
        score: result.icpScore,
        verdict: result.verdict,
        reasons: result.reasons,
        confidence: result.confidence,
        topSignal: result.topSignal ?? undefined,
        scoreSource: "agent",
      },
      persona: {
        title: result.personaTitle,
        department: result.personaDepartment,
        whyThisPerson: result.whyThisPerson,
      },
    };
  } catch (error) {
    const reason = error instanceof AgentError ? error.message : error instanceof Error ? error.message : "unknown error";
    console.error(`[t60] analyst FALLING THROUGH to rules for domain=${company.domain} — reason: ${reason}`);
    return { score: { ...rules, scoreSource: "rules-fallback" } };
  }
}
