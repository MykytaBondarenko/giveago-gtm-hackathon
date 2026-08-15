import { getSession, subscribe } from "@/lib/store";
import type { LiveEngagement, StepEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Scoped to one visitor: the query param, not a broadcast. This is what
// LiveBanner on /demo connects to, and it's what makes the banner appear on
// that one screen the instant the pipeline's engage step completes.
export async function GET(request: Request) {
  const visitId = new URL(request.url).searchParams.get("visitId");
  if (!visitId) {
    return new Response("visitId query parameter is required", { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let pingInterval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Reconnect after the engage step already completed (e.g. a page
      // reload) — deliver what's already there, unless it was dismissed.
      const session = getSession(visitId);
      if (session?.engagement && !session.engagementDismissedAt) {
        controller.enqueue(encoder.encode(sseMessage("engagement", session.engagement)));
      }

      unsubscribe = subscribe((event: StepEvent) => {
        if (event.visitId !== visitId || event.step !== "engage" || event.status !== "done") return;
        if (getSession(visitId)?.engagementDismissedAt) return;

        const payload = event.payload as { engagement: LiveEngagement } | undefined;
        if (payload?.engagement) {
          controller.enqueue(encoder.encode(sseMessage("engagement", payload.engagement)));
        }
      });

      pingInterval = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);
    },
    cancel() {
      unsubscribe();
      if (pingInterval) clearInterval(pingInterval);
    },
  });

  request.signal.addEventListener("abort", () => {
    unsubscribe();
    if (pingInterval) clearInterval(pingInterval);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
