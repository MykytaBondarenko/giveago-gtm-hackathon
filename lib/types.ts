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

export interface Signal {
  text: string;
  origin: "unify" | "agent";
  date?: string;
  source?: string;
}

export interface Research {
  summary: string;
  signals: Signal[];
  techHints: string[];
  sources: string[];
  degraded: boolean;
}

export interface IcpScore {
  score: number;
  reasons: string[];
  verdict: "hot" | "warm" | "cold";
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
  persona?: Persona;
  outreach?: Outreach;
  engagement?: LiveEngagement;
  sendWindow?: SendWindowCalc;
  unifyPush?: UnifyPushResult;
  steps: StepEvent[];
  totalMs?: number;
  engagedAtMs?: number;
  engagementDismissedAt?: number;
}
