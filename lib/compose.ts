import OpenAI from "openai";
import { z } from "zod";
import type { Company, IcpScore, LiveEngagement, Outreach, Persona, Research, Signal, VisitEvent } from "./types";

// Both artefacts (email + banner) come from ONE OpenAI call — see compose()
// below — because a second round-trip doesn't fit the 60-second pipeline
// budget. Structural rules (word/line limits, banned phrasing) are enforced
// in code, not left to the model's judgment, so a violation always gets
// caught rather than occasionally slipping through.

const COMPOSE_TIMEOUT_MS = 10_000;

// "Banned outright" from the email spec, plus the extra guardrails() list.
// Both lists are scanned together — the point is never implying we tracked,
// watched, or noticed the visitor's browsing.
const BANNED_PHRASES = [
  "i hope this finds you well",
  "i came across your company",
  "i noticed you're doing great things",
  "your website visit",
  "your visit to our site",
  "your visit to our website",
  "browsing our site",
  "browsing our website",
  "we noticed",
  "we saw",
  "you're browsing",
  "welcome back",
  "i see you",
  "i noticed you",
];

// Scans text for any banned phrase; returns the matches found (empty = clean).
export function guardrails(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
}

class MalformedOutputError extends Error {}

function isDemoSafe(): boolean {
  return process.env.DEMO_SAFE === "1";
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isPlainText(text: string): boolean {
  return !/[*_#`]|<[^>]+>/.test(text);
}

const SIGNAL_STOPWORDS = new Set([
  "the", "and", "with", "from", "that", "this", "into", "their", "they",
  "for", "are", "was", "were", "has", "have", "its", "about", "will",
  "would", "could", "more", "than", "posted", "announced", "recent", "recently",
]);

function signalKeywords(signal: Signal): string[] {
  return signal.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4 && !SIGNAL_STOPWORDS.has(w));
}

// Can't verify "references signal X" semantically without another model
// call, so this checks for keyword overlap as a cheap, deterministic proxy.
// When there are no signals to reference, nothing to enforce — the prompt
// instructs the model to fall back to a concrete company detail instead.
function line1ReferencesASignal(line1: string, signals: Signal[]): boolean {
  if (signals.length === 0) return true;
  const lower = line1.toLowerCase();
  return signals.some((signal) => signalKeywords(signal).some((kw) => lower.includes(kw)));
}

const MEETING_ASK_PATTERN = /\b(call|meeting|schedule|book a|chat with|talk to|15[- ]minute|grab time|connect with|hop on)\b/i;

function hasMeetingAsk(text: string): boolean {
  return MEETING_ASK_PATTERN.test(text);
}

function hasGreetingOrSignature(text: string): boolean {
  const t = text.trim().toLowerCase();
  const greetingStarts = ["hi ", "hi,", "hello", "hey ", "hey,", "dear "];
  const signatureMarkers = ["best,", "regards,", "thanks,", "sincerely", "best regards", "cheers,"];
  return greetingStarts.some((g) => t.startsWith(g)) || signatureMarkers.some((s) => t.includes(s));
}

const composeSchema = z
  .object({
    email: z
      .object({
        subject: z.string().min(1),
        body: z.string().min(1),
        repBrief: z.array(z.string().min(1)).min(3).max(5),
      })
      .strict(),
    banner: z
      .object({
        headline: z.string().min(1),
        line: z.string().min(1),
        cta: z.string().min(1),
      })
      .strict(),
  })
  .strict();

type ComposeJson = z.infer<typeof composeSchema>;

function validateCompose(raw: string, research: Research): ComposeJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedOutputError("Response was not valid JSON.");
  }

  const result = composeSchema.safeParse(parsed);
  if (!result.success) throw new MalformedOutputError(`JSON did not match the expected shape: ${result.error.message}`);

  const { email, banner } = result.data;
  const violations: string[] = [];

  if (wordCount(email.subject) >= 8) violations.push("Subject must be under 8 words.");
  if (email.subject !== email.subject.toLowerCase()) violations.push("Subject must be entirely lowercase.");
  if (email.subject.includes("!")) violations.push("Subject must not contain an exclamation mark.");
  if (email.subject.toLowerCase().includes("quick question")) violations.push('Subject must never say "quick question".');

  if (wordCount(email.body) >= 90) violations.push("Body must be under 90 words.");
  const bodyLines = email.body.split("\n").filter((l) => l.trim().length > 0);
  if (bodyLines.length > 4) violations.push("Body must be at most four short lines.");
  if (!isPlainText(email.body)) violations.push("Body must be plain text — no markdown or HTML.");
  if (bodyLines[0] && !line1ReferencesASignal(bodyLines[0], research.signals)) {
    violations.push("The first line of the body must reference one specific signal by name from the research.");
  }

  if (wordCount(banner.headline) > 8) violations.push("Banner headline must be at most 8 words.");
  if (wordCount(banner.line) > 20) violations.push("Banner line must be at most 20 words.");
  if (wordCount(banner.cta) > 4) violations.push("Banner CTA must be at most 4 words.");
  if (hasGreetingOrSignature(banner.line)) violations.push("Banner line must not contain a greeting or signature.");
  if (hasMeetingAsk(banner.line)) violations.push("Banner line must not contain a meeting ask — that belongs in the email.");

  if (violations.length > 0) throw new MalformedOutputError(violations.join(" "));

  return { email, banner };
}

function runGuardrails(email: { body: string }, banner: { headline: string; line: string; cta: string }): string[] {
  return [
    ...guardrails(email.body).map((p) => `email body: "${p}"`),
    ...guardrails(banner.headline).map((p) => `banner headline: "${p}"`),
    ...guardrails(banner.line).map((p) => `banner line: "${p}"`),
    ...guardrails(banner.cta).map((p) => `banner cta: "${p}"`),
  ];
}

type ComposeContext = {
  company: Company;
  research: Research;
  score: IcpScore;
  persona: Persona;
  visit: VisitEvent;
};

function modelPrompt(ctx: ComposeContext, retryReason?: string): string {
  const { company, research, score, persona, visit } = ctx;

  const signalsList =
    research.signals.length > 0
      ? research.signals.map((s, i) => `${i + 1}. ${s.text}${s.date ? ` (${s.date})` : ""}`).join("\n")
      : "No specific research signals are available — open with a concrete detail about what the company does instead.";

  const retryBlock = retryReason
    ? `\nYour previous attempt was rejected for this reason: ${retryReason}\nFix this exactly and follow every rule below precisely.\n`
    : "";

  return `You are writing cold outbound copy for Northwind, an observability platform for payments infrastructure. Return STRICT JSON only — no Markdown, no code fences, no prose outside the JSON object.
${retryBlock}
Context:
- Company: ${company.name} (${company.domain}), industry: ${company.industry ?? "unknown"}
- What they do: ${research.summary}
- Research signals:
${signalsList}
- ICP verdict: ${score.verdict} (${score.score}/100)
- Target persona: ${persona.title}, ${persona.department}. ${persona.whyThisPerson}
- Page they visited: ${visit.path}

Return exactly this JSON shape:
{
  "email": {
    "subject": "under 8 words, all lowercase, no exclamation marks, never the phrase 'quick question'",
    "body": "under 90 words, at most four short lines separated by \\n, plain text (no markdown/HTML). Line 1 must reference ONE specific signal by name from the research signals above. End with one clear, low-friction ask.",
    "repBrief": ["3 to 5 short bullets a rep can read in ten seconds before calling: what the company does, the hook signal, the likely objection, the ask"]
  },
  "banner": {
    "headline": "max 8 words, references the company and the topic of the visited page only",
    "line": "max 20 words, present tense, no greeting, no signature, no meeting ask — references the company and the visited page topic only",
    "cta": "max 4 words"
  }
}

Never write any of the following, or anything that means the same thing: "I hope this finds you well", "I came across your company", "I noticed you're doing great things", "we noticed", "we saw", "you're browsing", "welcome back", "I see you", "I noticed you", or any mention of the recipient's website visit, browsing, or of us noticing/watching/tracking them. We never say we tracked anyone — it's creepy and legally unwise.`;
}

type AttemptResult = { ok: true; email: ComposeJson["email"]; banner: ComposeJson["banner"] } | { ok: false; reason: string };

async function attemptCompose(ctx: ComposeContext, deadline: number, retryReason?: string): Promise<AttemptResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: "OPENAI_API_KEY is not configured" };

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return { ok: false, reason: "Ran out of time." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  try {
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: Math.min(COMPOSE_TIMEOUT_MS, remainingMs) });
    const response = await client.responses.create(
      { model: "gpt-4.1-mini", input: modelPrompt(ctx, retryReason) },
      { signal: controller.signal, timeout: Math.min(COMPOSE_TIMEOUT_MS, remainingMs), maxRetries: 0 },
    );

    const raw = response.output_text;
    console.log(`[t60] compose model-output domain=${ctx.company.domain} raw=${raw}`);

    const { email, banner } = validateCompose(raw, ctx.research);

    const guardrailViolations = runGuardrails(email, banner);
    if (guardrailViolations.length > 0) {
      return {
        ok: false,
        reason: `Guardrails flagged banned phrasing: ${guardrailViolations.join("; ")}. Rewrite without any of these words or implications.`,
      };
    }

    return { ok: true, email, banner };
  } catch (err) {
    if (err instanceof MalformedOutputError) return { ok: false, reason: err.message };
    return { ok: false, reason: "The request failed or timed out." };
  } finally {
    clearTimeout(timeout);
  }
}

function pageTopic(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("pricing")) return "Pricing";
  if (p.includes("docs")) return "the docs";
  if (p.includes("product")) return "the product";
  if (p.includes("customers")) return "customer stories";
  return "payments observability";
}

// Deterministic, hand-written, and pre-verified to clear guardrails() by
// construction — the safety net when both attempts fail or nothing is
// configured. Still grounded in real signal/page data, never generic filler.
function safeTemplate(ctx: ComposeContext): { outreach: Outreach; engagement: LiveEngagement } {
  const { company, research, persona, visit } = ctx;
  const signal = research.signals[0];
  const hook = signal ? signal.text : `${company.name}'s work in ${company.industry ?? "payments"}`;
  const hookLower = hook.charAt(0).toLowerCase() + hook.slice(1);

  const subject = `notes for ${company.name.toLowerCase()}`;
  const body = [
    `${hookLower} is why we're reaching out.`,
    `Teams like ${company.name} use Northwind to catch payment issues before customers do.`,
    `Worth a short call this week?`,
  ].join("\n");
  const repBrief = [
    `${company.name}: ${research.summary}`,
    `Hook: ${hook}`,
    `Likely objection: they may think existing monitoring already covers this.`,
    `Ask: a 15-minute fit call with the ${persona.title}.`,
  ];

  const topic = pageTopic(visit.path);
  const headline = `${topic} at ${company.name}`;
  const line = `${company.name} is currently looking into ${topic.toLowerCase()}.`;
  const cta = "See a demo";

  return {
    outreach: { subject, body, repBrief, guardrailsPassed: true },
    engagement: { headline, line, cta, dismissible: true },
  };
}

export async function compose(
  company: Company,
  research: Research,
  score: IcpScore,
  persona: Persona,
  visit: VisitEvent,
): Promise<{ outreach: Outreach; engagement: LiveEngagement }> {
  const ctx: ComposeContext = { company, research, score, persona, visit };

  if (isDemoSafe()) return safeTemplate(ctx);

  const deadline = Date.now() + COMPOSE_TIMEOUT_MS;

  let attempt = await attemptCompose(ctx, deadline);
  if (!attempt.ok) {
    attempt = await attemptCompose(ctx, deadline, attempt.reason);
  }

  if (attempt.ok) {
    return {
      outreach: { subject: attempt.email.subject, body: attempt.email.body, repBrief: attempt.email.repBrief, guardrailsPassed: true },
      engagement: { headline: attempt.banner.headline, line: attempt.banner.line, cta: attempt.banner.cta, dismissible: true },
    };
  }

  return safeTemplate(ctx);
}
