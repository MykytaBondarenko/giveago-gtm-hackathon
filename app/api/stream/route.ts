import { listSessions, subscribe } from "@/lib/store";
import { startDemoLoop } from "@/lib/pipeline";
import type { StepEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  // Demo-only: self-generates mock visits so the dashboard has something to
  // stream even without a real /api/track integration wired up yet.
  startDemoLoop();

  const encoder = new TextEncoder();

  let unsubscribe: () => void = () => {};
  let pingInterval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage("snapshot", listSessions())));

      unsubscribe = subscribe((event: StepEvent) => {
        controller.enqueue(encoder.encode(sseMessage("step", event)));
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
