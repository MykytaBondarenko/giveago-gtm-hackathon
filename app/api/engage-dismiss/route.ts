import { NextResponse } from "next/server";
import { z } from "zod";
import { markEngagementDismissed } from "@/lib/store";

export const runtime = "nodejs";

const DismissBody = z.object({
  visitId: z.string(),
});

// Persists the frequency cap: called when the visitor closes the banner, so
// it never reappears for this session, on this connection or a reconnect.
export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = DismissBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  markEngagementDismissed(parsed.data.visitId);
  return NextResponse.json({ ok: true });
}
