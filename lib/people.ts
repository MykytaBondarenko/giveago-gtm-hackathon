import OpenAI from "openai";
import type { Company, IcpScore, Persona, Research } from "./types";

// ROLE selection, never person identification (GDPR — see AGENTS.md).

const WHY_TIMEOUT_MS = 5_000;

type PersonaContext = {
  company: Company;
  research: Research;
  score: IcpScore;
  path: string;
};

type PersonaChoice = Pick<Persona, "title" | "department">;

function textIncludes(research: Research, needle: string): boolean {
  const haystack = [research.summary, ...research.signals.map((s) => s.text)].join(" ").toLowerCase();
  return haystack.includes(needle);
}

// A small, ordered decision table — first match wins. Deterministic, and
// readable top to bottom, so the choice never surprises anyone on stage.
const PERSONA_RULES: { name: string; when: (ctx: PersonaContext) => boolean; persona: PersonaChoice }[] = [
  {
    name: "Hot lead evaluating pricing -> economic buyer",
    when: (ctx) => ctx.score.verdict === "hot" && ctx.path.toLowerCase().includes("pricing"),
    persona: { title: "CTO", department: "Executive" },
  },
  {
    name: "SRE/reliability hiring signal -> Director of SRE",
    when: (ctx) => textIncludes(ctx.research, "sre") || textIncludes(ctx.research, "site reliability"),
    persona: { title: "Director of SRE", department: "Site Reliability Engineering" },
  },
  {
    name: "Core payments/card-issuing industry -> Head of Payments",
    when: (ctx) => ["Payments Infrastructure", "Card Issuing Infrastructure"].includes(ctx.company.industry ?? ""),
    persona: { title: "Head of Payments", department: "Payments" },
  },
  {
    name: "Technical evaluation (docs) -> VP Engineering",
    when: (ctx) => ctx.path.toLowerCase().includes("docs"),
    persona: { title: "VP Engineering", department: "Engineering" },
  },
  {
    name: "Default -> VP Engineering",
    when: () => true,
    persona: { title: "VP Engineering", department: "Engineering" },
  },
];

function pickPersona(ctx: PersonaContext): PersonaChoice {
  const rule = PERSONA_RULES.find((r) => r.when(ctx));
  return rule!.persona;
}

// No MOCK_PERSONA flag exists in AGENTS.md — DEMO_SAFE is the umbrella that
// bypasses every external call, this one included.
function isDemoSafe(): boolean {
  return process.env.DEMO_SAFE === "1";
}

function templatedWhy(persona: PersonaChoice, ctx: PersonaContext): string {
  const signal = ctx.research.signals[0];
  const hook = signal ? signal.text : `their visit to ${ctx.path}`;
  return `${persona.title} is the right contact because ${hook.charAt(0).toLowerCase()}${hook.slice(1)} makes them the natural owner of this.`;
}

async function generateWhy(persona: PersonaChoice, ctx: PersonaContext): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || isDemoSafe()) return templatedWhy(persona, ctx);

  const signal = ctx.research.signals[0];
  const hook = signal ? `this specific fact: "${signal.text}"` : `their visit to the "${ctx.path}" page`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHY_TIMEOUT_MS);

  try {
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: WHY_TIMEOUT_MS });
    const response = await client.responses.create(
      {
        model: "gpt-4.1-mini",
        input: `Write ONE short sentence (max 25 words) explaining why the ${persona.title} at ${ctx.company.name} is the right person to contact, tied directly to ${hook}. Plain text only — no quotes, no markdown, no generic filler.`,
      },
      { signal: controller.signal, timeout: WHY_TIMEOUT_MS, maxRetries: 0 },
    );

    const text = response.output_text?.trim();
    console.log(`[t60] persona model-output domain=${ctx.company.domain} raw=${text}`);
    if (!text) throw new Error("empty response");
    return text;
  } catch {
    return templatedWhy(persona, ctx);
  } finally {
    clearTimeout(timeout);
  }
}

export async function choosePersona(
  company: Company,
  research: Research,
  score: IcpScore,
  path: string,
): Promise<Persona> {
  const ctx: PersonaContext = { company, research, score, path };
  const persona = pickPersona(ctx);
  const whyThisPerson = await generateWhy(persona, ctx);
  return { ...persona, whyThisPerson };
}
