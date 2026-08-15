import { randomUUID } from "crypto";
import { createSession, emitStep, patchSession } from "./store";
import type {
  Company,
  IcpScore,
  IdentifyResult,
  LiveEngagement,
  Outreach,
  Persona,
  Research,
  SendWindowCalc,
  StepName,
  VisitEvent,
} from "./types";

// STUB PIPELINE. Every step below is fake payload + a timer, so the
// dashboard can be built and animated before real integrations exist.
// Swap each block for the real identify/research/score/persona/compose/
// engage/unify calls behind the MOCK_* env flags described in AGENTS.md.

const STEP_ORDER: StepName[] = [
  "identify",
  "research",
  "score",
  "persona",
  "compose",
  "engage",
  "unify",
];

const STEP_DURATION_MS: Record<StepName, [number, number]> = {
  identify: [400, 700],
  research: [900, 1600],
  score: [300, 500],
  persona: [300, 500],
  compose: [700, 1200],
  engage: [200, 400],
  unify: [400, 700],
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter([min, max]: [number, number]): number {
  return Math.round(min + Math.random() * (max - min));
}

const MOCK_COMPANIES: Company[] = [
  {
    domain: "acme-robotics.io",
    name: "Acme Robotics",
    employeeCount: 340,
    industry: "Industrial Automation",
    description: "Builds autonomous warehouse picking robots for 3PLs.",
    hqCountry: "US",
  },
  {
    domain: "northstar-logistics.com",
    name: "Northstar Logistics",
    employeeCount: 1200,
    industry: "Freight & Logistics",
    description: "Mid-market freight brokerage expanding into 3PL warehousing.",
    hqCountry: "US",
  },
  {
    domain: "brightfield.ai",
    name: "Brightfield",
    employeeCount: 85,
    industry: "AgTech",
    description: "Computer vision for crop yield forecasting.",
    hqCountry: "IE",
  },
];

function mockIdentify(company: Company): IdentifyResult {
  return {
    company,
    source: "mock",
    confidence: 0.91,
    reason: "Resolved via mock reverse-IP lookup fixture",
  };
}

function mockResearch(company: Company): Research {
  return {
    summary: `${company.name} is scaling and shows active buying signals in ${company.industry ?? "its category"}.`,
    signals: [
      { text: "Raised new funding round", origin: "unify", source: "Crunchbase" },
      { text: "Posted several ops/eng roles this month", origin: "agent", source: "Careers page" },
      { text: "Visited pricing page twice in one week", origin: "unify" },
    ],
    techHints: ["Segment", "HubSpot", "AWS"],
    sources: [`${company.domain}/careers`, "crunchbase.com"],
    degraded: false,
  };
}

function mockScore(company: Company): IcpScore {
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

function mockPersona(): Persona {
  return {
    title: "VP of Operations",
    department: "Operations",
    whyThisPerson: "Owns operational throughput and is the economic buyer for this category of tooling.",
  };
}

function mockOutreach(company: Company, persona: Persona): Outreach {
  return {
    subject: `Quick thought for ${company.name}`,
    body: `Hi there,\n\nNoticed ${company.name} has been active lately, and figured it was worth a quick note to the ${persona.department.toLowerCase()} team.\n\nWorth 15 minutes this week?\n\nBest,\nThe Team`,
    repBrief: [
      "Lead with the most recent signal, not a generic intro",
      `Address the ${persona.title}, not a generic contact`,
      "Keep the ask to 15 minutes, no deck",
    ],
  };
}

function mockEngagement(company: Company): LiveEngagement {
  return {
    headline: "Still exploring options?",
    line: `Teams like ${company.name} usually start with a 15-minute fit check.`,
    cta: "Grab a time",
    dismissible: true,
    shownAt: Date.now(),
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

export async function runPipeline(visit: VisitEvent): Promise<void> {
  createSession(visit);

  const company = MOCK_COMPANIES[Math.floor(Math.random() * MOCK_COMPANIES.length)];
  const sendWindow = calcSendWindow(new Date(visit.ts));
  patchSession(visit.id, { sendWindow });

  let persona: Persona | undefined;

  for (const step of STEP_ORDER) {
    emitStep({ visitId: visit.id, step, status: "start", ms: 0 });
    const duration = jitter(STEP_DURATION_MS[step]);
    await wait(duration);

    let payload: unknown;
    switch (step) {
      case "identify": {
        const identify = mockIdentify(company);
        patchSession(visit.id, { identify, company });
        payload = { identify, sendWindow };
        break;
      }
      case "research": {
        const research = mockResearch(company);
        patchSession(visit.id, { research });
        payload = research;
        break;
      }
      case "score": {
        const score = mockScore(company);
        patchSession(visit.id, { score });
        payload = score;
        break;
      }
      case "persona": {
        persona = mockPersona();
        patchSession(visit.id, { persona });
        payload = persona;
        break;
      }
      case "compose": {
        const outreach = mockOutreach(company, persona ?? mockPersona());
        patchSession(visit.id, { outreach });
        payload = outreach;
        break;
      }
      case "engage": {
        const engagement = mockEngagement(company);
        const engagedAtMs = Date.now() - visit.ts;
        patchSession(visit.id, { engagement, engagedAtMs });
        payload = { engagement, engagedAtMs };
        break;
      }
      case "unify": {
        const unifyRef = `unify_ref_${randomUUID().slice(0, 8)}`;
        const totalMs = Date.now() - visit.ts;
        patchSession(visit.id, { unifyRef, totalMs });
        payload = { unifyRef, totalMs };
        break;
      }
    }

    console.log(`[t60] visit=${visit.id} step=${step} status=done ms=${duration}`);
    emitStep({ visitId: visit.id, step, status: "done", ms: duration, payload });
  }
}

function generateMockVisit(): VisitEvent {
  const paths = ["/pricing", "/product", "/docs", "/", "/customers"];
  return {
    id: randomUUID(),
    ts: Date.now(),
    ip: `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    path: paths[Math.floor(Math.random() * paths.length)],
    dwellMs: jitter([4000, 60000]),
  };
}

declare global {
  var __t60DemoLoopStarted: boolean | undefined;
}

export function startDemoLoop(intervalMs = 9000): void {
  if (globalThis.__t60DemoLoopStarted) return;
  globalThis.__t60DemoLoopStarted = true;

  void runPipeline(generateMockVisit());
  setInterval(() => {
    void runPipeline(generateMockVisit());
  }, intervalMs);
}
