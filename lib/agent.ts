import OpenAI from "openai";
import type { z } from "zod";

// THE single place the model is called. lib/research.ts, lib/people.ts,
// lib/compose.ts all route through runAgent() — no bespoke OpenAI client
// construction anywhere else in lib/. That's what makes every call
// uniformly logged and makes AgentError a single type callers can check for.

const MODEL = "gpt-4.1-mini";

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly agentName: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface RunAgentOptions<T> {
  name: string;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  webSearch?: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RawAttempt = { raw: string; usedTools: boolean };

async function requestOnce(opts: RunAgentOptions<unknown>, apiKey: string, retryReason?: string): Promise<RawAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  const input = retryReason
    ? `${opts.input}\n\nYour previous attempt was rejected for this reason: ${retryReason}\nFix this exactly and return valid JSON only, matching the required shape precisely.`
    : opts.input;

  try {
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: opts.timeoutMs });
    const response = await client.responses.create(
      {
        model: MODEL,
        instructions: opts.instructions,
        input,
        ...(opts.webSearch ? { tools: [{ type: "web_search_preview", search_context_size: "low" }] } : {}),
      },
      { signal: controller.signal, timeout: opts.timeoutMs, maxRetries: 0 },
    );

    // The Responses API includes an item per tool invocation in `output`
    // (e.g. type "web_search_call") when the model actually used one — best
    // -effort check, defensive since the exact shape isn't pinned by our
    // installed SDK's types.
    let usedTools = false;
    try {
      const output = (response as unknown as { output?: { type?: string }[] }).output;
      usedTools = Array.isArray(output) && output.some((item) => typeof item?.type === "string" && item.type.includes("search"));
    } catch {
      usedTools = false;
    }

    return { raw: response.output_text ?? "", usedTools };
  } finally {
    clearTimeout(timeout);
  }
}

// Duck-types a `sources`/`signals` array off whatever the schema produced,
// purely for the log line — this has no bearing on validation.
function countSources(data: unknown): number | "n/a" {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.sources)) return obj.sources.length;
    if (Array.isArray(obj.signals)) return obj.signals.length;
  }
  return "n/a";
}

function logAttempt(name: string, attemptNum: number, start: number, usedTools: boolean, data: unknown, raw: string): void {
  console.log(
    `[t60] agent=${name} attempt=${attemptNum} ms=${Date.now() - start} tools=${usedTools} sources=${countSources(data)} raw="${raw.slice(0, 200).replace(/\s+/g, " ")}"`,
  );
}

// Calls the model, validates the response against `schema`, retries once
// with a stricter reminder on invalid JSON, then throws AgentError. Callers
// decide what to do on failure (typically: fall back to fixture/rules data)
// — this function's only job is "get a validated T, or say clearly why not."
export async function runAgent<T>(opts: RunAgentOptions<T>): Promise<T> {
  const start = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(`[t60] agent=${opts.name} FAILED — OPENAI_API_KEY is not configured`);
    throw new AgentError("OPENAI_API_KEY is not configured", opts.name);
  }

  let lastReason: string | undefined;

  for (let attemptNum = 1; attemptNum <= 2; attemptNum++) {
    let raw: string;
    let usedTools: boolean;
    try {
      const result = await requestOnce(opts, apiKey, lastReason);
      raw = result.raw;
      usedTools = result.usedTools;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[t60] agent=${opts.name} attempt=${attemptNum} request failed after ${Date.now() - start}ms: ${message}`);
      if (attemptNum === 2) throw new AgentError(message, opts.name);
      lastReason = message;
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      logAttempt(opts.name, attemptNum, start, usedTools, undefined, raw);
      const reason = "Response was not valid JSON.";
      console.warn(`[t60] agent=${opts.name} attempt=${attemptNum} invalid: ${reason}`);
      if (attemptNum === 2) throw new AgentError(reason, opts.name);
      lastReason = reason;
      continue;
    }

    const result = opts.schema.safeParse(parsedJson);
    if (result.success) {
      logAttempt(opts.name, attemptNum, start, usedTools, result.data, raw);
      return result.data;
    }

    logAttempt(opts.name, attemptNum, start, usedTools, undefined, raw);
    const reason = `JSON did not match the expected shape: ${result.error.message}`;
    console.warn(`[t60] agent=${opts.name} attempt=${attemptNum} invalid: ${reason}`);
    if (attemptNum === 2) throw new AgentError(reason, opts.name);
    lastReason = reason;
  }

  // Unreachable — the loop always returns or throws — but keeps TS happy.
  throw new AgentError("Exhausted retries", opts.name);
}

export interface AgentSelfCheckResult {
  ok: boolean;
  message: string;
  ms?: number;
}

// "I need to know within seconds of starting whether the key works, not at
// demo time." Called once from instrumentation.ts on boot, and again on
// demand from /api/diag so the presenter can re-check live.
export async function agentSelfCheck(): Promise<AgentSelfCheckResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const result = { ok: false, message: "OPENAI_API_KEY is not configured" };
    console.error(`AGENT UNAVAILABLE — ${result.message}`);
    return result;
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 8000 });
    const response = await client.responses.create(
      { model: MODEL, input: 'Reply with exactly the word "OK" and nothing else.' },
      { signal: controller.signal, timeout: 8000, maxRetries: 0 },
    );
    clearTimeout(timeout);
    const ms = Date.now() - start;
    const text = response.output_text?.trim();
    console.log(`AGENT OK — model responding (${ms}ms)`);
    return { ok: true, message: `model responding, replied "${text}"`, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`AGENT UNAVAILABLE — ${message}`);
    return { ok: false, message, ms: Date.now() - start };
  }
}

export { wait };
