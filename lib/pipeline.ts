import { randomUUID } from "crypto";
import companiesFixture from "@/fixtures/companies.json";
import { getSession, emitStep, patchSession } from "./store";
import type {
  Company,
  IcpScore,
  IdentifyResult,
  LiveEngagement,
  Outreach,
  Persona,
  Research,
  SendWindowCalc,
  Session,
  Signal,
  StepName,
  VisitEvent,
} from "./types";

// ORCHESTRATOR. Every step below still returns fixture data after a short
// delay — later tasks replace each one with a real call (Unify, OpenAI,
// etc.) behind the MOCK_* env flags described in AGENTS.md. withStep is the
// safety net that makes that swap safe: a real call that errors or hangs
// degrades to fixture data instead of taking the demo down.

type FixtureCompany = Company & {
  research: {
    signals: Signal[];
    techHints: string[];
  };
};

const COMPANIES = companiesFixture as FixtureCompany[];

const STEP_DURATION_MS: Record<StepName, [number, number]> = {
  identify: [400, 700],
  research: [900, 1600],
  score: [300, 500],
  persona: [300, 500],
  compose: [700, 1200],
  engage: [200, 400],
  unify: [400, 700],
};

const STEP_TIMEOUT_MS = 8000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter([min, max]: [number, number]): number {
  return Math.round(min + Math.random() * (max - min));
}

function timeoutRejection<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`step timed out after ${ms}ms`)), ms);
  });
}

// Emits start, measures duration, patches the session, emits done with the
// payload. On error or timeout, emits status "error" with a short note and
// resolves to `fallback` instead — the pipeline always keeps moving.
async function withStep<T>(
  step: StepName,
  visitId: string,
  fn: () => Promise<T>,
  fallback: T,
  toPatch: (value: T) => Partial<Session>,
): Promise<T> {
  const start = Date.now();
  emitStep({ visitId, step, status: "start", ms: 0 });

  try {
    const result = await Promise.race([fn(), timeoutRejection<T>(STEP_TIMEOUT_MS)]);
    const ms = Date.now() - start;
    patchSession(visitId, toPatch(result));
    console.log(`[t60] visit=${visitId} step=${step} status=done ms=${ms}`);
    emitStep({ visitId, step, status: "done", ms, payload: result });
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    const note = err instanceof Error ? err.message : "unknown error";
    patchSession(visitId, toPatch(fallback));
    console.log(`[t60] visit=${visitId} step=${step} status=error ms=${ms} note="${note}"`);
    emitStep({ visitId, step, status: "error", ms, payload: fallback, note });
    return fallback;
  }
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function findFixtureByDomain(domain: string | undefined): FixtureCompany | undefined {
  if (!domain) return undefined;
  const target = normalizeDomain(domain);
  return COMPANIES.find((c) => normalizeDomain(c.domain) === target);
}

function resolveFixtureCompany(visit: VisitEvent): FixtureCompany | undefined {
  if (visit.manualDomain) {
    return findFixtureByDomain(visit.manualDomain);
  }
  return COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
}

function toCompany(fixture: FixtureCompany): Company {
  return {
    domain: fixture.domain,
    name: fixture.name,
    employeeCount: fixture.employeeCount,
    industry: fixture.industry,
    description: fixture.description,
    hqCountry: fixture.hqCountry,
  };
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const zoned = getZonedParts(new Date(asUtc), timeZone);
  const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  const diff = asUtc - zonedAsUtc;
  return new Date(asUtc + diff);
}

const SEND_WINDOW_TZ = "America/Los_Angeles";
const SEND_WINDOW_START_HOUR = 9;
const SEND_WINDOW_END_HOUR = 16;

function calcSendWindow(now: Date): SendWindowCalc {
  const staggerMs = jitter([2 * 60_000, 6 * 60_000]);
  const parts = getZonedParts(now, SEND_WINDOW_TZ);

  let target: Date;
  if (parts.hour >= SEND_WINDOW_START_HOUR && parts.hour < SEND_WINDOW_END_HOUR) {
    target = new Date(now.getTime() + staggerMs);
    const targetParts = getZonedParts(target, SEND_WINDOW_TZ);
    if (targetParts.hour >= SEND_WINDOW_END_HOUR) {
      target = zonedWallTimeToUtc(
        parts.year,
        parts.month,
        parts.day + 1,
        SEND_WINDOW_START_HOUR,
        0,
        0,
        SEND_WINDOW_TZ,
      );
      target = new Date(target.getTime() + staggerMs);
    }
  } else if (parts.hour < SEND_WINDOW_START_HOUR) {
    target = zonedWallTimeToUtc(parts.year, parts.month, parts.day, SEND_WINDOW_START_HOUR, 0, 0, SEND_WINDOW_TZ);
    target = new Date(target.getTime() + staggerMs);
  } else {
    target = zonedWallTimeToUtc(
      parts.year,
      parts.month,
      parts.day + 1,
      SEND_WINDOW_START_HOUR,
      0,
      0,
      SEND_WINDOW_TZ,
    );
    target = new Date(target.getTime() + staggerMs);
  }

  return {
    nextAllowedSendUtc: target.toISOString(),
    delayMs: target.getTime() - now.getTime(),
    explanation:
      "Standard outbound is throttled to 9:00-16:00 America/Los_Angeles, staggered ~2-6 min apart, queued until the mailbox has capacity.",
  };
}

// --- step fixtures ---------------------------------------------------------

async function identifyStep(
  visit: VisitEvent,
  fixture: FixtureCompany | undefined,
  sendWindow: SendWindowCalc,
): Promise<{ identify: IdentifyResult; sendWindow: SendWindowCalc }> {
  await wait(jitter(STEP_DURATION_MS.identify));

  let identify: IdentifyResult;
  if (visit.manualDomain) {
    identify = fixture
      ? { company: toCompany(fixture), source: "manual", confidence: 1, reason: "Presenter-selected demo company" }
      : {
          company: undefined,
          source: "unresolved",
          confidence: 0,
          reason: `No fixture company matches domain "${visit.manualDomain}"`,
        };
  } else {
    identify = fixture
      ? { company: toCompany(fixture), source: "mock", confidence: 0.91, reason: "Resolved via mock reverse-IP lookup fixture" }
      : { company: undefined, source: "unresolved", confidence: 0, reason: "No fixture available" };
  }

  return { identify, sendWindow };
}

async function researchStep(company: Company | undefined): Promise<Research> {
  await wait(jitter(STEP_DURATION_MS.research));

  if (!company) {
    return {
      summary: "No company match yet, so research is limited to what's on the page they're viewing.",
      signals: [],
      techHints: [],
      sources: [],
      degraded: true,
    };
  }

  const fixture = findFixtureByDomain(company.domain);
  if (!fixture) {
    return {
      summary: `${company.name} is a known account, but detailed signals aren't available in the fixture set.`,
      signals: [],
      techHints: [],
      sources: [company.domain],
      degraded: true,
    };
  }

  return {
    summary: `${company.name} is active in ${company.industry ?? "its category"} and shows signals worth acting on.`,
    signals: fixture.research.signals,
    techHints: fixture.research.techHints,
    sources: [`${company.domain}/careers`, "public filings"],
    degraded: false,
  };
}

async function scoreStep(company: Company | undefined): Promise<IcpScore> {
  await wait(jitter(STEP_DURATION_MS.score));

  if (!company) {
    return { score: 20, reasons: ["No company identified yet"], verdict: "cold" };
  }

  const score = company.employeeCount && company.employeeCount > 1000 ? 64 : 82;
  return {
    score,
    reasons: [
      "Employee count in target band",
      `${company.industry ?? "Industry"} matches ICP vertical`,
      "Recent funding/hiring signals budget availability",
    ],
    verdict: score >= 75 ? "hot" : score >= 50 ? "warm" : "cold",
  };
}

const PERSONA_BY_INDUSTRY: Record<string, Persona> = {
  "Payments Infrastructure": {
    title: "VP of Engineering",
    department: "Engineering",
    whyThisPerson: "Owns reliability of the payments stack and is the economic buyer for observability tooling.",
  },
  "Financial Data Infrastructure": {
    title: "Head of Platform Engineering",
    department: "Platform Engineering",
    whyThisPerson: "Responsible for uptime of the API platform partners depend on.",
  },
  "Corporate Fintech": {
    title: "VP of Infrastructure",
    department: "Engineering",
    whyThisPerson: "Owns reliability of the banking and card infrastructure underneath the product.",
  },
  "Spend Management Fintech": {
    title: "Director of Payments Engineering",
    department: "Engineering",
    whyThisPerson: "Leads the team responsible for transaction reliability and reconciliation.",
  },
  "Card Issuing Infrastructure": {
    title: "Director of Platform Reliability",
    department: "Platform Engineering",
    whyThisPerson: "Accountable for uptime SLAs on the card issuing platform.",
  },
};

const DEFAULT_PERSONA: Persona = {
  title: "VP of Engineering",
  department: "Engineering",
  whyThisPerson: "Owns infrastructure reliability and is the economic buyer for observability tooling.",
};

async function personaStep(company: Company | undefined): Promise<Persona> {
  await wait(jitter(STEP_DURATION_MS.persona));
  if (!company?.industry) return DEFAULT_PERSONA;
  return PERSONA_BY_INDUSTRY[company.industry] ?? DEFAULT_PERSONA;
}

async function composeStep(company: Company | undefined, persona: Persona): Promise<Outreach> {
  await wait(jitter(STEP_DURATION_MS.compose));

  if (!company) {
    return {
      subject: "Following up on your visit",
      body: "Hi there,\n\nThanks for stopping by Northwind. Happy to answer any questions about observability for payments infrastructure.\n\nBest,\nThe Northwind Team",
      repBrief: ["No company match yet — keep the note generic", "Offer a resource instead of a hard ask"],
    };
  }

  return {
    subject: `Quick thought for ${company.name}`,
    body: `Hi there,\n\nNoticed ${company.name} has been active lately, and figured it was worth a quick note to the ${persona.department.toLowerCase()} team about observability for payments infrastructure.\n\nWorth 15 minutes this week?\n\nBest,\nThe Northwind Team`,
    repBrief: [
      "Lead with the most recent signal, not a generic intro",
      `Address the ${persona.title}, not a generic contact`,
      "Keep the ask to 15 minutes, no deck",
    ],
  };
}

async function engageStep(
  company: Company | undefined,
  visit: VisitEvent,
): Promise<{ engagement: LiveEngagement; engagedAtMs: number }> {
  await wait(jitter(STEP_DURATION_MS.engage));

  const engagement: LiveEngagement = {
    headline: "Still exploring options?",
    line: company
      ? `Teams like ${company.name} usually start with a 15-minute fit check.`
      : "Most teams start with a 15-minute fit check.",
    cta: "Grab a time",
    dismissible: true,
    shownAt: Date.now(),
  };

  return { engagement, engagedAtMs: Date.now() - visit.ts };
}

async function unifyStep(visit: VisitEvent): Promise<{ unifyRef: string; totalMs: number }> {
  await wait(jitter(STEP_DURATION_MS.unify));
  return { unifyRef: `unify_ref_${randomUUID().slice(0, 8)}`, totalMs: Date.now() - visit.ts };
}

// --- orchestration -----------------------------------------------------

async function runPipelineSteps(visitId: string): Promise<void> {
  const session = getSession(visitId);
  if (!session) {
    console.error(`[t60] visit=${visitId} pipeline aborted: session not found`);
    return;
  }
  const { visit } = session;

  const sendWindow = calcSendWindow(new Date(visit.ts));
  const fixture = resolveFixtureCompany(visit);

  const identifyOutcome = await withStep<{ identify: IdentifyResult; sendWindow: SendWindowCalc }>(
    "identify",
    visitId,
    () => identifyStep(visit, fixture, sendWindow),
    {
      identify: { company: undefined, source: "unresolved", confidence: 0, reason: "Identify step failed" },
      sendWindow,
    },
    (value) => ({ identify: value.identify, company: value.identify.company, sendWindow: value.sendWindow }),
  );
  const company = identifyOutcome.identify.company;

  await withStep<Research>(
    "research",
    visitId,
    () => researchStep(company),
    { summary: "Research step failed; continuing without enrichment.", signals: [], techHints: [], sources: [], degraded: true },
    (value) => ({ research: value }),
  );

  await withStep<IcpScore>(
    "score",
    visitId,
    () => scoreStep(company),
    { score: 0, reasons: ["Score step failed"], verdict: "cold" },
    (value) => ({ score: value }),
  );

  const persona = await withStep<Persona>(
    "persona",
    visitId,
    () => personaStep(company),
    DEFAULT_PERSONA,
    (value) => ({ persona: value }),
  );

  await withStep<Outreach>(
    "compose",
    visitId,
    () => composeStep(company, persona),
    {
      subject: "Following up",
      body: "Hi there,\n\nThanks for stopping by. We'll follow up shortly.\n\nBest,\nThe Northwind Team",
      repBrief: ["Compose step failed — keep this generic until retried"],
    },
    (value) => ({ outreach: value }),
  );

  await withStep<{ engagement: LiveEngagement; engagedAtMs: number }>(
    "engage",
    visitId,
    () => engageStep(company, visit),
    {
      engagement: {
        headline: "Still exploring options?",
        line: "Most teams start with a 15-minute fit check.",
        cta: "Grab a time",
        dismissible: true,
        shownAt: Date.now(),
      },
      engagedAtMs: Date.now() - visit.ts,
    },
    (value) => ({ engagement: value.engagement, engagedAtMs: value.engagedAtMs }),
  );

  await withStep<{ unifyRef: string; totalMs: number }>(
    "unify",
    visitId,
    () => unifyStep(visit),
    { unifyRef: "unify_ref_fallback", totalMs: Date.now() - visit.ts },
    (value) => ({ unifyRef: value.unifyRef, totalMs: value.totalMs }),
  );
}

// Never throws. withStep already contains every per-step failure; this is
// the outer net for anything unexpected (e.g. a bug in a toPatch mapper).
export async function runPipeline(visitId: string): Promise<void> {
  try {
    await runPipelineSteps(visitId);
  } catch (err) {
    console.error(`[t60] visit=${visitId} pipeline crashed unexpectedly`, err);
  }
}
