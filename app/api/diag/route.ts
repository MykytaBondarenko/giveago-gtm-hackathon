import { NextResponse } from "next/server";
import { agentSelfCheck } from "@/lib/agent";

export const runtime = "nodejs";

// Never return secret values here — booleans only. This route is linked
// from the dashboard header, so anything it returns is one click away from
// whoever is looking at the demo.
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "UNIFY_API_KEY",
  "UNIFY_PUBLIC_KEY",
  "UNIFY_WEBHOOK_SECRET",
  "IPINFO_TOKEN",
  "ALLOWED_RECIPIENTS",
] as const;

function envPresence(): Record<(typeof ENV_KEYS)[number], boolean> {
  const out = {} as Record<(typeof ENV_KEYS)[number], boolean>;
  for (const key of ENV_KEYS) out[key] = Boolean(process.env[key]);
  return out;
}

function mockFlags() {
  return {
    MOCK_IDENTIFY: process.env.MOCK_IDENTIFY === "1",
    MOCK_RESEARCH: process.env.MOCK_RESEARCH === "1",
    MOCK_UNIFY: process.env.MOCK_UNIFY === "1",
    DEMO_SAFE: process.env.DEMO_SAFE === "1",
    // Defaults "1" (dry-run) per AGENTS.md, so "active" means anything but an explicit "0".
    UNIFY_DRY_RUN: process.env.UNIFY_DRY_RUN !== "0",
    UNIFY_LIVE_WRITES: process.env.UNIFY_LIVE_WRITES === "1",
  };
}

export async function GET() {
  const agent = await agentSelfCheck();

  return NextResponse.json({
    env: envPresence(),
    mockFlags: mockFlags(),
    agent,
    // Real reachable/unauthorised/wrong-endpoint/network-error probe lands in Block 6.
    unify: {
      configured: Boolean(process.env.UNIFY_API_KEY),
      note: "Live connectivity probe not yet implemented.",
    },
  });
}
