import { z } from "zod";
import companiesFixture from "@/fixtures/companies.json";
import { AgentError, runAgent, wait } from "./agent";
import type { Company, Research, Signal, SignalCategory } from "./types";

const SIGNAL_CATEGORIES = ["hiring", "funding", "product", "incident", "expansion", "tech"] as const;

type FixtureCompanyRecord = Company & { research?: { signals: Signal[]; techHints: string[] } };
const COMPANIES = companiesFixture as FixtureCompanyRecord[];

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const UNIFY_TIMEOUT_MS = 6_000;
const RESEARCH_TIMEOUT_MS = 15_000;
const MOCK_DELAY_MS = 800;

// Standard Company object fields (docs.unifygtm.com/developers/api/data/standard-objects)
// are firmographics, not signals — they're already shown on the Company
// card. Everything else on the record is a custom attribute, which is
// exactly how an Infinity Signal's output surfaces here: Unify has no
// separate API for it (confirmed against the Data API docs — custom
// attributes, Infinity Signal included, are just fields on the record), so
// reading every non-standard attribute already covers it with no extra call.
const ignoredUnifyAttributes = new Set([
  "id",
  "name",
  "domain",
  "website",
  "description",
  "industry",
  "employee_count",
  "revenue",
  "founded",
  "address",
  "time_zone",
  "corporate_phone",
  "linkedin_url",
  "status",
  "lead_source",
  "do_not_contact",
  "record_owner",
  "hubspot_url",
  "salesforce_url",
  "last_activity_at",
  "last_website_activity_at",
  "created_at",
  "updated_at",
]);

function isTwoSentenceSummary(value: string): boolean {
  return (value.match(/[.!?](?:\s|$)/g) ?? []).length === 2;
}

const agentSignalSchema = z
  .object({
    text: z.string().min(25),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceUrl: z.string().url(),
    category: z.enum(SIGNAL_CATEGORIES),
  })
  .strict();

const agentResearchSchema = z
  .object({
    summary: z.string().min(20).refine(isTwoSentenceSummary, "Summary must contain exactly two sentences"),
    signals: z.array(agentSignalSchema).length(3),
    techHints: z.array(z.string().min(1)).max(3),
    sources: z.array(z.string().url()).min(1),
  })
  .strict()
  // Cross-field checks (date window, source cross-reference) live inside the
  // schema — not a separate validation pass — so runAgent's built-in
  // retry-once-with-reason loop covers them for free.
  .superRefine((data, ctx) => {
    const now = new Date();
    const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
    const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const sources = new Set(data.sources);

    data.signals.forEach((signal, i) => {
      const date = new Date(`${signal.date}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date < twelveMonthsAgo || date >= endOfToday) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Signal date must be within the last twelve months", path: ["signals", i, "date"] });
      }
      if (!sources.has(signal.sourceUrl)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Signal sourceUrl must be listed in sources[]", path: ["signals", i, "sourceUrl"] });
      }
    });
  });

type AgentResearch = z.infer<typeof agentResearchSchema>;

type SourceResult<T> = {
  data: T;
  failed: boolean;
};

type UnifyRecord = {
  attributes?: Record<string, unknown>;
  updated_at?: string;
};

type UnifyFindUniqueResponse = {
  data?: UnifyRecord | null;
};

function isDemoSafe(): boolean {
  return process.env.MOCK_RESEARCH === "1" || process.env.DEMO_SAFE === "1";
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function labelAttribute(attribute: string): string {
  return attribute
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAttributeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map(formatAttributeValue)
      .filter((item): item is string => Boolean(item));
    return items.length > 0 ? items.join(", ") : undefined;
  }
  if (value && typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const formatted = formatAttributeValue(item);
        return formatted ? `${labelAttribute(key)}: ${formatted}` : undefined;
      })
      .filter((item): item is string => Boolean(item));
    return pairs.length > 0 ? pairs.join("; ") : undefined;
  }
  return undefined;
}

// Unify custom attributes carry no per-field category — inferred from the
// attribute name as a best-effort guess so the Signals panel still has
// something to group/icon by. Order matters: first match wins.
const CATEGORY_KEYWORDS: [SignalCategory, RegExp][] = [
  ["hiring", /hir|headcount|sre|recruit|open[_ ]?role/],
  ["funding", /fund|valuation|raise|series|arr|revenue/],
  ["incident", /incident|outage|downtime|breach|degrad/],
  ["expansion", /expan|office|region|market|hub/],
  ["product", /launch|release|feature|product/],
];

function inferAttributeCategory(attribute: string): SignalCategory {
  const lower = attribute.toLowerCase();
  const match = CATEGORY_KEYWORDS.find(([, pattern]) => pattern.test(lower));
  return match ? match[0] : "tech";
}

function getUnifySignals(record: UnifyRecord): Signal[] {
  const date = toIsoDate(record.updated_at);
  const signals: Signal[] = [];

  for (const [attribute, value] of Object.entries(record.attributes ?? {})) {
    if (ignoredUnifyAttributes.has(attribute.toLowerCase())) continue;
    // A custom boolean attribute (e.g. an Infinity Signal detector) is only
    // sales-actionable when it fired true; "false" is an absence, not a signal.
    if (value === false) continue;
    const formatted = formatAttributeValue(value);
    if (!formatted) continue;

    signals.push({
      text: `${labelAttribute(attribute)}: ${formatted}`,
      origin: "unify",
      category: inferAttributeCategory(attribute),
      date,
      // No per-attribute URL exists on a Data API record — left unsourced
      // rather than pointing "sourceUrl" at a page that isn't the actual source.
    });
  }

  return signals;
}

async function readUnifySignals(company: Company): Promise<SourceResult<Signal[]>> {
  const apiKey = process.env.UNIFY_API_KEY;
  if (!apiKey) {
    console.warn(`[t60] unify signals SKIPPED domain=${company.domain} — UNIFY_API_KEY is not configured`);
    return { data: [], failed: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNIFY_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://api.unifygtm.com/data/v1/objects/company/records/find-unique",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ match: { domain: company.domain } }),
        signal: controller.signal,
      },
    );

    if (!response.ok) throw new Error(`Unify Data API responded ${response.status}`);
    const payload = (await response.json()) as UnifyFindUniqueResponse;
    const signals = payload.data ? getUnifySignals(payload.data) : [];
    console.log(`[t60] unify signals OK domain=${company.domain} count=${signals.length}`);
    return { data: signals, failed: false };
  } catch (error) {
    // Unify enrichment is additive. The agent continues when a record is absent
    // or the Data API is unavailable — but this must be loud, not silent.
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[t60] unify signals FAILED domain=${company.domain} — falling through to agent-only signals — reason: ${message}`);
    return { data: [], failed: true };
  } finally {
    clearTimeout(timeout);
  }
}

// Sourced from fixtures/companies.json rather than a second hardcoded copy,
// so the demo's safety-net data can't drift out of sync with the fixture
// set the rest of the app (identify, the demo control presets) uses.
export function fixtureResearch(company: Company, degraded = false): Research {
  const target = normalizeDomain(company.domain);
  const match = COMPANIES.find((c) => normalizeDomain(c.domain) === target);

  if (!match?.research) {
    console.warn(`[t60] research FIXTURE MISS domain=${company.domain} — no fixture entry, returning empty research`);
    return {
      summary:
        company.description ?? `${company.name} operates at ${company.domain}. Research is temporarily unavailable.`,
      signals: [],
      techHints: [],
      sources: [],
      degraded: true,
    };
  }

  const sources = match.research.signals
    .map((signal) => signal.sourceUrl)
    .filter((source): source is string => Boolean(source));

  return {
    summary: company.description ?? `${company.name} is active in ${company.industry ?? "its category"}.`,
    signals: match.research.signals,
    techHints: match.research.techHints,
    sources: Array.from(new Set(sources)),
    degraded,
  };
}

const RESEARCH_INSTRUCTIONS = "Return one valid JSON object only: no Markdown, code fences, or prose outside JSON.";

function researchInput(company: Company): string {
  return `Research the company ${company.name} (${company.domain}) using web search. ${company.description ?? ""}

Return exactly this shape:
{
  "summary": "Exactly two sentences on what the company does and who it sells to.",
  "signals": [
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "sourceUrl": "https://actual-source-url", "category": "hiring" },
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "sourceUrl": "https://actual-source-url", "category": "funding" },
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "sourceUrl": "https://actual-source-url", "category": "product" }
  ],
  "techHints": ["up to three likely technologies relevant to an observability product for payments infrastructure"],
  "sources": ["https://actual-source-url"]
}

Rules: signals must be dated facts from the last twelve months, such as funding, hiring, launches, incidents, or expansion. Every signal needs its own actual source URL (sourceUrl), and sources must contain all URLs used. category must be exactly one of: hiring, funding, product, incident, expansion, tech — pick whichever the fact is actually about. Reject generic filler such as “they are growing fast”; do not invent facts or URLs.`;
}

async function readAgentResearch(company: Company): Promise<SourceResult<Research>> {
  try {
    const result = await runAgent<AgentResearch>({
      name: "research",
      instructions: RESEARCH_INSTRUCTIONS,
      input: researchInput(company),
      schema: agentResearchSchema,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      webSearch: true,
    });
    return {
      data: {
        summary: result.summary,
        signals: result.signals.map((signal) => ({ ...signal, origin: "agent" as const })),
        techHints: result.techHints,
        sources: result.sources,
        degraded: false,
      },
      failed: false,
    };
  } catch (error) {
    const reason = error instanceof AgentError ? error.message : error instanceof Error ? error.message : "unknown error";
    console.error(`[t60] research FALLING THROUGH to fixture for domain=${company.domain} — reason: ${reason}`);
    return { data: fixtureResearch(company, true), failed: true };
  }
}

/**
 * Reads company context already in Unify and supplements it with one web-search
 * research pass. The sources run concurrently so research finishes inside the
 * pipeline's 15-second budget.
 */
export async function research(company: Company): Promise<Research> {
  if (isDemoSafe()) {
    console.log(`[t60] research MOCKED domain=${company.domain} — MOCK_RESEARCH/DEMO_SAFE is set, using fixture`);
    await wait(MOCK_DELAY_MS);
    return fixtureResearch(company);
  }

  const [unify, agent] = await Promise.all([readUnifySignals(company), readAgentResearch(company)]);
  const sources = Array.from(new Set(agent.data.sources));

  return {
    ...agent.data,
    signals: [...unify.data, ...agent.data.signals],
    sources,
    degraded: unify.failed || agent.failed,
  };
}
