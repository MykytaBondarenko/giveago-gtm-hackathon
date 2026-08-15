import type { Company, IcpScore, Persona, Research } from "./types";

// ROLE selection, never person identification (GDPR — see AGENTS.md).
//
// This is the deterministic fallback path only. The primary path is the
// analyst agent (lib/score.ts's scoreAndAdvise()), which proposes
// personaTitle/personaDepartment/whyThisPerson as part of the same call
// that scores the company — no separate AI call here anymore. This file's
// PERSONA_RULES table is what the pipeline falls back to when that agent
// call is unavailable or fails validation.

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

function templatedWhy(persona: PersonaChoice, ctx: PersonaContext): string {
  // Prefer the same signal the Signals panel calls "the hook" (score.topSignal)
  // so the explanation points at the same fact everywhere in the UI.
  const signal = ctx.research.signals[ctx.score.topSignal ?? 0];
  const hook = signal ? signal.text : `their visit to ${ctx.path}`;
  return `${persona.title} is the right contact because ${hook.charAt(0).toLowerCase()}${hook.slice(1)} makes them the natural owner of this.`;
}

export function choosePersonaRules(company: Company, research: Research, score: IcpScore, path: string): Persona {
  const ctx: PersonaContext = { company, research, score, path };
  const persona = pickPersona(ctx);
  return { ...persona, whyThisPerson: templatedWhy(persona, ctx) };
}
