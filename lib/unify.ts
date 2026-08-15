import type { Company, Session, UnifyOperationResult, UnifyPushResult } from "./types";

// Investigated docs.unifygtm.com/developers/sdks/typescript-library: an
// official SDK exists (`npm install @unifygtm/sdk`, reads UNIFY_API_KEY by
// default), but its method signatures for tasks/sequences aren't shown in
// the docs and AGENTS.md's dependency list doesn't include it. By the time
// that was clear, the REST shape for all three operations below was already
// fully verified against the real docs — upsert
// (developers/api/data/records/upsert), tasks (developers/api/tasks/create),
// and sequences (developers/api/sequences/{sequences/list,enrollments/create})
// — so this goes straight to raw fetch rather than spend the 20-minute
// budget guessing at SDK method names. Every endpoint below uses the same
// `x-api-key` header, confirmed directly against the docs (not Bearer).

const UNIFY_API_BASE = "https://api.unifygtm.com";
const UNIFY_TIMEOUT_MS = 6_000;
const MOCK_DELAY_MS = 400;

// Unify's Tasks and Sequences APIs are person-scoped (both require a
// person_id — there is no company-level equivalent). AGENTS.md is
// company-level only (GDPR, Ireland DPC): we never resolve or invent an
// individual, so person_id is deliberately omitted rather than faked. In a
// live, non-dry-run call this is what Unify would need to fill in once it
// resolves a contact on its own.
const PERSON_ID_NOTE =
  "person_id intentionally omitted — company-level identification only (GDPR); Unify resolves the contact.";

// Stands in for the sending mailbox a real integration would have
// connected. Checked against ALLOWED_RECIPIENTS same as any other address
// this payload would send through — if it's not allow-listed, dry-run wins.
const PLACEHOLDER_MAILBOX = "demo@northwind.example";

type Mode = UnifyPushResult["mode"];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMockMode(): boolean {
  return process.env.MOCK_UNIFY === "1" || process.env.DEMO_SAFE === "1" || !process.env.UNIFY_API_KEY;
}

function isDryRunFlag(): boolean {
  const flag = process.env.UNIFY_DRY_RUN;
  return flag === undefined || flag === "1";
}

function allowedRecipients(): string[] {
  return (process.env.ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// No cold emails leave a hackathon laptop: any address outside the
// allowlist forces dry-run regardless of UNIFY_DRY_RUN.
function resolveMode(): Mode {
  if (isMockMode()) return "mock";
  if (isDryRunFlag()) return "dry-run";
  if (!allowedRecipients().includes(PLACEHOLDER_MAILBOX.toLowerCase())) return "dry-run";
  return "live";
}

async function unifyRequest<T = unknown>(path: string, init: RequestInit, apiKey: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${UNIFY_API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Unify ${path} responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// Runs one write-back operation: builds its payload, logs it, and either
// simulates it, logs-only (dry-run), or actually sends it — never throwing,
// so one operation failing can't take the other two down with it.
async function runOperation(
  name: string,
  mode: Mode,
  buildPayload: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  send: (payload: Record<string, unknown>, apiKey: string) => Promise<unknown>,
): Promise<UnifyOperationResult> {
  let payload: Record<string, unknown>;
  try {
    payload = await buildPayload();
  } catch (err) {
    return { payload: {}, status: "error", error: `Failed to build payload: ${err instanceof Error ? err.message : "unknown error"}` };
  }

  console.log(`[t60] unify ${name} mode=${mode} payload=${JSON.stringify(payload)}`);

  if (mode === "mock") {
    await wait(MOCK_DELAY_MS);
    return { payload, status: "simulated" };
  }
  if (mode === "dry-run") {
    return { payload, status: "dry-run" };
  }

  try {
    const apiKey = process.env.UNIFY_API_KEY!;
    const response = await send(payload, apiKey);
    return { payload, status: "sent", response };
  } catch (err) {
    return { payload, status: "error", error: err instanceof Error ? err.message : "unknown error" };
  }
}

function buildUpsertPayload(session: Session, company: Company): Record<string, unknown> {
  const topSignalIndex = session.score?.topSignal ?? 0;
  const attrs = {
    icp_score: session.score?.score ?? null,
    verdict: session.score?.verdict ?? null,
    top_signal: session.research?.signals[topSignalIndex]?.text ?? null,
    identify_source: session.identify?.source ?? null,
    engaged_at_ms: session.engagedAtMs ?? null,
    detected_at: new Date(session.visit.ts).toISOString(),
  };

  return {
    match: { domain: company.domain },
    create: { domain: company.domain, name: company.name, ...attrs },
    update: attrs,
  };
}

function buildTaskPayload(session: Session): Record<string, unknown> {
  const priority = session.score?.verdict === "hot" ? "URGENT" : session.score?.verdict === "warm" ? "HIGH" : "MEDIUM";
  return {
    type: "ACTION_ITEM",
    person_id: null,
    _note: PERSON_ID_NOTE,
    priority,
    note_content: (session.outreach?.repBrief ?? []).join("\n"),
  };
}

async function resolveSequenceId(apiKey: string): Promise<string | undefined> {
  const configured = process.env.UNIFY_SEQUENCE_ID;
  if (configured) return configured;
  const data = await unifyRequest<{ sequences: { id: string }[] }>("/sequences/v1/sequences?limit=1", { method: "GET" }, apiKey);
  return data.sequences[0]?.id;
}

// Listing is a read, safe even in dry-run — it just makes the demonstrated
// payload show a real sequence_id instead of null.
async function buildEnrollmentPayload(mode: Mode): Promise<Record<string, unknown>> {
  let sequenceId = process.env.UNIFY_SEQUENCE_ID;
  const apiKey = process.env.UNIFY_API_KEY;
  if (!sequenceId && mode !== "mock" && apiKey) {
    try {
      sequenceId = await resolveSequenceId(apiKey);
    } catch {
      // Best-effort — payload just shows no sequence_id if the list call fails.
    }
  }

  return {
    sequence_id: sequenceId ?? null,
    person_id: null,
    _note: PERSON_ID_NOTE,
    mailbox_emails: [PLACEHOLDER_MAILBOX],
  };
}

// Writes the visit back into Unify: an upserted company record, a task for
// the rep, and a sequence enrollment payload. Dry-run by default (AGENTS.md)
// — this builds and logs the exact payloads without executing unless
// UNIFY_DRY_RUN="0" AND every address involved is allow-listed.
export async function pushToUnify(session: Session): Promise<UnifyPushResult> {
  const company = session.company;
  const mode = resolveMode();

  if (!company) {
    return { mode, skipped: true, reason: "No company identified for this visit — nothing to write back." };
  }

  const [companyResult, taskResult, sequenceResult] = await Promise.all([
    runOperation(
      "company-upsert",
      mode,
      () => buildUpsertPayload(session, company),
      (payload, apiKey) =>
        unifyRequest("/data/v1/objects/company/records/upsert", { method: "POST", body: JSON.stringify(payload) }, apiKey),
    ),
    runOperation(
      "rep-task",
      mode,
      () => buildTaskPayload(session),
      (payload, apiKey) => unifyRequest("/tasks/v1/tasks", { method: "POST", body: JSON.stringify(payload) }, apiKey),
    ),
    runOperation(
      "sequence-enrollment",
      mode,
      () => buildEnrollmentPayload(mode),
      (payload, apiKey) => unifyRequest("/sequences/v1/enrollments", { method: "POST", body: JSON.stringify(payload) }, apiKey),
    ),
  ]);

  return { mode, company: companyResult, task: taskResult, sequence: sequenceResult };
}
