"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  IcpScore,
  IdentifyResult,
  LiveEngagement,
  Outreach,
  Persona,
  Research,
  SendWindowCalc,
  Session,
  StepEvent,
  StepName,
} from "@/lib/types";

const STEP_ORDER: StepName[] = [
  "identify",
  "research",
  "score",
  "persona",
  "compose",
  "engage",
  "unify",
];

const STEP_LABELS: Record<StepName, string> = {
  identify: "Identify",
  research: "Research",
  score: "Score",
  persona: "Persona",
  compose: "Compose",
  engage: "Engage",
  unify: "Unify",
};

type IdentifyPayload = { identify: IdentifyResult; sendWindow: SendWindowCalc };
type EngagePayload = { engagement: LiveEngagement; engagedAtMs: number };
type UnifyPayload = { unifyRef: string; totalMs: number };

// Sessions arriving via SSE after the initial snapshot are known only through
// their StepEvent stream, so we rebuild each session incrementally.
function applyStepEvent(sessions: Session[], event: StepEvent): Session[] {
  const idx = sessions.findIndex((s) => s.visit.id === event.visitId);
  const base: Session =
    idx === -1
      ? {
          visit: {
            id: event.visitId,
            ts: Date.now(),
            ip: "",
            userAgent: "",
            path: "",
            dwellMs: 0,
          },
          steps: [],
        }
      : { ...sessions[idx] };

  const next: Session = { ...base, steps: [...base.steps, event] };

  if (event.status === "done" && event.payload !== undefined) {
    switch (event.step) {
      case "identify": {
        const { identify, sendWindow } = event.payload as IdentifyPayload;
        next.identify = identify;
        next.company = identify.company;
        next.sendWindow = sendWindow;
        break;
      }
      case "research":
        next.research = event.payload as Research;
        break;
      case "score":
        next.score = event.payload as IcpScore;
        break;
      case "persona":
        next.persona = event.payload as Persona;
        break;
      case "compose":
        next.outreach = event.payload as Outreach;
        break;
      case "engage": {
        const { engagement, engagedAtMs } = event.payload as EngagePayload;
        next.engagement = engagement;
        next.engagedAtMs = engagedAtMs;
        break;
      }
      case "unify": {
        const { unifyRef, totalMs } = event.payload as UnifyPayload;
        next.unifyRef = unifyRef;
        next.totalMs = totalMs;
        break;
      }
    }
  }

  const rest = idx === -1 ? sessions : sessions.filter((_, i) => i !== idx);
  return [next, ...rest].sort((a, b) => b.visit.ts - a.visit.ts).slice(0, 20);
}

type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

function getStepInfo(session: Session, step: StepName): { status: StepStatus; ms?: number } {
  const events = session.steps.filter((e) => e.step === step);
  if (events.length === 0) return { status: "pending" };
  const last = events[events.length - 1];
  if (last.status === "start") return { status: "running" };
  return { status: last.status, ms: last.ms };
}

function formatElapsed(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

const VERDICT_STYLES: Record<IcpScore["verdict"], string> = {
  hot: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
  warm: "bg-amber-500/15 text-amber-400 border-amber-500/40",
  cold: "bg-sky-500/15 text-sky-400 border-sky-500/40",
};

export default function DashboardPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/stream");

    es.addEventListener("snapshot", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as Session[];
      setSessions(data);
      setActiveId((prev) => prev ?? data[0]?.visit.id ?? null);
    });

    es.addEventListener("step", (event) => {
      const stepEvent = JSON.parse((event as MessageEvent).data) as StepEvent;
      setSessions((prev) => applyStepEvent(prev, stepEvent));
      if (stepEvent.step === "identify" && stepEvent.status === "start") {
        setActiveId(stepEvent.visitId);
      }
    });

    return () => es.close();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.visit.id === activeId) ?? sessions[0],
    [sessions, activeId],
  );

  const ourLaneFrozen = activeSession?.engagedAtMs !== undefined;
  const ourLaneMs = activeSession
    ? (activeSession.engagedAtMs ?? Date.now() - activeSession.visit.ts)
    : 0;

  const standardLaneMs = activeSession?.sendWindow
    ? new Date(activeSession.sendWindow.nextAllowedSendUtc).getTime() - Date.now()
    : null;

  return (
    <main className="flex-1 flex flex-col gap-8 p-8 max-w-[1600px] mx-auto w-full">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white/90">
          T60 <span className="text-white/40">—</span> inbound response in under 60 seconds
        </h1>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.04] p-8 flex flex-col items-center justify-center gap-2">
          <span className="uppercase tracking-widest text-sm font-semibold text-emerald-400/80">
            Our lane
          </span>
          <span
            className="font-mono font-bold text-emerald-400 leading-none tabular-nums"
            style={{ fontSize: "clamp(4rem, 12vw, 9rem)" }}
          >
            {activeSession ? formatElapsed(ourLaneMs) : "—"}
          </span>
          <span className="text-emerald-400/60 text-sm">
            {ourLaneFrozen ? "engaged on-site" : "counting up since visit"}
          </span>
        </div>

        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-8 flex flex-col items-center justify-center gap-2">
          <span className="uppercase tracking-widest text-sm font-semibold text-red-400/50">
            Standard outbound lane
          </span>
          <span
            className="font-mono font-bold text-red-400/60 leading-none tabular-nums"
            style={{ fontSize: "clamp(4rem, 12vw, 9rem)" }}
          >
            {standardLaneMs === null ? "—" : formatCountdown(standardLaneMs)}
          </span>
          <span className="text-red-400/40 text-sm text-center max-w-sm">
            {activeSession?.sendWindow?.explanation ?? "queue delay until next allowed send window"}
          </span>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 flex-1 min-h-0">
        <div className="flex flex-col gap-2 overflow-y-auto max-h-[70vh] lg:max-h-none pr-1">
          {sessions.length === 0 && (
            <div className="text-white/30 text-sm p-4">Waiting for the first visit…</div>
          )}
          {sessions.map((session) => (
            <button
              key={session.visit.id}
              onClick={() => setActiveId(session.visit.id)}
              className={`text-left rounded-xl border px-4 py-3 transition-colors cursor-pointer ${
                session.visit.id === activeId
                  ? "border-white/30 bg-white/[0.06]"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-white/90 truncate">
                  {session.company?.name ?? "Identifying…"}
                </span>
                {session.score && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${VERDICT_STYLES[session.score.verdict]}`}
                  >
                    {session.score.verdict}
                  </span>
                )}
              </div>
              <div className="text-xs text-white/40 mt-1">
                {new Date(session.visit.ts).toLocaleTimeString()} · {session.visit.path}
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-6 min-w-0">
          {activeSession ? (
            <>
              <PipelineTrack session={activeSession} />
              {activeSession.identify && <ResultsPanel session={activeSession} />}
            </>
          ) : (
            <div className="text-white/30 text-sm">No sessions yet.</div>
          )}
        </div>
      </section>
    </main>
  );
}

function PipelineTrack({ session }: { session: Session }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <div className="grid grid-cols-7 gap-2">
        {STEP_ORDER.map((step) => {
          const info = getStepInfo(session, step);
          return (
            <div key={step} className="flex flex-col items-center gap-2 text-center">
              <div
                className={`w-full h-2 rounded-full ${stepColor(info.status)} ${
                  info.status === "running" ? "animate-pulse-glow" : ""
                }`}
              />
              <span className="text-xs font-medium text-white/70">{STEP_LABELS[step]}</span>
              <span className="text-[11px] text-white/35">
                {info.status === "done" && info.ms !== undefined
                  ? `${info.ms}ms`
                  : info.status === "running"
                    ? "running…"
                    : info.status === "error"
                      ? "error"
                      : info.status === "skipped"
                        ? "skipped"
                        : "pending"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function stepColor(status: StepStatus): string {
  switch (status) {
    case "done":
      return "bg-emerald-500";
    case "running":
      return "bg-amber-400";
    case "error":
      return "bg-red-500";
    case "skipped":
      return "bg-white/15";
    default:
      return "bg-white/10";
  }
}

function ResultsPanel({ session }: { session: Session }) {
  const { company, score, persona, outreach } = session;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_260px] gap-6 items-start">
      <div className="flex flex-col gap-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-sm uppercase tracking-widest text-white/40 mb-3">Company</h2>
          {company ? (
            <>
              <div className="text-xl font-semibold text-white/90">{company.name}</div>
              <div className="text-white/50 text-sm mt-1">{company.domain}</div>
              {company.description && (
                <p className="text-white/60 text-sm mt-3">{company.description}</p>
              )}
              <div className="flex flex-wrap gap-3 mt-4 text-xs text-white/40">
                {company.industry && <span>{company.industry}</span>}
                {company.employeeCount && <span>{company.employeeCount} employees</span>}
                {company.hqCountry && <span>{company.hqCountry}</span>}
              </div>
            </>
          ) : (
            <div className="text-white/30 text-sm">Resolving…</div>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm uppercase tracking-widest text-white/40">ICP score</h2>
            {score && (
              <span className={`text-xs px-2 py-0.5 rounded-full border ${VERDICT_STYLES[score.verdict]}`}>
                {score.verdict}
              </span>
            )}
          </div>
          {score ? (
            <>
              <div className="text-3xl font-bold text-white/90">{score.score}</div>
              <ul className="mt-3 space-y-1 text-sm text-white/60 list-disc list-inside">
                {score.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <div className="text-white/30 text-sm">Scoring…</div>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-sm uppercase tracking-widest text-white/40 mb-3">Persona</h2>
          {persona ? (
            <>
              <div className="text-lg font-semibold text-white/90">{persona.title}</div>
              <div className="text-white/50 text-sm">{persona.department}</div>
              <p className="text-white/60 text-sm mt-2">{persona.whyThisPerson}</p>
            </>
          ) : (
            <div className="text-white/30 text-sm">Selecting…</div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col">
        <div className="bg-white/[0.04] px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/60" />
          <span className="ml-2 text-xs text-white/40">Draft — dry-run</span>
        </div>
        {outreach ? (
          <>
            <div className="p-5 flex flex-col gap-3">
              <div className="text-sm text-white/40">Subject</div>
              <div className="text-white/90 font-medium">{outreach.subject}</div>
              <div className="text-sm text-white/40 mt-2">Body</div>
              <pre className="whitespace-pre-wrap font-sans text-white/70 text-sm leading-relaxed">
                {outreach.body}
              </pre>
            </div>
            <div className="mt-auto border-t border-white/10 p-5">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Rep brief</div>
              <ul className="space-y-1 text-sm text-white/60 list-disc list-inside">
                {outreach.repBrief.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <div className="p-5 text-white/30 text-sm">Drafting…</div>
        )}
      </div>

      <div className="rounded-[2.5rem] border-4 border-white/15 bg-white/[0.02] p-3 h-[420px] flex flex-col">
        <div className="mx-auto w-16 h-1 rounded-full bg-white/15 mb-3" />
        <div className="flex-1 rounded-[1.75rem] border border-white/10 flex items-center justify-center">
          <span className="text-white/20 text-xs text-center px-6">Live banner mirror — reserved</span>
        </div>
      </div>
    </div>
  );
}
