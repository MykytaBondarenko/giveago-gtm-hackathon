import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, getSession, patchSession } from "@/lib/store";
import { runPipeline } from "@/lib/pipeline";
import type { VisitEvent } from "@/lib/types";

export const runtime = "nodejs";

const TrackBody = z.object({
  path: z.string(),
  userAgent: z.string(),
  visitId: z.string().optional(),
  dwellMs: z.number().optional(),
  manualDomain: z.string().optional(),
});

function extractIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  return realIp?.trim() || "unknown";
}

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = TrackBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const body = parsed.data;

  // A repeat POST carrying an existing visitId is a dwell update, not a new
  // session — it never re-triggers the pipeline.
  if (body.visitId) {
    const existing = getSession(body.visitId);
    if (existing) {
      patchSession(body.visitId, {
        visit: { ...existing.visit, dwellMs: body.dwellMs ?? existing.visit.dwellMs },
      });
      return NextResponse.json({ visitId: body.visitId }, { status: 202 });
    }
  }

  const visit: VisitEvent = {
    id: randomUUID(),
    ts: Date.now(),
    ip: extractIp(request),
    userAgent: body.userAgent,
    path: body.path,
    dwellMs: body.dwellMs ?? 0,
    manualDomain: body.manualDomain,
  };
  createSession(visit);

  const response = NextResponse.json({ visitId: visit.id }, { status: 202 });
  void runPipeline(visit.id);
  return response;
}
