import type { Company, Session, StepEvent, VisitEvent } from "./types";

// Backed by globalThis, not a plain module-level variable: `next dev`
// recompiles routes on demand and can evict an inactive one, which would
// otherwise hand this module a fresh Map and silently drop every session.
// globalThis is the one thing that survives that recompilation.
declare global {
  var __t60Sessions: Map<string, Session> | undefined;
  var __t60Subscribers: Set<(event: StepEvent) => void> | undefined;
  var __t60UnifyReveals: Map<string, { company: Company; visitId?: string; receivedAt: number }> | undefined;
}

const sessions = (globalThis.__t60Sessions ??= new Map<string, Session>());
const subscribers = (globalThis.__t60Subscribers ??= new Set<(event: StepEvent) => void>());
// Unify Play webhooks arrive out of band from the pipeline's synchronous
// identify step, keyed by visitor IP so identify() can poll for a reveal
// that lands just after the request that triggered it.
const unifyReveals = (globalThis.__t60UnifyReveals ??= new Map());

export function createSession(visit: VisitEvent): Session {
  const session: Session = { visit, steps: [] };
  sessions.set(visit.id, session);
  return session;
}

export function getSession(visitId: string): Session | undefined {
  return sessions.get(visitId);
}

export function listSessions(): Session[] {
  return Array.from(sessions.values())
    .sort((a, b) => b.visit.ts - a.visit.ts)
    .slice(0, 20);
}

export function patchSession(visitId: string, patch: Partial<Session>): Session | undefined {
  const existing = sessions.get(visitId);
  if (!existing) return undefined;
  const updated: Session = { ...existing, ...patch };
  sessions.set(visitId, updated);
  return updated;
}

export function emitStep(event: StepEvent): void {
  const session = sessions.get(event.visitId);
  if (session) {
    session.steps.push(event);
  }
  for (const cb of subscribers) {
    cb(event);
  }
}

export function subscribe(cb: (event: StepEvent) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// Most-recent session whose visit.ip matches, seen within the last `withinMs`.
export function findSessionByIp(ip: string, withinMs: number): Session | undefined {
  const now = Date.now();
  let best: Session | undefined;
  for (const session of sessions.values()) {
    if (session.visit.ip === ip && now - session.visit.ts <= withinMs) {
      if (!best || session.visit.ts > best.visit.ts) best = session;
    }
  }
  return best;
}

export function recordUnifyReveal(ip: string, company: Company, visitId?: string): void {
  unifyReveals.set(ip, { company, visitId, receivedAt: Date.now() });
}

export function peekUnifyReveal(ip: string, maxAgeMs: number): Company | undefined {
  const entry = unifyReveals.get(ip);
  if (!entry) return undefined;
  if (Date.now() - entry.receivedAt > maxAgeMs) return undefined;
  return entry.company;
}

// Frequency cap: once dismissed, a session's banner is never sent again.
// Persisted on the session itself so /api/engage-stream can check it on
// every connect, including a reconnect after the tab was reloaded.
export function markEngagementDismissed(visitId: string): void {
  patchSession(visitId, { engagementDismissedAt: Date.now() });
}
