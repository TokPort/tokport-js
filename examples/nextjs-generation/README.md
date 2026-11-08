# Next.js image and video starter

A standalone Bun + TypeScript + Next.js App Router app. Generate an image, submit a video, poll its status, and download the completed MP4. The browser calls a local Route Handler; the TokPort API key stays on the server.

Source: [TokPort/tokport-js](https://github.com/TokPort/tokport-js/tree/main/examples/nextjs-generation). The example uses plain HTTP so you can inspect the full request lifecycle without installing an SDK.

## Run

Requires Bun 1.3.3+ and Node.js 20.9+:

```sh
git clone https://github.com/TokPort/tokport-js.git
cd tokport-js/examples/nextjs-generation
bun install --frozen-lockfile
cp .env.example .env.local
# Edit .env.local: set TOKPORT_API_KEY and a separate strong STARTER_PASSWORD.
bun run dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000) and enter your **starter password**, not your TokPort key. Get an API key and fund your balance at [TokPort](https://tokport.io/dashboard/keys). Each Generate click can incur a charge; the app never retries a submission automatically.

You can copy this entire directory into a separate repository. It has no imports from the parent repository and has its own `package.json`, `bun.lock`, and test configuration. It is intentionally outside the root SDK workspaces: install dependencies and run commands from this directory, not the repository root. For a production build, run `bun run build && bun run start`.

## Recipes

- `app/api/generate/route.ts`: reads server-only environment variables and exposes POST (generate) and GET (status/download).
- `lib/gateway.ts`: authenticated requests, bounded prompts, fixed model selection, upstream timeout and errors. Image requests use `POST /v1/images/generations`; videos use `POST /v1/videos`, `GET /v1/videos/{id}`, then `GET /v1/videos/{id}/content`.
- `app/page.tsx`: image preview (URL or base64), video polling every five seconds with a ten-minute deadline, stop-waiting control, and authenticated download to a browser blob. The task ID remains visible after a polling error; paste an existing ID and select Resume video to continue without another submission.

Defaults: `gpt-image-2`, 1024×1024, one image; `seedance-2-5`, five seconds, 16:9. You can change model IDs on the server through `.env.local`; also adapt the fixed parameters in `lib/gateway.ts` to the selected model's [schema](https://tokport.io/docs/reference). A different model is not guaranteed to accept the same parameters. `TOKPORT_BASE_URL` is the origin (no `/v1` suffix).

HTTP 402 means insufficient balance; 429 means wait before retrying. A failed video stops polling. Stopping the browser or reaching the deadline does **not** cancel a submitted upstream job or imply a refund. If submission times out before returning an ID, check your dashboard before submitting again.

## Deployment boundary

The scripts bind to loopback by default. The password gates every gateway operation and is held only in browser memory; it grants access to the configured server key's generation and video tasks. This is a private single-owner demo, not a multi-user application. Before exposing it publicly, replace the shared password with your application's authenticated sessions, per-user task ownership, rate limits and spending quotas; use HTTPS and set a spending cap on the TokPort key. Never prefix either secret with `NEXT_PUBLIC_`.

The image request may take up to 180 seconds: use a host that supports that duration, or adapt image generation to TokPort's [queue API](https://tokport.io/docs/queue). Video generation itself happens upstream, outside the lifetime of a Next.js request.

## Checks

```sh
bun test
bun run typecheck
bun run build
bunx playwright install chromium
bun run test:e2e
```

Tests use a mock upstream and spend no credits. They exercise authentication, invalid input, image/video payloads, task retrieval, binary downloads, upstream errors and timeouts. To validate your actual model access, run the app with your own key and generate one image and one video.
