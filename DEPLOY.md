# Deploying

## Live

| | URL |
|---|---|
| Web app | https://campus-marketplace-five-delta.vercel.app |
| API | https://campus-marketplace-api-ia11.onrender.com (health: `/api/health`) |

- Every push to `main` redeploys both, so only merge code that builds and passes tests.
- The Vercel and Render projects are on Abubakr's account. Ask him to add or change env vars, read the logs, or fetch a sign-up verification link.
- If a URL changes (e.g. a renamed Vercel domain), update this file, `CLAUDE.md`, `CORS_ORIGINS` on Render, and `VITE_API_URL` on Vercel.

## Setup

| Piece | Folder | Host |
|---|---|---|
| API | `server/` | Render (free plan) |
| Web app | `client/` | Vercel |
| Database | — | Supabase (already set up) |
| Worker | `worker/` | Not deployed yet; hosting to be decided in Phase 3 |

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
| `NODE_VERSION` | `24` | No |

Without the two Supabase variables the API still runs, but photo uploads answer 503. Likewise, without all three `PAYPAL_*` variables checkout answers 503.

The API refuses to start if `JWT_SECRET` or `ALLOWED_EMAIL_DOMAINS` is missing; the deploy log will say which.

There's no email provider yet, so email verification links are printed in the API's logs (`[email] Verify ...`). Open the link from there. Only the Render account owner can see the logs, so test with seed accounts (e.g. `seed.alex.chen@mcmaster.ca` / `password123`) instead of signing up.

Don't set `PORT`: Render sets it. Node 24 is pinned in `.nvmrc` and `engines`; `NODE_VERSION=24` makes Render use it too.

`DATABASE_URL` must be available during the build too, because `prisma.config.ts` reads it when `prisma generate` runs. Render provides env vars at build time by default.

Render's free plan sleeps after ~15 minutes without requests, and the first request afterwards takes up to ~1 minute. Open `/api/health` a minute before a demo or a test run.

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

Do this before merging a branch that adds a migration, then tell your teammate to pull and run `npx prisma generate`.

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
curl https://campus-marketplace-api-ia11.onrender.com/api/health     # {"ok":true}
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