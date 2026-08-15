import type { SendWindowCalc } from "./types";

// Modeled on Unify's own documented deliverability constraints for cold
// outbound sent through their sequences product (see AGENTS.md, sourced
// from Unify's platform docs): a daily send-volume cap per mailbox, an
// allowed sending window, and a stagger between individual sends so
// delivery doesn't look automated. This is what the "standard outbound
// lane" timer on the dashboard is honestly modeling — not a number we
// invented.
export const UNIFY_SEND_CONSTRAINTS = {
  timeZone: "America/Los_Angeles",
  windowStartHour: 9,
  windowEndHour: 16,
  maxEmailsPerMailboxPerDay: 25,
  staggerMinMinutes: 2,
  staggerMaxMinutes: 6,
} as const;

function jitter(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
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

function addDays(year: number, month: number, day: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isWeekend(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  return weekday === 0 || weekday === 6;
}

function nextWeekday(year: number, month: number, day: number) {
  let d = { year, month, day };
  while (isWeekend(d.year, d.month, d.day)) {
    d = addDays(d.year, d.month, d.day, 1);
  }
  return d;
}

// The next allowed window-open instant on or after today+dayOffset,
// skipping weekends, with the stagger already added on top.
function nextWindowStart(
  year: number,
  month: number,
  day: number,
  dayOffset: number,
  staggerMs: number,
): Date {
  const { timeZone, windowStartHour } = UNIFY_SEND_CONSTRAINTS;
  const candidate = addDays(year, month, day, dayOffset);
  const weekday = nextWeekday(candidate.year, candidate.month, candidate.day);
  const windowStart = zonedWallTimeToUtc(weekday.year, weekday.month, weekday.day, windowStartHour, 0, 0, timeZone);
  return new Date(windowStart.getTime() + staggerMs);
}

function formatDelay(delayMs: number): string {
  const totalMinutes = Math.max(0, Math.round(delayMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

// Pure — no network, no LLM. Same instant in, same result out, every time:
// on stage this needs to be numbers anyone can recompute by hand, not a
// black box.
export function computeSendWindow(now: Date): SendWindowCalc {
  const { timeZone, windowStartHour, windowEndHour, staggerMinMinutes, staggerMaxMinutes } = UNIFY_SEND_CONSTRAINTS;
  const staggerMs = jitter(staggerMinMinutes * 60_000, staggerMaxMinutes * 60_000);
  const parts = getZonedParts(now, timeZone);

  const withinWindowToday =
    !isWeekend(parts.year, parts.month, parts.day) && parts.hour >= windowStartHour && parts.hour < windowEndHour;

  let target: Date;

  if (withinWindowToday) {
    const candidate = new Date(now.getTime() + staggerMs);
    const candidateHour = getZonedParts(candidate, timeZone).hour;
    target =
      candidateHour < windowEndHour
        ? candidate
        : nextWindowStart(parts.year, parts.month, parts.day, 1, staggerMs);
  } else {
    const beforeWindowToday = !isWeekend(parts.year, parts.month, parts.day) && parts.hour < windowStartHour;
    target = nextWindowStart(parts.year, parts.month, parts.day, beforeWindowToday ? 0 : 1, staggerMs);
  }

  const delayMs = target.getTime() - now.getTime();

  return {
    nextAllowedSendUtc: target.toISOString(),
    delayMs,
    explanation: `Queued — next send window opens in ${formatDelay(delayMs)} (${windowStartHour}:00 PT).`,
  };
}
