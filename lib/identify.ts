import companiesFixture from "@/fixtures/companies.json";
import { peekUnifyReveal } from "./store";
import type { Company, IdentifyResult, VisitEvent } from "./types";

// Resolution order: manualDomain -> Unify (real source, push-based) ->
// IPinfo reverse-IP fallback -> unresolved. Never guess: any branch that
// can't back its answer with real data falls through to the next one.

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const COMPANIES = companiesFixture as Company[];

function toCompany(fixture: Company): Company {
  const { domain, name, employeeCount, industry, description, hqCountry } = fixture;
  return { domain, name, employeeCount, industry, description, hqCountry };
}

function findFixtureByDomain(domain: string): Company | undefined {
  const target = normalizeDomain(domain);
  const match = COMPANIES.find((c) => normalizeDomain(c.domain) === target);
  return match ? toCompany(match) : undefined;
}

function randomFixtureCompany(): Company {
  return toCompany(COMPANIES[Math.floor(Math.random() * COMPANIES.length)]);
}

// The presenter typed a domain we don't have a fixture for — build a
// minimal, honest record from the domain itself rather than refusing.
function constructMinimalCompany(rawDomain: string): Company {
  const domain = normalizeDomain(rawDomain);
  const label = domain.split(".")[0] ?? domain;
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return { domain, name };
}

function isMockMode(): boolean {
  return process.env.MOCK_IDENTIFY === "1" || process.env.DEMO_SAFE === "1";
}

// --- b. Unify -----------------------------------------------------------
// Unify's "revealed visitor" data only leaves their system via a Play's
// webhook action (docs.unifygtm.com/reference/plays/actions) — there's no
// documented synchronous "look this IP up now" REST endpoint, so this is a
// short bounded wait against reveals app/api/unify-webhook/route.ts has
// already recorded, not a request/response call of our own.
const UNIFY_WAIT_BUDGET_MS = 3000;
const UNIFY_WAIT_POLL_MS = 400;
const UNIFY_REVEAL_MAX_AGE_MS = 5 * 60_000;

async function tryUnify(visit: VisitEvent): Promise<Company | undefined> {
  const deadline = Date.now() + UNIFY_WAIT_BUDGET_MS;
  for (;;) {
    const revealed = peekUnifyReveal(visit.ip, UNIFY_REVEAL_MAX_AGE_MS);
    if (revealed) return revealed;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await wait(Math.min(UNIFY_WAIT_POLL_MS, remaining));
  }
}

// --- c. IPinfo reverse-IP fallback --------------------------------------

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^f[cd][0-9a-f]{2}:/i,
];

function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

// Keyword list from AGENTS.md's spec, extended with obvious siblings.
// Word-boundary matched so short tokens ("bt", "sky", "ee") don't false
// -positive inside unrelated names.
const CONSUMER_ISP_KEYWORDS = [
  "mobile",
  "telecom",
  "telecommunications",
  "broadband",
  "wireless",
  "cable",
  "fibre",
  "fiber",
  "cellular",
  "residential",
  "consumer",
  "dsl",
  "vodafone",
  "three",
  "eir",
  "virgin",
  "sky",
  "bt",
  "o2",
  "ee",
  "comcast",
  "xfinity",
  "spectrum",
  "verizon",
  "at&t",
  "att",
  "t-mobile",
  "tmobile",
  "orange",
  "telefonica",
  "telenor",
  "telia",
  "kpn",
  "rogers",
  "telus",
  "charter",
  "cox",
  "centurylink",
  "frontier",
  "starlink",
];

export function looksLikeConsumerIsp(orgName: string): boolean {
  const normalized = orgName.toLowerCase();
  return CONSUMER_ISP_KEYWORDS.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(normalized);
  });
}

type IpInfoResponse = {
  bogon?: boolean;
  org?: string;
  asn?: { name?: string; domain?: string; type?: string };
  company?: { name?: string; domain?: string; type?: string };
};

function guessDomainFromOrgName(name: string): string {
  const slug = name
    .replace(/\b(inc|llc|corp|corporation|ltd|limited|co|company|gmbh|plc)\b\.?/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return `${slug || "company"}.example`;
}

type IpinfoOutcome =
  | { company: Company; guessedDomain: boolean }
  | { company: undefined; reason: string };

async function tryIpinfo(ip: string): Promise<IpinfoOutcome> {
  const token = process.env.IPINFO_TOKEN;
  if (!token) return { company: undefined, reason: "IPinfo not configured" };
  if (isPrivateOrLocalIp(ip)) return { company: undefined, reason: "Private or local IP address" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${token}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { company: undefined, reason: `IPinfo responded ${res.status}` };
    const data = (await res.json()) as IpInfoResponse;
    if (data.bogon) return { company: undefined, reason: "Bogon/private IP per IPinfo" };

    const orgName = (data.company?.name ?? data.asn?.name ?? data.org ?? "").replace(/^AS\d+\s+/i, "").trim();
    if (!orgName) return { company: undefined, reason: "No organisation on record for this IP" };

    // Only IPinfo plans with ASN/Company add-ons return `type`. If it's
    // absent we can't confirm "business or hosting" — and per AGENTS.md we
    // never guess, so this correctly falls through to unresolved rather
    // than assuming corporate.
    const type = (data.asn?.type ?? data.company?.type ?? "").toLowerCase();
    if (type !== "business" && type !== "hosting") {
      return { company: undefined, reason: `ASN type "${type || "unknown"}" is not business or hosting` };
    }
    if (looksLikeConsumerIsp(orgName)) {
      return { company: undefined, reason: `"${orgName}" looks like a consumer ISP, not a company` };
    }

    const domain = data.company?.domain ?? data.asn?.domain;
    return {
      company: { domain: domain ?? guessDomainFromOrgName(orgName), name: orgName },
      guessedDomain: !domain,
    };
  } catch {
    return { company: undefined, reason: "IPinfo lookup failed or timed out" };
  } finally {
    clearTimeout(timeout);
  }
}

// --- entry point ----------------------------------------------------------

export async function identify(visit: VisitEvent): Promise<IdentifyResult> {
  // a. Presenter override always wins, mock mode or not.
  if (visit.manualDomain) {
    const fixture = findFixtureByDomain(visit.manualDomain);
    return fixture
      ? { company: fixture, source: "manual", confidence: 1, reason: "Presenter-selected demo company" }
      : {
          company: constructMinimalCompany(visit.manualDomain),
          source: "manual",
          confidence: 0.8,
          reason: "Presenter-typed domain not in fixtures; constructed a minimal company record",
        };
  }

  // A reveal Unify already delivered (via the webhook, possibly just ahead
  // of this call) costs nothing to check and is real data, not an external
  // call — so it wins even in mock mode. Only the *wait* for one arriving
  // later is skipped when mocking, to keep demo-safe mode fast.
  const immediateReveal = peekUnifyReveal(visit.ip, UNIFY_REVEAL_MAX_AGE_MS);
  if (immediateReveal) {
    return { company: immediateReveal, source: "unify", confidence: 0.95, reason: "Resolved from a Unify Play webhook" };
  }

  if (isMockMode()) {
    return {
      company: randomFixtureCompany(),
      source: "mock",
      confidence: 0.6,
      reason: "MOCK_IDENTIFY/DEMO_SAFE enabled — external identification bypassed",
    };
  }

  // b. Unify — the real source, and the point of the project.
  const unifyCompany = await tryUnify(visit);
  if (unifyCompany) {
    return { company: unifyCompany, source: "unify", confidence: 0.95, reason: "Resolved from a Unify Play webhook" };
  }

  // c. IPinfo reverse-IP fallback.
  const ipinfo = await tryIpinfo(visit.ip);
  if (ipinfo.company) {
    return {
      company: ipinfo.company,
      source: "reverse-ip-fallback",
      confidence: ipinfo.guessedDomain ? 0.5 : 0.75,
      reason: ipinfo.guessedDomain
        ? "Resolved via IPinfo reverse-IP lookup; domain inferred from org name, not confirmed"
        : "Resolved via IPinfo reverse-IP lookup",
    };
  }

  // d. Never guess.
  return { company: undefined, source: "unresolved", confidence: 0, reason: ipinfo.reason };
}
