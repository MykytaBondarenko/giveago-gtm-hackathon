import OpenAI from "openai";
import { z } from "zod";
import companiesFixture from "@/fixtures/companies.json";
import type { Company, Research, Signal } from "./types";

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
const OPENAI_TIMEOUT_MS = 12_000;
const MOCK_DELAY_MS = 800;

const ignoredUnifyAttributes = new Set([
  "id",
  "name",
  "domain",
  "website",
  "description",
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
    source: z.string().url(),
  })
  .strict();

const agentResearchSchema = z
  .object({
  summary: z.string().min(20).refine(isTwoSentenceSummary, "Summary must contain exactly two sentences"),
  signals: z.array(agentSignalSchema).length(3),
  techHints: z.array(z.string().min(1)).max(3),
  sources: z.array(z.string().url()).min(1),
  })
  .strict();

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

class MalformedModelOutputError extends Error {}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function getUnifySignals(record: UnifyRecord): Signal[] {
  const date = toIsoDate(record.updated_at);
  const signals: Signal[] = [];

  for (const [attribute, value] of Object.entries(record.attributes ?? {})) {
    if (ignoredUnifyAttributes.has(attribute.toLowerCase())) continue;
    const formatted = formatAttributeValue(value);
    if (!formatted) continue;

    signals.push({
      text: `${labelAttribute(attribute)}: ${formatted}`,
      origin: "unify",
      date,
      source: "Unify Data API",
    });
  }

  return signals;
}

async function readUnifySignals(company: Company): Promise<SourceResult<Signal[]>> {
  const apiKey = process.env.UNIFY_API_KEY;
  if (!apiKey) return { data: [], failed: false };

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
    return { data: payload.data ? getUnifySignals(payload.data) : [], failed: false };
  } catch {
    // Unify enrichment is additive. The agent continues when a record is absent
    // or the Data API is unavailable.
    return { data: [], failed: true };
  } finally {
    clearTimeout(timeout);
  }
}

// Sourced from fixtures/companies.json rather than a second hardcoded copy,
// so the demo's safety-net data can't drift out of sync with the fixture
// set the rest of the app (identify, the demo control presets) uses.
function fixtureResearch(company: Company, degraded = false): Research {
  const target = normalizeDomain(company.domain);
  const match = COMPANIES.find((c) => normalizeDomain(c.domain) === target);

  if (!match?.research) {
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
    .map((signal) => signal.source)
    .filter((source): source is string => Boolean(source));

  return {
    summary: company.description ?? `${company.name} is active in ${company.industry ?? "its category"}.`,
    signals: match.research.signals,
    techHints: match.research.techHints,
    sources: Array.from(new Set(sources)),
    degraded,
  };
}

function modelPrompt(company: Company, retry = false): string {
  const retryReminder = retry
    ? "Your previous output was malformed. Return one valid JSON object only: no Markdown, code fences, prose, or citations outside JSON."
    : "Return one valid JSON object only: no Markdown, code fences, or prose outside JSON.";

  return `${retryReminder}

Research the company ${company.name} (${company.domain}) using web search. ${company.description ?? ""}

Return exactly this shape:
{
  "summary": "Exactly two sentences on what the company does and who it sells to.",
  "signals": [
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "source": "https://actual-source-url" },
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "source": "https://actual-source-url" },
    { "text": "A concrete, specific sales-conversation fact", "date": "YYYY-MM-DD", "source": "https://actual-source-url" }
  ],
  "techHints": ["up to three likely technologies relevant to an observability product for payments infrastructure"],
  "sources": ["https://actual-source-url"]
}

Rules: signals must be dated facts from the last twelve months, such as funding, hiring, launches, incidents, or expansion. Every signal needs its own actual source URL, and sources must contain all URLs used. Reject generic filler such as “they are growing fast”; do not invent facts or URLs.`;
}

function validateAgentResearch(raw: string): AgentResearch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedModelOutputError("Model response was not JSON");
  }

  const result = agentResearchSchema.safeParse(parsed);
  if (!result.success) throw new MalformedModelOutputError(result.error.message);

  const now = new Date();
  const twelveMonthsAgo = new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()),
  );
  const endOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const sources = new Set(result.data.sources);

  for (const signal of result.data.signals) {
    const date = new Date(`${signal.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date < twelveMonthsAgo || date >= endOfToday) {
      throw new MalformedModelOutputError("Model signal date is outside the last twelve months");
    }
    if (!sources.has(signal.source)) {
      throw new MalformedModelOutputError("Model omitted a signal source from sources");
    }
  }

  return result.data;
}

async function requestAgentResearch(
  company: Company,
  deadline: number,
  retry = false,
): Promise<AgentResearch> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("OpenAI research timed out");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: Math.min(OPENAI_TIMEOUT_MS, remainingMs) });

  try {
    const response = await client.responses.create(
      {
        model: "gpt-4.1-mini",
        tools: [{ type: "web_search_preview", search_context_size: "low" }],
        input: modelPrompt(company, retry),
      },
      { signal: controller.signal, timeout: Math.min(OPENAI_TIMEOUT_MS, remainingMs), maxRetries: 0 },
    );

    const raw = response.output_text;
    console.log(`[t60] research model-output domain=${company.domain} raw=${raw}`);
    return validateAgentResearch(raw);
  } finally {
    clearTimeout(timeout);
  }
}

async function readAgentResearch(company: Company): Promise<SourceResult<Research>> {
  const deadline = Date.now() + OPENAI_TIMEOUT_MS;

  try {
    const result = await requestAgentResearch(company, deadline);
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
    if (!(error instanceof MalformedModelOutputError) || Date.now() >= deadline) {
      return { data: fixtureResearch(company, true), failed: true };
    }
  }

  try {
    const result = await requestAgentResearch(company, deadline, true);
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
  } catch {
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
