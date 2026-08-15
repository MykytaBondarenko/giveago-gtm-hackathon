"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import companiesFixture from "@/fixtures/companies.json";
import type { LiveEngagement } from "@/lib/types";

declare global {
  interface Window {
    unify?: {
      page?: (properties?: Record<string, unknown>) => void;
      identify?: (email: string, traits?: Record<string, unknown>) => void;
    };
  }
}

type PresetCompany = { domain: string; name: string };

const PRESETS: PresetCompany[] = (companiesFixture as PresetCompany[]).map((c) => ({
  domain: c.domain,
  name: c.name,
}));

const FICTIONAL_LOGOS = ["Meridian Bank", "Ledgerly", "Fenwick Pay", "Vantage Financial", "Corebridge", "Northfield Capital"];

// --- Unify Intent Client (stub) --------------------------------------------
// Researched docs.unifygtm.com/developers/intent-client/website-tag and
// github.com/unifygtm/intent-js-client (10-minute time-box, per instructions).
// Findings:
//  - The <script> website tag is generated per-account from the Unify
//    dashboard and comes pre-loaded with the write key baked into its src —
//    there is no public, account-agnostic URL to hardcode here.
//  - The npm alternative is real, confirmed from the client's README:
//      import { UnifyIntentClient } from "@unifygtm/intent-client";
//      const unify = new UnifyIntentClient(writeKey, { autoPage: true, autoIdentify: false });
//      unify.mount();
//    (@unifygtm/intent-react also exists as a thin React wrapper.)
//  - identify(email, { person, company }) requires a person email as the
//    first argument. We don't collect one, and AGENTS.md is company-level
//    only (GDPR, Ireland DPC) — we would never call it even once installed.
//  - Neither package is in the approved dependency list (next, react,
//    tailwindcss, openai, zod — see AGENTS.md), so adding one needs a
//    separate ask. Left uninstalled for now.
// To activate: add the approved package, set NEXT_PUBLIC_UNIFY_PUBLIC_KEY,
// and replace the body of this function with the real mount() call above,
// then call `unify.page({ visitId })` for a company-safe custom trait
// instead of identify(). Our own /api/track call works completely
// independently of this either way.
function initUnifyIntentClient(visitId: string): void {
  const writeKey = process.env.NEXT_PUBLIC_UNIFY_PUBLIC_KEY;
  if (!writeKey) return;
  try {
    console.info("[t60] Unify Intent Client stub — see comment in app/demo/page.tsx", { visitId });
  } catch {
    // Non-fatal: our own /api/track path works regardless.
  }
}

async function postTrack(body: Record<string, unknown>): Promise<{ visitId: string } | null> {
  try {
    const res = await fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { visitId: string };
  } catch {
    return null;
  }
}

export default function DemoPage() {
  const [visitId, setVisitId] = useState<string | null>(null);
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    let currentVisitId: string | null = null;

    void (async () => {
      const result = await postTrack({ path: "/demo", userAgent: navigator.userAgent });
      if (cancelled || !result) return;
      currentVisitId = result.visitId;
      setVisitId(result.visitId);
      initUnifyIntentClient(result.visitId);
    })();

    const dwellTimer = setTimeout(() => {
      if (!cancelled && currentVisitId) {
        void postTrack({
          path: "/demo",
          userAgent: navigator.userAgent,
          visitId: currentVisitId,
          dwellMs: Date.now() - mountedAtRef.current,
        });
      }
    }, 15000);

    return () => {
      cancelled = true;
      clearTimeout(dwellTimer);
    };
  }, []);

  const simulateVisit = useCallback((domain: string) => {
    const trimmed = domain.trim();
    if (!trimmed) return;
    void postTrack({ path: "/demo", userAgent: navigator.userAgent, manualDomain: trimmed });
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Nav />
      <Hero />
      <TrustStrip />
      <Features />
      <Pricing />
      <CtaBand />
      <Footer onSimulate={simulateVisit} />
      <LiveBanner visitId={visitId} />
    </main>
  );
}

// The synchronous engagement surface: the one thing the sponsor stack can't
// do. Opens a per-visitor SSE connection and slides in the moment the
// pipeline's engage step fires — that instant is the whole pitch.
function LiveBanner({ visitId }: { visitId: string | null }) {
  const [engagement, setEngagement] = useState<LiveEngagement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visitId) return;

    const es = new EventSource(`/api/engage-stream?visitId=${encodeURIComponent(visitId)}`);
    es.addEventListener("engagement", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as LiveEngagement;
      setEngagement(data);
      // Let the off-screen position paint first, then animate on — collapsing
      // both states into one frame would skip the slide-in entirely.
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    });

    return () => es.close();
  }, [visitId]);

  const dismiss = useCallback(() => {
    setVisible(false);
    if (visitId) {
      void fetch("/api/engage-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId }),
      });
    }
  }, [visitId]);

  const handleCta = useCallback(() => {
    dismiss();
    document.getElementById("cta")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [dismiss]);

  if (!engagement) return null;

  return (
    <div
      aria-live="polite"
      className={`fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4 transition-transform duration-[250ms] ease-out ${
        visible ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900/95 p-4 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">{engagement.headline}</p>
            <p className="mt-1 text-sm text-slate-400">{engagement.line}</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded-full p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M4.293 4.293a1 1 0 0 1 1.414 0L10 8.586l4.293-4.293a1 1 0 1 1 1.414 1.414L11.414 10l4.293 4.293a1 1 0 0 1-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 0 1-1.414-1.414L8.586 10 4.293 5.707a1 1 0 0 1 0-1.414Z" />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={handleCta}
          className="mt-3 w-full rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-400"
        >
          {engagement.cta}
        </button>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500 text-sm font-bold text-white">
            N
          </span>
          <span className="text-base font-semibold tracking-tight text-white">Northwind</span>
        </div>
        <nav className="hidden items-center gap-8 text-sm text-slate-300 md:flex">
          <a href="#features" className="hover:text-white">
            Product
          </a>
          <a href="#pricing" className="hover:text-white">
            Pricing
          </a>
          <a href="#" className="hover:text-white">
            Docs
          </a>
        </nav>
        <a
          href="#cta"
          className="rounded-lg bg-blue-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-500/30 transition-colors hover:bg-blue-400 sm:px-4"
        >
          Book a demo
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-14 pb-16 sm:px-6 sm:pt-20 sm:pb-24 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center rounded-full border border-blue-400/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
          Observability for payments infrastructure
        </span>
        <h1 className="mt-6 text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
          Know the moment a payment fails
          <span className="text-blue-400"> — before your customer does.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base text-slate-400 sm:text-lg">
          Northwind gives payments and platform teams unified tracing, reconciliation-aware alerting, and one
          dashboard across every processor — so incidents get caught in minutes, not support tickets.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="#cta"
            className="w-full rounded-lg bg-blue-500 px-6 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-blue-500/30 transition-colors hover:bg-blue-400 sm:w-auto"
          >
            Book a demo
          </a>
          <a
            href="#features"
            className="w-full rounded-lg border border-white/10 px-6 py-3 text-center text-sm font-semibold text-slate-200 transition-colors hover:border-white/20 hover:bg-white/5 sm:w-auto"
          >
            See how it works
          </a>
        </div>
      </div>

      <ProductMockup />
    </section>
  );
}

function ProductMockup() {
  const rails = [
    { name: "Stripe", value: 82 },
    { name: "Adyen", value: 61 },
    { name: "Custom rail", value: 40 },
  ];

  return (
    <div className="mx-auto mt-14 max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-slate-900/80 shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
        <span className="ml-2 text-xs text-slate-400">Northwind — Live</span>
      </div>
      <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <MockMetric label="Payment success rate" value="99.982%" tone="emerald" />
        <MockMetric label="P50 settlement latency" value="128ms" tone="blue" />
        <MockMetric label="Open incidents" value="0" tone="slate" />
      </div>
      <div className="border-t border-white/10 p-5">
        <div className="mb-3 text-xs font-medium text-slate-400">Volume by rail — last 24h</div>
        <div className="flex items-end gap-4 sm:gap-6">
          {rails.map((rail) => (
            <div key={rail.name} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-24 w-full items-end rounded-md bg-white/5">
                <div
                  className="w-full rounded-md bg-gradient-to-t from-blue-500 to-blue-400"
                  style={{ height: `${rail.value}%` }}
                />
              </div>
              <span className="text-xs text-slate-400">{rail.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MockMetric({ label, value, tone }: { label: string; value: string; tone: "emerald" | "blue" | "slate" }) {
  const toneClass =
    tone === "emerald" ? "text-emerald-400" : tone === "blue" ? "text-blue-400" : "text-slate-200";
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function TrustStrip() {
  return (
    <section className="border-y border-white/5 bg-white/[0.02] py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <p className="text-center text-xs font-medium tracking-wide text-slate-500 uppercase">
          Trusted by payments and fintech teams at
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {FICTIONAL_LOGOS.map((name) => (
            <span key={name} className="text-sm font-semibold tracking-wide text-slate-500 sm:text-base">
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      title: "Unified tracing across every processor",
      description:
        "Follow a single transaction across Stripe, Adyen, and your own rails in one trace — no more stitching logs together by hand.",
      icon: <IconLayers />,
    },
    {
      title: "Reconciliation-aware alerting",
      description:
        "Alerts that understand ledger state, not just HTTP status codes, so you get paged for money that's actually stuck.",
      icon: <IconAlert />,
    },
    {
      title: "One dashboard, every rail",
      description:
        "A single pane of glass across acquirers, processors, and regions — built for the teams who own uptime, not just uptime metrics.",
      icon: <IconGrid />,
    },
  ];

  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Built for payments teams</h2>
        <p className="mt-4 text-slate-400">Everything you need to see, trust, and act on payments infrastructure.</p>
      </div>
      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
              {feature.icon}
            </div>
            <h3 className="mt-4 text-lg font-semibold text-white">{feature.title}</h3>
            <p className="mt-2 text-sm text-slate-400">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path d="M12 3 3 8l9 5 9-5-9-5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3 12l9 5 9-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3 16l9 5 9-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 10v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Pricing() {
  const tiers = [
    {
      name: "Starter",
      price: "$499",
      period: "/mo",
      description: "For teams standing up their first payments observability.",
      features: ["Up to 2 processors", "7-day trace retention", "Email alerting", "Community support"],
      highlighted: false,
    },
    {
      name: "Growth",
      price: "$1,999",
      period: "/mo",
      description: "For teams running payments infrastructure at scale.",
      features: [
        "Unlimited processors",
        "90-day trace retention",
        "Reconciliation-aware alerting",
        "Slack + PagerDuty integration",
        "Priority support",
      ],
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      description: "For global payments teams with custom SLAs.",
      features: ["Dedicated support engineer", "SSO + audit logs", "Custom data residency", "Uptime SLA"],
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Simple, transparent pricing</h2>
        <p className="mt-4 text-slate-400">Start small. Scale to every rail you run.</p>
      </div>
      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`relative flex flex-col rounded-2xl border p-6 ${
              tier.highlighted ? "border-blue-400/40 bg-blue-500/[0.06]" : "border-white/10 bg-white/[0.02]"
            }`}
          >
            {tier.highlighted && (
              <span className="absolute -top-3 left-6 rounded-full bg-blue-500 px-3 py-1 text-xs font-semibold text-white">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-semibold text-white">{tier.name}</h3>
            <div className="mt-3 flex items-baseline gap-1">
              <span className="text-3xl font-bold text-white">{tier.price}</span>
              <span className="text-sm text-slate-400">{tier.period}</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">{tier.description}</p>
            <ul className="mt-6 flex-1 space-y-2.5 text-sm text-slate-300">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-400" />
                  {feature}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
                tier.highlighted
                  ? "bg-blue-500 text-white hover:bg-blue-400"
                  : "border border-white/10 text-slate-200 hover:bg-white/5"
              }`}
            >
              Get started
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section id="cta" className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 sm:pb-24 lg:px-8">
      <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500/10 via-slate-900 to-slate-900 p-8 text-center sm:p-14">
        <p className="text-sm font-medium text-blue-300">&quot;Northwind cut our payments incident MTTR by 70%.&quot;</p>
        <p className="mt-2 text-xs text-slate-500">Priya Raman, Head of Platform Engineering, Fenwick Pay</p>
        <h2 className="mx-auto mt-6 max-w-xl text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Ready to see Northwind on your own payments data?
        </h2>
        <div className="mt-8">
          <button
            type="button"
            className="w-full rounded-lg bg-blue-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/30 transition-colors hover:bg-blue-400 sm:w-auto"
          >
            Book a demo
          </button>
        </div>
      </div>
    </section>
  );
}

function Footer({ onSimulate }: { onSimulate: (domain: string) => void }) {
  return (
    <footer className="border-t border-white/5 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500 text-xs font-bold text-white">
              N
            </span>
            <span className="text-sm font-semibold text-white">Northwind</span>
          </div>
          <div className="flex gap-6 text-xs text-slate-500">
            <span>Privacy</span>
            <span>Terms</span>
            <span>Security</span>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-slate-600 sm:text-left">
          © 2026 Northwind. Observability for payments infrastructure.
        </p>

        <DemoControl onSimulate={onSimulate} />
      </div>
    </footer>
  );
}

function DemoControl({ onSimulate }: { onSimulate: (domain: string) => void }) {
  const [value, setValue] = useState("");
  const [lastSimulated, setLastSimulated] = useState<string | null>(null);

  const submit = (domain: string) => {
    const trimmed = domain.trim();
    if (!trimmed) return;
    onSimulate(trimmed);
    setLastSimulated(trimmed);
    setValue("");
  };

  return (
    <div className="mt-10 rounded-xl border border-dashed border-amber-400/30 bg-amber-400/[0.04] p-4 sm:p-5">
      <p className="text-xs font-semibold text-amber-300">Demo control — simulate visiting from:</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="mt-3 flex flex-col gap-2 sm:flex-row"
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="company domain, e.g. stripe.com"
          className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-amber-400/50 focus:outline-none sm:flex-1"
        />
        <button
          type="submit"
          className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-400/20"
        >
          Simulate
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.domain}
            type="button"
            onClick={() => submit(preset.domain)}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-amber-400/40 hover:text-amber-200"
          >
            {preset.name}
          </button>
        ))}
      </div>
      {lastSimulated && (
        <p className="mt-3 text-xs text-slate-500">Simulated a new visit from &quot;{lastSimulated}&quot;.</p>
      )}
    </div>
  );
}
