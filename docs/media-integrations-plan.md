# Media & Peer-Agent Integrations — Design Plan

> **Status (2026-07-11): IMAGE v1 SHIPPED.** `image_generate` MCP tool → `/api/agent/image/generate`
> loopback → `TerminalManager.generateImage` (governed via `gate('image.generate', {amountUsd})` → the
> money-cap rule) → swappable `ImageBackend` (OpenRouter default / Atlas alt, `src/edge/image-gen.ts`) →
> `ArtifactStore.ingest` (server-side bytes → gallery `kind:'image'`) → audited `image.generated` with
> the real `usage.cost`. Keys live in Settings → Integrations (`imageGenConfigured` → `IMAGE_GEN=1`
> exposes the tool).
>
> **Status (2026-07-13): VIDEO v1 SHIPPED.** `video_generate` MCP tool → `/api/agent/video/generate` →
> `TerminalManager.generateVideo`: gate `video.generate` (money-cap via `amountUsd` = per-second ×
> duration) → **fal.ai** (default; verified queue contract `POST queue.fal.run/{model}` → `status_url`/
> `response_url`) or **Atlas** backend (`src/edge/video-gen.ts`). Video is ASYNC, so it uses a **job
> model**: the submit handle persists to a **`video_jobs`** table (`src/state/video-jobs.ts`); a brief
> in-call poll catches fast renders and a **background poller on the Automations tick**
> (`pollVideoJobs`) finishes the rest — surviving the poll cap AND a restart. On completion the mp4 is
> downloaded + `ingest`ed (`kind:'video'`, folder `generated-videos`) + an owner inbox card, audited
> `video.generated`. The gallery already previews video, so no new UI. Cost is an ESTIMATE (video is
> per-second, rarely returned in-band). Keys in Settings → Integrations (`videoGenConfigured` →
> `VIDEO_GEN=1`); **OpenRouter doesn't do video**, so a fal.ai (or Atlas) key is required. Chose **poll**,
> not the webhook-callback variant, because it needs no public URL (parity with the outbound-only
> posture) — `video_jobs` + the tick poller IS the durable job model the callback approach provided.
> Codex/Antigravity remain the roadmap below.
>
> **Original planning notes (kept as design of record):** This doc captures the full design space for
> giving Claude sessions capabilities Claude can't do natively: **image generation**, **video
> generation**, and **talking to peer coding agents** (Codex, Antigravity/Gemini). Image is the first
> cut; the rest is roadmap. The through-line: in Agent OS the question is never "which vendor API" —
> it's **where in the trust layer the capability lives**, because that decides whether it's governed,
> budgeted, audited, and whether the output becomes a first-class artifact.

## 0. The core framing

Claude sessions cannot generate images or video. So we hand them a **tool**. But *how* we wire that tool
determines everything about governance. Agent OS already has three placement patterns, each with a
different trust posture. Every integration below is really a choice among these three.

| Pattern | How it works | Governance you get | Best for |
|---|---|---|---|
| **1. OS-owned MCP tool** (loopback) | session-secret-gated MCP tool → `/api/*` route *before* the auth gate → routed through the 7-step **gateway** | Policy classify, **Budget debit**, Idempotency, structured **Audit**, artifact integration — all free | first-class capabilities |
| **2. Composio / connector egress** | connector secret via the MCP bag; call the vendor Composio already wraps | connector-level, audit-only | vendors Composio already has |
| **3. Shell + `shellSecrets`** | inject a vendor key as an env var; agent shells out to a CLI/curl | only the PreToolUse **gate-hook** — no budget, no artifact, no structured audit | fast escape hatch / prototypes |

The existing memory/slack/publish tools are all **pattern 1** — that's the template we copy for media.

## 1. Image & Video → Pattern 1 (MCP loopback), driven by three forces

### a) Integrate an aggregator, not N vendors
Back `image_generate` / `video_generate` with an **aggregator** and make `model` a **parameter**. One
integration buys the whole model zoo; adding a model is adding a string, not a connector.

**Aggregator candidates (ranked after the 2026-07-11 deep-research pass + Atlas Cloud fetch):**

1. **OpenRouter — Unified Image API** ⭐ *research pick.* Launched **June 23, 2026** (weeks old). ONE
   Bearer-authed `POST https://openrouter.ai/api/v1/images`, **30+ models** normalized behind a single
   `model` param (Google, OpenAI, Black Forest Labs, Recraft, ByteDance, Sourceful, Microsoft, xAI).
   Discovery routes `/api/v1/images/models` + `…/{id}/endpoints`. **Killer feature for us: every
   response's `usage` object returns the exact USD `cost`** (plus per-endpoint pricing lines: billable
   unit + USD), so the **budget plane debits the real number with NO static cost table**. That single
   fact is why it wins requirement (c) outright. *Verified 3-0 in the research pass.*
2. **Atlas Cloud** (`atlascloud.ai`) — unified inference, **300+ models**, **OpenAI-compatible REST** +
   single key, **sync AND async**. Image (Seedream 5.0, GPT Image 2, Flux.2, Nano Banana 2/Pro, Qwen
   Image, Ideogram, Imagen), **video** (Seedance, Kling v3, Veo 3.1, Hailuo…), plus 3D & audio.
   Transparent per-unit pricing — images **$0.004–$0.15**, video **$0.018–$0.49/s**. Strongest *breadth*
   play and the only candidate that **covers phase-2 video under the same key**. *(Not in the research
   pass — added from a direct fetch; confirm the machine-readable cost field + sync image return shape.)*
3. **fal.ai** — established, image-focused, `subscribe()` gives a sync-style blocking call that
   auto-polls a queue. Per-image list pricing confirmed (Recraft V4.1 base **$0.035/image**, verified
   3-0). *Caveat: this pass could NOT confirm fal's auth header, queue submit/poll contract, URL-vs-base64
   response, webhook support, or any programmatic cost API — treat those as unknown, verify against live
   docs before building on it.*
4. **Replicate** — broadest catalog, but default **async predict-and-poll**, **compute-time** billing
   (not flat per-image), and whether cost is machine-readable in the response was unconfirmed. Weakest fit
   for a simple synchronous, cost-metered v1.

**Direct providers (context, not the v1 path):** Black Forest Labs **FLUX** is async (submit →
`request_id`+`polling_url`, poll to Ready/Failed, webhooks optional) and returns **short-lived
`delivery.*.bfl.ai` URLs** (~10 min — snapshot promptly), *verified*. Google **Nano Banana Pro** (Gemini
3 Pro Image) ~**$0.134/img** std / $0.24 4K; **Imagen 4** ~$0.02/$0.04/$0.06 Fast/Std/Ultra; OpenAI
**gpt-image** token-billed (~$0.005/img for Mini) — *these per-image figures came from blog-grade
sources and were NOT independently verified; check the vendor's own pricing page before relying on them.*
**Midjourney = API-inaccessible** (Discord-only; no official REST/SDK) — excluded.

- **Image models**: Flux (Black Forest Labs), Google Imagen / "Nano Banana", Ideogram, Recraft,
  Stability, OpenAI gpt-image-1. (Midjourney has no official API.)
- **Video models**: Google Veo, OpenAI Sora, Kling, Runway, Luma Dream Machine, Pika, Minimax/Hailuo.

Keep the tool signature **vendor-agnostic** so the backend can be swapped later without touching the
tool contract.

### b) Output is binary → it MUST become an artifact
The single most important integration point. Generated bytes land in the **`artifacts` store** and the
tool returns an **artifact ref / URL**, never base64 in the transcript. This:
- plugs media straight into `library_list` / `publish` and the Inbox,
- keeps sessions cheap (no giant blobs in context),
- gives every generated asset an audited, addressable home.

Without this, nothing else matters.

### c) Video is async (minutes) → it needs a job model
Never block a session for a multi-minute render. Two clean options, both have primitives already:
- **Poll**: tool returns a `job_id`; the agent `task_wait`s, or a `schedule`d one-shot re-checks.
- **Webhook callback** (preferred for video): vendor → `/hooks/<id>?key=` → an **automation** fires
  when the render lands and DMs/inboxes the result. "Video-done" becomes a first-class event instead of
  a blocked session.

Image is fast enough (seconds) to return synchronously in the first cut.

### Governance that falls out of Pattern 1
- **Budget** debits the real dollar cost per generation (image cents, video dollars).
- **Policy** can gate — e.g. "video over $X or > N seconds needs owner approval" — with the standard
  approval card.
- The whole thing lands in the **audit trail** (`image.generate` / `video.generate` events).

This governance is the entire reason to prefer Pattern 1 over the shell escape hatch (Pattern 3).

## 2. Codex / Antigravity → a DIFFERENT problem (peer *agents*, not single-shot APIs)

These aren't "call an endpoint" — they're **agentic CLIs** with their own loops. Value: second opinion,
different model strengths, parallel exploration. Four integration depths, increasing power & lift:

1. **One-shot shell-out** (Pattern 3) — `codex exec "…"` from bash, key via `shellSecrets`. Quick "get a
   second opinion," zero plumbing. Ungoverned beyond the gate-hook, no fleet visibility.
2. **MCP bridge** (Pattern 1) — Codex ships an MCP server mode; expose an `ask_codex` / `ask_gemini` MCP
   tool so a Claude session delegates a subtask and gets the answer inline. Governed like any loopback
   tool. Good, cheap middle ground to prove the ergonomics.
3. **First-class sibling agent (the big one)** — extend `TerminalManager` with a **non-claude launch
   lane** so Codex/Antigravity become real fleet members: they take `task_dispatch` hand-offs, run under
   the same gate hook, run-as identity, budget, and audit. Turns Agent OS into a **cross-model fleet**,
   not just multi-vendor APIs. The A2A delegation path already exists (`task_create` → assigned agent →
   governed session); the lift is teaching the launcher a **second binary** (today `claude-launch.sh` +
   tuning + gate wiring are all claude-shaped).
4. **Automation trigger target** — Codex/Antigravity as the spawn target of an automation, for
   scheduled/triggered non-claude runs.

**Tension to name honestly:** depth 3 is where the platform thesis pays off (a governed multi-model
fleet), but it's a real launcher refactor — a roadmap item, not a first cut.

## 3. Recommendation / build order

1. **Image now** — `image_generate` MCP tool → **OpenRouter Unified Image API** backend → **artifact
   out**, synchronous. Small, high-value, fully governed. Budget debits the **`usage.cost`** the response
   hands back (no static price table). *(This is what we're building first — pending final backend
   confirmation with Vikas; Atlas Cloud is the alternative if we want video under the same key from day 1.)*
2. **Video next** — same tool family, but land the **webhook-callback + automation** job model so long
   renders are events, not blocked sessions.
3. **Codex/Antigravity** — start at **depth 2 (MCP bridge)** to prove "ask a peer model" cheaply, then
   invest in **depth 3 (non-claude launch lane)** only when true cross-model dispatch is wanted.

## 4. Image v1 — concrete design (building now)

> **Backend decision (2026-07-11):** build v1 against a **swappable `ImageBackend` interface** with two
> adapters — **OpenRouter** (default when `OPENROUTER_API_KEY` present; uses `usage.cost`) and **Atlas
> Cloud** (OpenAI-compatible; static/again-response cost) — and plug in whichever key is provided first.
> Selection = config/available-key, not a hardcoded vendor.

**Tool** (`src/memory/memory-mcp.ts`, always-on, session-secret-gated loopback — copy the `slack_send`
shape):

```
image_generate({
  prompt: string,
  model?: string,        // aggregator model id; sensible default (e.g. a Flux variant)
  size?: string,         // e.g. "1024x1024"; vendor-mapped
  n?: number,            // default 1
})  → { artifacts: [{ id, url, model, ... }] }
```

**Route** (`src/server.ts` loopback, *before* the auth gate, mirrors other `/api/agent|api/*` MCP
routes): `POST /api/images/generate` →
1. resolve the aggregator key from the **vault** (not `shellSecrets` — server-side only),
2. call the aggregator, poll/await the (fast) result,
3. download bytes → **`artifacts` store** (reuse the existing artifact write path),
4. **audit** `image.generate` (prompt, model, cost, artifact ids — no raw bytes),
5. return artifact refs.

**Governance wiring:**
- Route through the **gateway** so **Budget** debits the per-image cost and **Policy** *can* classify it
  (default: allow; leave a hook so an owner can later require approval for expensive models).
- Audit event carries model + cost + artifact ids.

**Open questions to settle during build:**
- **Backend** — *leaning OpenRouter* (research pick: machine-readable `usage.cost`, 30+ models, one
  Bearer POST). Atlas Cloud is the alternative if we want image+video under one key from day 1. Keep the
  call site behind a small backend interface so we can add/swap.
- **Key storage**: new vault key (`OPENROUTER_API_KEY`, or `ATLAS_*` / `FAL_KEY`) surfaced in
  **Settings → Integrations**.
- **Cost source** — *RESOLVED for OpenRouter*: read the response's `usage.cost` (exact USD per request)
  and debit that; no static table. Nuance: it's **per-request** (aggregate when `n>1`) and documented
  "when available" — validate it's populated for each model we enable, and fall back to a small default
  if absent. For a non-usage backend (Atlas/fal) we'd need a static per-model table instead.
- **Output shape** — confirm per model whether OpenRouter returns a **URL vs base64** (may vary across
  the 30+ models); handle both in the ingest path (download URL → bytes, or decode base64 → bytes). URLs
  from providers like FLUX expire in ~10 min, so **snapshot to the artifact immediately**, never store
  the URL as the deliverable.
- **Rate/concurrency limits** — unconfirmed for OpenRouter's Image API; find them before enabling
  high-volume/automation use.
- **Artifact write** — *RESOLVED*: `ArtifactStore.publish` only snapshots a file *from the agent's
  working folder* (`allowRoot` + `containedPath`), but generated bytes originate **server-side**. Add a
  sibling **`ArtifactStore.ingest(bytes, filename, {sessionId, agent, source, title, ...})`** that writes
  the blob straight into a fresh `<home>/artifacts/<id>/<filename>` and inserts the row — same table/shape,
  skips the working-folder copy. `mimeOf` already covers `.png/.jpg/.webp/.gif/.svg` and `.mp4/.webm/.mov`,
  so the gallery previews generated media with **zero UI work**. Artifact `kind: 'image'`,
  `source: 'image_generate'`.
- **Default model + size** and how vendor-specific params (aspect ratio, steps, seed) are exposed
  without leaking vendor shape into the tool contract.

## 5. What this deliberately is NOT (v1 cuts)
- No video yet (job model comes with it).
- No Codex/Antigravity lanes yet.
- No image editing / inpainting / img2img — text-to-image only first.
- No per-model policy presets — one allow rule, budget-debited, refine later.
