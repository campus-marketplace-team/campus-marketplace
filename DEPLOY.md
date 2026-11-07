# Deploying

## Live

| | URL |
|---|---|
| Web app | https://campus-marketplace-five-delta.vercel.app |
| API | https://campus-marketplace-api-ia11.onrender.com (health: `/api/health`) |

- Every push to `main` redeploys both, so only push code that builds and passes tests.
- The Vercel and Render projects are on Abubakr's account. Ask him to add or change env vars, read the logs, or fetch a sign-up verification link.
- If a URL changes (e.g. a renamed Vercel domain), update this file, `CLAUDE.md`, `CORS_ORIGINS` on Render, and `VITE_API_URL` on Vercel.

## Setup

| Piece | Folder | Host |
|---|---|---|
| API | `server/` | Render (free plan) |
| Web app | `client/` | Vercel |
| Database | — | Supabase (already set up) |
| Worker | `server/src/worker/` | Runs **inside the API** on Render (`RUN_WORKER=true`); see [Worker](#worker-inside-the-api). `worker/` can still run it as its own process |

Deploy in this order, because each step needs a URL from the one before:
1. API, to get its URL (e.g. `https://campus-marketplace-api.onrender.com`).
2. Web app, with `VITE_API_URL` set to that API URL. This gives you the Vercel URL.
3. Back on the API host, set `CORS_ORIGINS` to the Vercel URL and redeploy.

Pushing to `main` redeploys both automatically once they're connected to the repo.

---

## API on Render

New → **Web Service** → connect the GitHub repo.

| Setting | Value |
|---|---|
| Root Directory | *(leave blank: the repo root)* |
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build -w server` |
| Start Command | `npm run start -w server` |
| Health Check Path | `/api/health` |

The build installs all workspaces (which also builds `shared/`), then runs `prisma generate` and `tsc` for the server. `--include=dev` is needed because TypeScript and the Prisma CLI are dev dependencies.

### Environment variables

| Variable | Value | Secret? |
|---|---|---|
| `DATABASE_URL` | Supabase **Session pooler** connection string (port 5432) | Yes |
| `DATABASE_POOL_MAX` | `4`. Prisma's pool, shared by requests and the worker; with pg-boss's 2 that's 6 connections. The worker refuses to start if it's unset or above 4 | No |
| `RUN_WORKER` | `true`: runs the background worker inside the API (see [Worker](#worker-inside-the-api)) | No |
| `PAYPAL_CLIENT_ID` | Sandbox app client ID | Yes |
| `PAYPAL_CLIENT_SECRET` | Sandbox app secret | Yes |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` | No |
| `PAYPAL_WEBHOOK_ID` | Webhook ID PayPal shows after you add `https://campus-marketplace-api-ia11.onrender.com/api/webhooks/paypal` under the sandbox app → Webhooks (subscribe to the events listed in CLAUDE.md). Without it the webhook endpoint answers 503 | No |
| `CORS_ORIGINS` | `https://campus-marketplace-five-delta.vercel.app` exactly (comma-separate several; **no trailing slash**) | No |
| `JWT_SECRET` | Long random string, at least 32 characters. Generate a new one for production; don't reuse your local one | Yes |
| `ALLOWED_EMAIL_DOMAINS` | School domains allowed to sign up, e.g. `mcmaster.ca` (comma-separated; subdomains allowed) | No |
| `API_PUBLIC_URL` | `https://campus-marketplace-api-ia11.onrender.com` (this API's own URL, used in email verification links) | No |
| `SUPABASE_URL` | Supabase project URL, e.g. `https://abcd.supabase.co` (Project Settings → API) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret / service_role key. Server only; it bypasses all access rules | Yes |
| `SUPABASE_STORAGE_BUCKET` | `listing-photos` (optional; that's the default) | No |
| `ANTHROPIC_API_KEY` | Claude API key for the LLM risk classifier and the dispute agent. Without it every order is classified as medium risk and every dispute goes straight to an admin | Yes |
| `CLAUDE_BUDGET_CALLS_PER_DAY` | Optional; suggested `100`. Lowers the Claude calls allowed per UTC day; can't go above the built-in 300 | No |
| `CLAUDE_BUDGET_CALLS_PER_USER_PER_DAY` | Optional. Lowers the Claude calls allowed per user per UTC day; can't go above the built-in 20 | No |
| `NODE_VERSION` | `24` | No |

Without the two Supabase variables the API still runs, but photo uploads answer 503. Likewise, without all three `PAYPAL_*` variables checkout answers 503.

The API refuses to start if `JWT_SECRET` or `ALLOWED_EMAIL_DOMAINS` is missing; the deploy log will say which.

There's no email provider yet, so email verification links are printed in the API's logs (`[email] Verify ...`). Open the link from there. Only the Render account owner can see the logs, so test with seed accounts (e.g. `seed.alex.chen@mcmaster.ca` / `password123`) instead of signing up.

Don't set `PORT`: Render sets it. Node 24 is pinned in `.nvmrc` and `engines`; `NODE_VERSION=24` makes Render use it too.

`DATABASE_URL` must be available during the build too, because `prisma.config.ts` reads it when `prisma generate` runs. Render provides env vars at build time by default.

Render's free plan sleeps after ~15 minutes without requests, and the first request afterwards takes up to ~1 minute. A sleeping API also means a stopped worker, so set up the uptime pinger below. Otherwise open `/api/health` a minute before a demo or a test run.

### Worker (inside the API)

The background worker (handoff deadlines, payouts, reauthorize-or-void, reconciliation, dispute decision retries, and the outbox relays that process webhooks, send notifications and run the dispute agent) runs in the API process when `RUN_WORKER=true`. It starts after the HTTP server is listening; on a redeploy (SIGTERM) it stops first, letting running jobs finish, then the server closes.

Env vars to add or check on Render (names only; values in the table above):

- `RUN_WORKER` = `true`
- `DATABASE_POOL_MAX` = `4`
- `ANTHROPIC_API_KEY`
- `CLAUDE_BUDGET_CALLS_PER_DAY` (suggested `100`)
- `PAYPAL_WEBHOOK_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Database connections: Supabase's session pooler allows 15 in total, shared by the deployed API, local dev and `npm test`. The API with its worker uses at most 6 (`DATABASE_POOL_MAX=4` for Prisma plus 2 for pg-boss).

Keep it awake with a free uptime pinger, such as [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org). Have it call `GET https://campus-marketplace-api-ia11.onrender.com/api/health` every 10 minutes. Without it the free plan sleeps after ~15 idle minutes, and the jobs stop with it.

Check it's running: `GET /api/health` returns `{"ok":true,"worker":{"enabled":true,"lastTickAt":"<recent time>"}}`, and `npm run test:smoke -w server` checks it ticked within the last 5 minutes. `"enabled":false` with `RUN_WORKER=true` means it failed to start; the logs say why (`Worker failed to start: ...`).

**Nobody should run a local worker (`npm run dev -w worker`, or `RUN_WORKER=true` in a local `server/.env`) while the deployed one is on.** Both would work the same shared database. Test users' rows (emails starting with `apitest.`) are always skipped, so `npm test` is safe to run.

### Railway instead

Same values: in the service's **Settings**, set the build command and start command from the table above, add the same environment variables, and generate a public domain under **Networking**.

---

## Web app on Vercel

New Project → import the GitHub repo.

| Setting | Value |
|---|---|
| Root Directory | `client` |
| Framework Preset | Vite |

Install command, build command, output folder and SPA routing come from `client/vercel.json`. The install runs from the repo root (`cd .. && npm ci`) so the `@campus/shared` workspace package resolves.

### Environment variables

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://campus-marketplace-api-ia11.onrender.com` (no trailing slash) |
| `VITE_PAYPAL_CLIENT_ID` | The same sandbox client ID as the API's `PAYPAL_CLIENT_ID` (the client ID is public; never the secret). Without it the PayPal buttons don't show |

`VITE_` variables are baked into the JavaScript at build time and are visible to anyone. Never put a secret in one. After changing it, redeploy.

---

## Database migrations

Deploys do **not** run migrations. The database is shared by local dev and production (anything you create while testing the live site shows up locally too, and the reverse), so apply schema changes once, from your machine:

```bash
npm run migrate:deploy -w server
```

Do this before pushing a commit that adds a migration, then tell your teammate to pull and run `npx prisma generate`.

---

## Photo storage

Listing photos live in a public Supabase Storage bucket. Anyone can view a photo by its URL; only the API (with the service role key) can upload or delete. Create the bucket once per Supabase project, from your machine, after adding the Supabase variables to `server/.env`:

```bash
npm run storage:setup -w server
```

It's safe to re-run. Don't add Storage policies for the anon role: uploads must go through the API, which checks the user is the listing's seller and that the file really is an image.

---

## Check a deploy

```bash
curl https://campus-marketplace-api-ia11.onrender.com/api/health     # {"ok":true,"worker":{"enabled":true,"lastTickAt":"..."}}
curl https://campus-marketplace-api-ia11.onrender.com/api/listings   # {"listings":[...]} with the seeded listings
```

CORS check: the response headers should include `Access-Control-Allow-Origin: https://campus-marketplace-five-delta.vercel.app`. If they don't, `CORS_ORIGINS` is wrong (often a trailing slash) or the API wasn't redeployed after changing it.

```bash
# Git Bash / macOS / Linux
curl -s -D - -o /dev/null -H "Origin: https://campus-marketplace-five-delta.vercel.app" https://campus-marketplace-api-ia11.onrender.com/api/health
# PowerShell
curl.exe -s -D - -o NUL -H "Origin: https://campus-marketplace-five-delta.vercel.app" https://campus-marketplace-api-ia11.onrender.com/api/health
```

Then open the web app and log in as a seed user.

If `/api/health` works but `/api/listings` returns 500, `DATABASE_URL` is wrong or the database is unreachable; the API host's logs show the real error.