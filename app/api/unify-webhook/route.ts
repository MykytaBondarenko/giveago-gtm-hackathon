import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createSession, findSessionByIp, getSession, patchSession, recordUnifyReveal, emitStep } from "@/lib/store";
import { runPipeline } from "@/lib/pipeline";
import type { Company, IdentifyResult, VisitEvent } from "@/lib/types";

export const runtime = "nodejs";

const IP_CORRELATION_WINDOW_MS = 5 * 60_000;

// The webhook action on a Unify Play is fully configurable on Unify's side
// (URL, method, headers, query params, body — all set from their dashboard,
// see docs.unifygtm.com/reference/plays/actions), so there's no fixed public
// payload schema to code against ahead of time. This checks the shared
// secret in whichever spot is easiest to configure and logs the raw body
// unconditionally so the real shape can be read back once a Play is wired
// up to this endpoint.
function verifySecret(request: Request): boolean {
  const expected = process.env.UNIFY_WEBHOOK_SECRET;
  if (!expected) return false;

  const url = new URL(request.url);
  const headerSecret = request.headers.get("x-unify-webhook-secret");
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : undefined;
  const querySecret = url.searchParams.get("secret");

  return [headerSecret, bearer, querySecret].some((candidate) => candidate === expected);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  }
  return undefined;
}

type PlainRecord = Record<string, unknown>;

function asRecord(value: unknown): PlainRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PlainRecord) : undefined;
}

// The triggering company record may arrive flat, or nested under a wrapper
// key depending on how the Play's webhook body template was written.
function extractCompany(payload: PlainRecord): Company | undefined {
  const candidates = [payload, asRecord(payload.company), asRecord(payload.data), asRecord(payload.record)].filter(
    (candidate): candidate is PlainRecord => Boolean(candidate),
  );

  for (const candidate of candidates) {
    const domain = firstString(candidate.domain, candidate.website);
    if (!domain) continue;

    const address = asRecord(candidate.address);
    return {
      domain: domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
      name: firstString(candidate.name, candidate.company_name) ?? domain,
      employeeCount: firstNumber(candidate.employee_count, candidate.employeeCount, candidate.headcount),
      industry: firstString(candidate.industry),
      description: firstString(candidate.description),
      hqCountry: firstString(address?.country, candidate.hq_country, candidate.country),
    };
  }

  return undefined;
}

function extractVisitId(payload: PlainRecord): string | undefined {
  const person = asRecord(payload.person);
  const traits = asRecord(payload.traits) ?? asRecord(person?.traits);
  return firstString(payload.visitId, payload.visit_id, payload.external_id, traits?.visitId, traits?.visit_id);
}

function extractIp(payload: PlainRecord): string | undefined {
  const person = asRecord(payload.person);
  return firstString(payload.ip, payload.ip_address, payload.visitor_ip, payload.request_ip, person?.ip);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  console.log(`[t60] unify-webhook raw payload: ${rawBody}`);

  if (!verifySecret(request)) {
    console.log("[t60] unify-webhook rejected: missing or invalid shared secret");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: PlainRecord;
  try {
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
    payload = asRecord(parsed) ?? {};
  } catch {
    console.log("[t60] unify-webhook rejected: payload was not valid JSON");
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const company = extractCompany(payload);
  if (!company) {
    console.log("[t60] unify-webhook: payload had no recognisable company/domain field");
    return NextResponse.json({ ok: true, note: "no company field recognised" }, { status: 200 });
  }

  const visitId = extractVisitId(payload);
  const ip = extractIp(payload);

  if (ip) recordUnifyReveal(ip, company, visitId);

  const session = (visitId && getSession(visitId)) || (ip && findSessionByIp(ip, IP_CORRELATION_WINDOW_MS)) || undefined;

  if (session) {
    // Never clobber a presenter's manual override — everything else
    // (mock, reverse-ip-fallback, unresolved, or a stale unify hit) is
    // fair game to upgrade, since Unify is the primary source here.
    if (session.identify?.source === "manual") {
      console.log(`[t60] unify-webhook: visit=${session.visit.id} kept manual override, did not overwrite`);
      return NextResponse.json({ ok: true, resolved: false }, { status: 200 });
    }

    const identify: IdentifyResult = { company, source: "unify", confidence: 0.95, reason: "Resolved from a Unify Play webhook" };
    patchSession(session.visit.id, { identify, company });
    emitStep({ visitId: session.visit.id, step: "identify", status: "done", ms: 0, payload: { identify, sendWindow: session.sendWindow } });
    console.log(`[t60] unify-webhook: resolved visit=${session.visit.id} -> ${company.domain}`);
    return NextResponse.json({ ok: true, resolved: true, visitId: session.visit.id }, { status: 200 });
  }

  // No open session to correlate against — Unify saw a visit we never
  // tracked ourselves. Create one so it still shows up, and let the normal
  // pipeline run identify() (which will pick the reveal we just recorded).
  const visit: VisitEvent = {
    id: randomUUID(),
    ts: Date.now(),
    ip: ip ?? "unknown",
    userAgent: "unify-webhook",
    path: "(revealed via Unify)",
    dwellMs: 0,
  };
  createSession(visit);
  if (!ip) recordUnifyReveal("unknown", company, visit.id);
  void runPipeline(visit.id);

  console.log(`[t60] unify-webhook: created new visit=${visit.id} for unmatched reveal -> ${company.domain}`);
  return NextResponse.json({ ok: true, resolved: true, visitId: visit.id, created: true }, { status: 200 });
}
