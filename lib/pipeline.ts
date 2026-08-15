import { randomUUID } from "crypto";
import { getSession, emitStep, patchSession } from "./store";
import { research } from "./research";
import { identify } from "./identify";
import { scoreIcp } from "./score";
import { choosePersona } from "./people";
import { compose } from "./compose";
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
  StepName,
  VisitEvent,
} from "./types";

// ORCHESTRATOR. identify(), research(), scoreIcp(), and choosePersona() are
// real (see lib/identify.ts, lib/research.ts, lib/score.ts, lib/people.ts);
// compose/engage/unify still return fixture data after a short delay
// pending later tasks. withStep is the safety net that makes each swap
// safe: a real call that errors or hangs degrades to fixture data instead
// of taking the demo down.

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
  sendWindow: SendWindowCalc,
): Promise<{ identify: IdentifyResult; sendWindow: SendWindowCalc }> {
  const result = await identify(visit);
  return { identify: result, sendWindow };
}

async function researchStep(company: Company | undefined): Promise<Research> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.research));
    return {
      summary: "No company match yet, so research is limited to what's on the page they're viewing.",
      signals: [],
      techHints: [],
      sources: [],
      degraded: true,
    };
  }

  return research(company);
}

async function scoreStep(company: Company | undefined, research: Research): Promise<IcpScore> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.score));
    return { score: 0, reasons: ["No company identified yet, so there's nothing to score."], verdict: "cold" };
  }
  return scoreIcp(company, research);
}

const DEFAULT_PERSONA: Persona = {
  title: "VP Engineering",
  department: "Engineering",
  whyThisPerson: "Owns infrastructure reliability and is the economic buyer for observability tooling.",
};

async function personaStep(
  company: Company | undefined,
  research: Research,
  score: IcpScore,
  path: string,
): Promise<Persona> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.persona));
    return DEFAULT_PERSONA;
  }
  return choosePersona(company, research, score, path);
}

type ComposeResult = { outreach: Outreach; engagement: LiveEngagement };

// One call produces both the email and the banner copy together (see
// lib/compose.ts) — the "no company" branch here is the only place that
// still hand-writes both, since compose() assumes a real company to work with.
async function composeStep(
  company: Company | undefined,
  research: Research,
  score: IcpScore,
  persona: Persona,
  visit: VisitEvent,
): Promise<ComposeResult> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.compose));
    return {
      outreach: {
        subject: "thanks for stopping by",
        body: "Hi there,\nThanks for checking out Northwind.\nHappy to answer any questions about payments observability.",
        repBrief: ["No company identified yet — keep this generic", "Offer a resource instead of a hard ask"],
        guardrailsPassed: true,
      },
      engagement: {
        headline: "Still exploring options?",
        line: "Most teams start with a short fit check.",
        cta: "Grab a time",
        dismissible: true,
      },
    };
  }

  return compose(company, research, score, persona, visit);
}

// The banner's copy was already written in the compose step — this step is
// the act of actually putting it live, so it's what sets shownAt/engagedAtMs.
async function engageStep(
  engagement: LiveEngagement,
  visit: VisitEvent,
): Promise<{ engagement: LiveEngagement; engagedAtMs: number }> {
  await wait(jitter(STEP_DURATION_MS.engage));
  const shown: LiveEngagement = { ...engagement, shownAt: Date.now() };
  return { engagement: shown, engagedAtMs: Date.now() - visit.ts };
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

  const identifyOutcome = await withStep<{ identify: IdentifyResult; sendWindow: SendWindowCalc }>(
    "identify",
    visitId,
    () => identifyStep(visit, sendWindow),
    {
      identify: { company: undefined, source: "unresolved", confidence: 0, reason: "Identify step failed" },
      sendWindow,
    },
    (value) => ({ identify: value.identify, company: value.identify.company, sendWindow: value.sendWindow }),
  );
  const company = identifyOutcome.identify.company;

  const researchResult = await withStep<Research>(
    "research",
    visitId,
    () => researchStep(company),
    { summary: "Research step failed; continuing without enrichment.", signals: [], techHints: [], sources: [], degraded: true },
    (value) => ({ research: value }),
  );

  const score = await withStep<IcpScore>(
    "score",
    visitId,
    () => scoreStep(company, researchResult),
    { score: 0, reasons: ["Score step failed"], verdict: "cold" },
    (value) => ({ score: value }),
  );

  const persona = await withStep<Persona>(
    "persona",
    visitId,
    () => personaStep(company, researchResult, score, visit.path),
    DEFAULT_PERSONA,
    (value) => ({ persona: value }),
  );

  const composeResult = await withStep<ComposeResult>(
    "compose",
    visitId,
    () => composeStep(company, researchResult, score, persona, visit),
    {
      outreach: {
        subject: "following up",
        body: "Hi there,\nThanks for stopping by. We'll follow up shortly.",
        repBrief: ["Compose step failed — keep this generic until retried"],
        guardrailsPassed: true,
      },
      engagement: {
        headline: "Still exploring options?",
        line: "Most teams start with a short fit check.",
        cta: "Grab a time",
        dismissible: true,
      },
    },
    (value) => ({ outreach: value.outreach }),
  );

  // Restraint is a feature: below ICP threshold, no banner. The step is
  // explicitly "skipped" (not run and defaulted) so the dashboard can say so.
  if (score.verdict === "cold") {
    const note = "Below ICP threshold (cold) — no banner shown.";
    console.log(`[t60] visit=${visitId} step=engage status=skipped ms=0 note="${note}"`);
    emitStep({ visitId, step: "engage", status: "skipped", ms: 0, note });
  } else {
    await withStep<{ engagement: LiveEngagement; engagedAtMs: number }>(
      "engage",
      visitId,
      () => engageStep(composeResult.engagement, visit),
      {
        engagement: {
          headline: "Still exploring options?",
          line: "Most teams start with a short fit check.",
          cta: "Grab a time",
          dismissible: true,
          shownAt: Date.now(),
        },
        engagedAtMs: Date.now() - visit.ts,
      },
      (value) => ({ engagement: value.engagement, engagedAtMs: value.engagedAtMs }),
    );
  }

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
