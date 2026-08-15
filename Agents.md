# T60 — Real-time inbound response agent

## What this is
A hackathon MVP built in 4 hours. Unify detects a website visitor in real time.
Our agent then does, within ~60 seconds: research the company, score ICP fit,
pick the target persona, draft outreach, AND — the part nothing in the sponsor
stack does — put a live, personalised message on the visitor's own screen while
they are still browsing. Everything is written back into Unify.

## The gap we fill (verified — do not overstate)
Unify identifies website visitors in real time and fires Plays "as soon as
someone enters an audience". What Unify does NOT have:
  (a) any synchronous on-site engagement surface — no live chat, no banner, no
      live-visitor room. The model is detect -> enrich -> email/sequence/task/
      Slack alert only.
  (b) sub-minute outbound. Sending is throttled for deliverability: allowed
      send window 9:00-16:00 America/Los_Angeles, roughly 25 emails per mailbox
      per day, sends staggered about 2-6 minutes apart, queued until the mailbox
      has capacity inside an allowed window.
The honest claim is: "Unify sees the visitor instantly; the response still lands
in a send queue. We close that window."
NEVER claim "Unify has no real-time engine" — that is false and a mentor will
correct it on stage.

## Non-negotiables
- Stack: Next.js 15 App Router, TypeScript strict, Tailwind. In-memory store
  only. No database, no auth, no ORM.
- Unify is the SOURCE, not just the sink. Identification comes from Unify where
  possible; we write results back to Unify at the end.
- Every pipeline step is independently mockable via env flags. The demo must
  NEVER hard-fail: on any error, fall back to fixture data and keep going.
- Never block /api/track on the pipeline. Return 202 instantly, run async.
- COMPANY-level only. We never identify an individual person. Personas are
  selected by ROLE. This is a GDPR requirement (Ireland, DPC), not a taste.
- The on-site banner must be dismissible and must never say or imply that we
  tracked, followed, watched, or recognised the visitor.
- No real emails to third parties. Dry-run by default.
- Dependencies allowed: next, react, tailwindcss, openai, zod. Nothing else
  without asking me first.

## Pipeline steps (in order)
identify -> research -> score -> persona -> compose -> engage -> unify

## Env flags
MOCK_IDENTIFY, MOCK_RESEARCH, MOCK_UNIFY, DEMO_SAFE = "1" to bypass externals.
UNIFY_DRY_RUN defaults to "1".
Keys: OPENAI_API_KEY, UNIFY_API_KEY, UNIFY_PUBLIC_KEY, UNIFY_WEBHOOK_SECRET,
IPINFO_TOKEN, ALLOWED_RECIPIENTS.

## Code style
Types first, in lib/types.ts. Small pure functions in lib/. No classes.
Server console: one clear log line per pipeline step with its duration.