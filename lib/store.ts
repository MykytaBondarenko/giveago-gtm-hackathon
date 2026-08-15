import type { Session, StepEvent, VisitEvent } from "./types";

const sessions = new Map<string, Session>();
const subscribers = new Set<(event: StepEvent) => void>();

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
