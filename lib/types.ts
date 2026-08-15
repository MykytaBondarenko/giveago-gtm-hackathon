// Core types for the T60 pipeline. Types first, no classes.

export interface VisitEvent {
  id: string;
  ts: number;
  ip: string;
  userAgent: string;
  path: string;
  dwellMs: number;
  manualDomain?: string;
}

export interface Company {
  domain: string;
  name: string;
  employeeCount?: number;
  industry?: string;
  description?: string;
  hqCountry?: string;
}

export type SignalCategory = "hiring" | "funding" | "product" | "incident" | "expansion" | "tech";

export interface Signal {
  text: string;
  origin: "unify" | "agent";
  category: SignalCategory;
  date?: string;
  // Optional: a Unify custom-attribute signal has no per-field URL. Absence
  // is what drives the "unsourced" marker in the Signals panel — never
  // fabricate one to fill the gap.
  sourceUrl?: string;
}

export interface Research {
  summary: string;
  signals: Signal[];
  techHints: string[];
  sources: string[];
  degraded: boolean;
}

export interface ScoreReason {
  factor: string;
  points: number;
  explanation: string;
}

export interface IcpScore {
  score: number;
  reasons: ScoreReason[];
  verdict: "hot" | "warm" | "cold";
  confidence?: number;
  // Which research.signals[] index most justified this score — the same
  // signal the Signals panel pulls out as "the hook" and compose points
  // outreach copy at. Undefined when there were no signals to point to.
  topSignal?: number;
  // Set only when the primary score came from the rules fallback (agent
  // unavailable or failed validation twice) — absent means the agent scored it.
  scoreSource?: "agent" | "rules-fallback";
}

export interface Persona {
  title: string;
  department: string;
  whyThisPerson: string;
}

export interface Outreach {
  subject: string;
  body: string;
  repBrief: string[];
  guardrailsPassed: boolean;
}

export interface LiveEngagement {
  headline: string;
  line: string;
  cta: string;
  dismissible: true;
  shownAt?: number;
}

export interface SendWindowCalc {
  nextAllowedSendUtc: string;
  delayMs: number;
  explanation: string;
}

export interface IdentifyResult {
  company?: Company;
  source: "manual" | "unify" | "reverse-ip-fallback" | "unresolved" | "mock";
  confidence: number;
  reason?: string;
}

export interface UnifyOperationResult {
  payload: Record<string, unknown>;
  status: "simulated" | "dry-run" | "sent" | "error";
  response?: unknown;
  error?: string;
}

// The session's single terminal state. Set exactly once, by the pipeline,
// when the LAST step resolves — no matter whether that step (or any step)
// succeeded, was skipped, or errored. Nothing in the UI should ever freeze
// on a specific step name again; everything freezes on this.
export type Outcome = "engaged" | "queued-only" | "below-threshold" | "failed";

export interface UnifyPushResult {
  mode: "mock" | "dry-run" | "live";
  skipped?: boolean;
  reason?: string;
  company?: UnifyOperationResult;
  task?: UnifyOperationResult;
  sequence?: UnifyOperationResult;
}

export type StepName =
  | "identify"
  | "research"
  | "score"
  | "persona"
  | "compose"
  | "engage"
  | "unify";

export interface StepEvent {
  visitId: string;
  step: StepName;
  status: "start" | "done" | "error" | "skipped";
  ms: number;
  payload?: unknown;
  note?: string;
}

export interface Session {
  visit: VisitEvent;
  identify?: IdentifyResult;
  company?: Company;
  research?: Research;
  score?: IcpScore;
  // Deterministic scoreIcpRules() output, computed alongside the agent score
  // every run — the muted "rules baseline" comparison shown next to it.
  scoreRules?: IcpScore;
  persona?: Persona;
  outreach?: Outreach;
  engagement?: LiveEngagement;
  sendWindow?: SendWindowCalc;
  unifyPush?: UnifyPushResult;
  steps: StepEvent[];
  totalMs?: number;
  engagedAtMs?: number;
  engagementDismissedAt?: number;
  finishedAtMs?: number;
  outcome?: Outcome;
}
