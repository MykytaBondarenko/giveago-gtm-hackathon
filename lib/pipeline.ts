import { getSession, emitStep, patchSession } from "./store";
import { research } from "./research";
import { identify } from "./identify";
import { scoreIcpRules, scoreAndAdvise, type PersonaSuggestion } from "./score";
import { choosePersonaRules } from "./people";
import { compose } from "./compose";
import { computeSendWindow } from "./sendWindow";
import { pushToUnify } from "./unify";
import type {
  Company,
  IcpScore,
  IdentifyResult,
  LiveEngagement,
  Outcome,
  Outreach,
  Persona,
  Research,
  SendWindowCalc,
  Session,
  StepName,
  UnifyPushResult,
  VisitEvent,
} from "./types";

// ORCHESTRATOR. identify(), research(), scoreAndAdvise(), choosePersonaRules(),
// compose(), computeSendWindow(), and pushToUnify() are all real now (see
// lib/identify.ts, lib/research.ts, lib/score.ts, lib/people.ts,
// lib/compose.ts, lib/sendWindow.ts, lib/unify.ts) — only engage's on-site
// copy comes from compose() but its "put it live" act is a fixture step
// with a short simulated delay. withStep is the safety net that makes each
// swap safe: a real call that errors or hangs degrades to fixture data
// instead of taking the demo down.
//
// score and persona are still two separate pipeline steps (StepName is
// fixed, and the dashboard visualizes each by name), but under the hood
// they share ONE analyst agent call: scoreStep runs it and threads its
// persona suggestion straight into personaStep's parameters, same as score
// itself is already threaded forward — not a second agent call.

const STEP_DURATION_MS: Record<StepName, [number, number]> = {
  identify: [400, 700],
  research: [900, 1600],
  score: [300, 500],
  persona: [300, 500],
  compose: [700, 1200],
  engage: [200, 400],
  unify: [400, 700],
};

// Must exceed every step's own internal budget (research.ts's OPENAI_TIMEOUT_MS
// is the longest at 12s, including its one retry) — otherwise this outer race
// kills a real call before its own retry/fallback logic ever gets to run.
const STEP_TIMEOUT_MS = 15_000;

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

type ScoreStepResult = { score: IcpScore; scoreRules: IcpScore; analystPersona?: PersonaSuggestion };

async function scoreStep(company: Company | undefined, research: Research): Promise<ScoreStepResult> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.score));
    const empty: IcpScore = {
      score: 0,
      reasons: [{ factor: "No company identified", points: 0, explanation: "There's nothing to score yet." }],
      verdict: "cold",
    };
    return { score: empty, scoreRules: empty };
  }
  const rules = scoreIcpRules(company, research);
  const { score, persona } = await scoreAndAdvise(company, research, rules);
  return { score, scoreRules: rules, analystPersona: persona };
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
  analystPersona: PersonaSuggestion | undefined,
): Promise<Persona> {
  if (!company) {
    await wait(jitter(STEP_DURATION_MS.persona));
    return DEFAULT_PERSONA;
  }
  // The analyst call already proposed a persona alongside the score — use it
  // directly rather than spend a second agent call re-deriving the same
  // thing. Only fall back to the rules table when that call didn't produce one.
  if (analystPersona) return { ...analystPersona };
  return choosePersonaRules(company, research, score, path);
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

// The single source of truth for what actually happened, read off the
// engage step's own last recorded event — never a separate flag that could
// drift out of sync with it.
function deriveOutcome(session: Session): Outcome {
  const engageEvents = session.steps.filter((e) => e.step === "engage");
  const last = engageEvents[engageEvents.length - 1];
  if (!last) return "queued-only";
  if (last.status === "done") return "engaged";
  if (last.status === "skipped") return "below-threshold";
  return "queued-only"; // engage was attempted (hot/warm) but errored — we still have a brief
}

// Re-reads the session so this sees every field patched by every earlier
// step (research, score, persona, outreach, engagement) without threading
// each one through as its own parameter. Also where the terminal state is
// computed: whatever happens to unify itself, the pipeline has reached its
// last step, so this is where finishedAtMs/outcome get set.
async function unifyStep(
  visitId: string,
  visit: VisitEvent,
): Promise<{ unifyPush: UnifyPushResult; totalMs: number; finishedAtMs: number; outcome: Outcome }> {
  const session = getSession(visitId);
  const unifyPush = session
    ? await pushToUnify(session)
    : ({ mode: "mock", skipped: true, reason: "Session not found" } satisfies UnifyPushResult);
  const finishedAtMs = Date.now() - visit.ts;
  const outcome = session ? deriveOutcome(session) : "failed";
  return { unifyPush, totalMs: finishedAtMs, finishedAtMs, outcome };
}

// Mathematically incapable of running forever: independent of every step's
// own timeout, this guarantees a terminal state exists 75s after visit
// start no matter what broke or hung. Whichever of {watchdog, natural
// completion} reaches patchSession first wins; the other is a no-op.
const WATCHDOG_MS = 75_000;

function armWatchdog(visitId: string, visit: VisitEvent): void {
  setTimeout(() => {
    const session = getSession(visitId);
    if (!session || session.finishedAtMs !== undefined) return;

    const finishedAtMs = Date.now() - visit.ts;
    console.error(`[t60] visit=${visitId} WATCHDOG fired after ${finishedAtMs}ms — forcing outcome "failed"`);
    patchSession(visitId, { finishedAtMs, outcome: "failed" });
    emitStep({
      visitId,
      step: "unify",
      status: "error",
      ms: finishedAtMs,
      note: "Watchdog: no terminal state 75s after visit start.",
      payload: {
        unifyPush: session.unifyPush ?? { mode: "mock", skipped: true, reason: "Watchdog timeout" },
        totalMs: finishedAtMs,
        finishedAtMs,
        outcome: "failed",
      },
    });
  }, WATCHDOG_MS);
}

// --- orchestration -----------------------------------------------------

async function runPipelineSteps(visitId: string): Promise<void> {
  const session = getSession(visitId);
  if (!session) {
    console.error(`[t60] visit=${visitId} pipeline aborted: session not found`);
    return;
  }
  const { visit } = session;
  armWatchdog(visitId, visit);

  const sendWindow = computeSendWindow(new Date(visit.ts));

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

  const failedScore: IcpScore = { score: 0, reasons: [{ factor: "Score step failed", points: 0, explanation: "The scoring step errored or timed out." }], verdict: "cold" };
  const scoreStepResult = await withStep<ScoreStepResult>(
    "score",
    visitId,
    () => scoreStep(company, researchResult),
    { score: failedScore, scoreRules: failedScore },
    (value) => ({ score: value.score, scoreRules: value.scoreRules }),
  );
  const score = scoreStepResult.score;

  const persona = await withStep<Persona>(
    "persona",
    visitId,
    () => personaStep(company, researchResult, score, visit.path, scoreStepResult.analystPersona),
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

  await withStep<{ unifyPush: UnifyPushResult; totalMs: number; finishedAtMs: number; outcome: Outcome }>(
    "unify",
    visitId,
    () => unifyStep(visitId, visit),
    {
      unifyPush: { mode: "mock", skipped: true, reason: "Unify step failed" },
      totalMs: Date.now() - visit.ts,
      finishedAtMs: Date.now() - visit.ts,
      outcome: deriveOutcome(getSession(visitId) ?? session),
    },
    (value) => ({
      unifyPush: value.unifyPush,
      totalMs: value.totalMs,
      finishedAtMs: value.finishedAtMs,
      outcome: value.outcome,
    }),
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
