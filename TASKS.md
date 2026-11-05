# Campus Marketplace — Task Tracker

Deadline: **Nov 12, 2026** (submit by Nov 11 for a buffer day). See CLAUDE.md for architecture and rules.

## How to use this file
- Paste **one task at a time** into Claude Code (copy the prompt under the task).
- When Claude finishes a task, it ticks the box (`- [x]`) in this file. You review the diff and commit.
- A phase is done only when its **Done when** check passes on the **deployed** app.
- Don't start the next phase's tasks early (reading docs is fine).
- Tasks aren't assigned. Before starting one, tell your teammate so you don't both grab it.
- Fallback if behind by Nov 7: cut the dispute agent's escalation path and the reconciliation job first.

---

## Phase 0 — Setup & foundations (Oct 7–11)
Goal: both of you can run the app locally, it deploys, and it talks to the DB and PayPal sandbox.

- [x] **0.1 Create Postgres DB** (Supabase, done manually)

- [x] **0.2 Fill in the monorepo**
  > Read CLAUDE.md. The repo already has client/ (React + Vite) and server/ (Express + Prisma). Add worker/ (TypeScript, empty entry point for now) and a shared/ TypeScript package that client, server and worker can all import. Make sure the root .gitignore ignores every .env file but does NOT ignore CLAUDE.md or TASKS.md. Add a .env.example to each app listing the variables it needs (no real values). When done, tick task 0.2 in TASKS.md.

- [x] **0.3 Prisma schema + migration** (init migration applied to Supabase)
  > Read CLAUDE.md. Set up Prisma in server/ with Postgres, using DATABASE_URL from server/.env. Create the full schema for every table in CLAUDE.md: integer cents for all money fields, JSONB where CLAUDE.md says, a version column on orders, and a unique constraint on webhook_events.event_id. Show me the schema before running any migration. After the migration runs, tick task 0.3 in TASKS.md.

- [x] **0.4 Ledger DB safety** (included in the 0.3 init migration: sum-to-zero + append-only triggers. Tests in server/test/ledger.test.ts pass.)

- [x] **0.5 Seed script**
  > Read CLAUDE.md. Write a Prisma seed script in server/: 5 test users with school email addresses and 20 listings spread across several categories with realistic prices in integer cents. Make it safe to re-run. When done, tick task 0.5 in TASKS.md.

- [x] **0.6 State enum + legal transitions**
  > Read CLAUDE.md. In the shared types package, write the order state enum and a legal-transitions table as code, exactly matching the state machine in CLAUDE.md. Add a helper isLegalTransition(from, to). No database logic yet. When done, tick task 0.6 in TASKS.md.

- [x] **0.7 PayPal sandbox keys + token test** (create sandbox buyer/seller accounts and a REST app on developer.paypal.com manually first, put keys in server/.env)
  > Read CLAUDE.md. Add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_BASE_URL (sandbox) to server/.env.example. Write a small script in server/ that gets a PayPal sandbox OAuth access token using those env vars and prints success or the error. Never log the secret. When done, tick task 0.7 in TASKS.md.

- [x] **0.8 Deploy skeleton**
  > Read CLAUDE.md. Add a GET /health endpoint and a GET /listings endpoint (returns seeded listings from Postgres) to the API. Prepare the API for deployment on Render or Railway and the web app for Vercel: build scripts, start scripts, and a short DEPLOY.md listing the env vars each host needs. Don't deploy for me. When done, tick task 0.8 in TASKS.md.

- [x] **0.9 Branch rules** (manual): feature branches, PRs reviewed by the other person, main always deploys. Read PayPal docs on Orders v2 (authorize intent), Payouts, webhooks, and note the authorization honor and expiry windows in CLAUDE.md.

**Done when:** the deployed API returns seeded listings from Postgres, and the token script gets a PayPal sandbox access token.

---

## Phase 1 — Core marketplace (Oct 12–18)
Goal: a student can sign up, post an item, browse, and message a seller. No money yet.

- [x] **1.1 Auth API**
  > Read CLAUDE.md. Build the auth API: sign up restricted to school email domains (configurable list in env), email verification (a fake link logged to the console is fine in dev), login with JWT or sessions, and auth middleware for protected routes. When done, tick task 1.1 in TASKS.md.

- [x] **1.2 Listings API**
  > Read CLAUDE.md. Build the listings API: create, edit, mark sold, list with filters (category, price range), and get one. Only the seller can edit or mark sold. Add photo upload to Supabase Storage. When done, tick task 1.2 in TASKS.md.

- [x] **1.3 Chat API**
  > Read CLAUDE.md. Build the chat API: messages between buyer and seller per listing, stored in chat_messages, with an endpoint to send and an endpoint to fetch messages (polling is fine). Only the two participants can read a thread. When done, tick task 1.3 in TASKS.md.

- [x] **1.4 API tests**
  > Read CLAUDE.md. Write API tests for auth and listings: sign up with a non-school email fails, login works, unauthenticated requests are rejected, filters work, and a non-owner can't edit a listing. When done, tick task 1.4 in TASKS.md.

- [x] **1.5 Shared layout and design**
  > Read CLAUDE.md. In client/, set up a shared layout (header, nav, page container), a small set of reusable components (button, input, card), and routing, so later pages look consistent. When done, tick task 1.5 in TASKS.md.

- [x] **1.6 Auth UI**
  > Read CLAUDE.md. Build the sign up and login pages in client/ against the auth API, and add protected routes that redirect to login. When done, tick task 1.6 in TASKS.md.

- [x] **1.7 Browse, listing detail, post listing**
  > Read CLAUDE.md. Build in client/: a browse grid with category and price filters, a listing detail page, and a post-a-listing form with photo upload. When done, tick task 1.7 in TASKS.md.

- [x] **1.8 Chat panel + My listings / My orders**
  > Read CLAUDE.md. Add a chat panel on the listing detail page (polling the chat API) and a "My listings / My orders" page (orders list empty for now). When done, tick task 1.8 in TASKS.md.

**Done when:** on the deployed app, user A posts an item with a photo, user B finds it with a filter, and they exchange chat messages.

---

## Phase 2 — Payments core (Oct 19–25)
Goal: buyer pays, money is held, QR scan at handoff captures it, and the ledger shows every movement.

- [x] **2.1 Order state machine service** (server/src/orders/stateMachine.ts; tests in server/test/orderStateMachine.test.ts. No migration, no new env vars.)
  > Read CLAUDE.md. Build the order state machine service with one transition(orderId, from, to, expectedVersion) function that uses the legal-transitions table, rejects illegal moves, and uses optimistic concurrency (zero rows updated means a stale version, which is rejected). It must accept a Prisma transaction client so callers can combine it with other writes. When done, tick task 2.1 in TASKS.md.

- [x] **2.2 Double-entry ledger** (server/src/ledger/postTransaction.ts; tests in server/test/postTransaction.test.ts. Db client type moved to server/src/db.ts. No migration, no new env vars.)
  > Read CLAUDE.md. Build postTransaction(entries[]) for the double-entry ledger: integer cents only, refuses any transaction that doesn't sum to zero, append-only, and accepts a Prisma transaction client. When done, tick task 2.2 in TASKS.md.

- [x] **2.3 PayPal client (server only)** (server/src/paypal/client.ts; mocked-fetch tests in server/test/paypalClient.test.ts. Uses existing PAYPAL_* env vars; no migration.)
  > Read CLAUDE.md. Build a server-only PayPal client in server/ with: create order (intent AUTHORIZE), authorize, capture, and void. Every call sends a PayPal-Request-Id built from order ID + action. Handle errors and timeouts clearly. When done, tick task 2.3 in TASKS.md.

- [x] **2.4 Checkout flow**
  > Read CLAUDE.md. Build checkout: PayPal Buttons in client/, buyer approves, API authorizes, and in one DB transaction the order moves to AUTHORIZED with a 72-hour deadline and the ledger posts escrow_held / buyer_funds. When done, tick task 2.4 in TASKS.md.

- [x] **2.5 QR handoff + capture** (server/src/orders/handoff.ts, handoff token in server/src/auth/tokens.ts, routes POST /api/orders/:id/handoff-token and /api/orders/handoff/scan; client pages /orders/:orderId/handoff and /scan. Migration 20261022120000_add_qr_scans (qr_scans scan log, RLS on), applied. Tests in server/test/handoff.test.ts. No new env vars; reuses JWT_SECRET. New client deps: qrcode, jsqr.)
  > Read CLAUDE.md. Build the QR handoff: the seller's page shows a signed token (order ID, seller ID, single-use nonce, 5-minute expiry). The buyer scans it on a logged-in scanner page. The server verifies signature, nonce unused, not expired, and buyer is the order's buyer, marks the nonce used, captures through PayPal, and in one DB transaction moves the order to CAPTURED and posts escrow_held / seller_payable / platform_fees. Log every scan. When done, tick task 2.5 in TASKS.md.

- [x] **2.6 Order status page** (client page /orders/:orderId in client/src/pages/orders/OrderStatusPage.tsx, state labels in client/src/orders/; server GET /api/orders and GET /api/orders/:id in server/src/orders/orderStatus.ts, tests in server/test/orderStatus.test.ts. "My orders" on /me now lists orders. No migration, no new env vars.)
  > Read CLAUDE.md. Build an order status page in client/ for buyer and seller showing current state, the handoff deadline countdown, and the right action (show QR for seller, scan for buyer). When done, tick task 2.6 in TASKS.md.

- [x] **2.7 Unit tests** (server/test/paymentsInvariants.test.ts, alongside the existing orderState / orderStateMachine / postTransaction / ledger tests. No migration, no new env vars.)
  > Read CLAUDE.md. Write unit tests: every illegal transition is rejected, two concurrent updates with the same version result in exactly one winner, every ledger transaction sums to zero, and an unbalanced transaction is refused. When done, tick task 2.7 in TASKS.md.

- [x] **2.8 End-to-end sandbox run** (manual, together): full purchase in sandbox, then try a replayed QR token and a double-clicked capture.

**Done when:** a sandbox purchase goes CREATED → AUTHORIZED → CAPTURED via QR scan, the ledger balances, a replayed QR fails, and a retried capture does not double-charge.

---

## Phase 3 — Reliability (Oct 26–Nov 1)
Goal: webhooks, deadlines, payouts and retries all run without anyone clicking anything.

- [x] **3.1 Worker + deadline job** (job in server/src/jobs/handoffDeadline.ts, exported to the worker as `server/jobs`; pg-boss setup in worker/src/index.ts, sweep every minute; tests in server/test/handoffDeadline.test.ts. Migration 20261101120000_add_notifications (notifications table, RLS on), applied. Worker env: DATABASE_URL + PAYPAL_*; new optional DATABASE_POOL_MAX (worker forces 2, pg-boss max 2). Server tests now run with --maxWorkers=3. Worker hosting not decided yet.)
  > Read CLAUDE.md. Set up pg-boss in worker/. Add a deadline job that finds AUTHORIZED orders past their 72-hour deadline, voids them through PayPal, moves them to VOIDED via the state machine, and notifies both sides (a notification record is fine). When done, tick task 3.1 in TASKS.md.

- [x] **3.2 Transactional outbox** (server/src/outbox/outbox.ts: enqueue, SKIP LOCKED claim with 5-min lease, backoff 30s·2^n, DEAD after 5; server/src/outbox/handlers.ts: `order.state_changed` → buyer/seller notifications. transition() writes that row in the same transaction. Worker polls the relay every 5 s. Tests in server/test/outbox.test.ts. No migration (existing outbox table), no new env vars.)
  > Read CLAUDE.md. Implement the transactional outbox: state changes write an outbox row in the same transaction. The worker reads with FOR UPDATE SKIP LOCKED, sends the side effect, retries with exponential backoff, and moves it to a dead-letter status after 5 failures. When done, tick task 3.2 in TASKS.md.

- [x] **3.3 Webhook ingestor** (POST /api/webhooks/paypal in server/src/routes/webhooks.ts + server/src/webhooks/ingest.ts: verify via PayPal with the raw body, ON CONFLICT DO NOTHING insert + `paypal.webhook` outbox row in one transaction. Worker side in server/src/webhooks/process.ts: order lookup, stale events logged and dropped, handlers left for 3.4 (unhandled events stay processed_at null for replay). Tests in server/test/webhooks.test.ts. New env var PAYPAL_WEBHOOK_ID (Render). Webhook URL must be registered on the PayPal sandbox app. server/vitest.config.ts caps the test DB pool at 4. No migration.)
  > Read CLAUDE.md. Build the PayPal webhook endpoint: verify the signature using PayPal's verification endpoint, insert into webhook_events with ON CONFLICT DO NOTHING on event_id, queue for processing, and log and drop stale events. When done, tick task 3.3 in TASKS.md.

- [x] **3.4 Webhook event handlers** (server/src/webhooks/handlers.ts: AUTHORIZATION.VOIDED → VOIDED, CAPTURE.COMPLETED → CAPTURED, CAPTURE.REFUNDED → REFUNDED/PARTIAL_REFUND (IN_DISPUTE only), PAYOUTS-ITEM.SUCCEEDED → PAID_OUT with seller_payable/paid_out posting, FAILED/BLOCKED/RETURNED → PAYOUT_RETRY, DISPUTE.CREATED → IN_DISPUTE (AUTHORIZED only); anything the state machine can't express is stored as "needs review: ..." in webhook_events.process_error. Handler + processed mark in one transaction (process.ts). recordVoid gets a notify option. New script `npm run webhooks:replay -w server` (dry run; --apply queues unprocessed events). Tests in server/test/webhookHandlers.test.ts. No migration, no new env vars.)
  > Read CLAUDE.md. Handle these webhook events through the state machine: authorization voided, capture completed, capture refunded, payout item status, and dispute created. Check PayPal's docs for exact event names. When done, tick task 3.4 in TASKS.md.

- [x] **3.5 Payouts** (server/src/payouts/payouts.ts: worker sweep every minute sends CAPTURED → PAYOUT_PENDING (amount − fee to users.paypal_email; waits if unset), sender_batch_id payout-<order>-<attempt>, unknown outcomes re-send the same attempt, definite failures → PAYOUT_RETRY → re-sent with backoff (10 min·2^n, gives up after 5), status polled when no webhook arrives; PAID_OUT posts seller_payable/paid_out (shared with the 3.4 webhook handlers). New legal transition PAYOUT_RETRY → PAYOUT_PENDING (CLAUDE.md + shared/). PayPal client: createPayout, getPayoutBatch. New PUT /api/auth/me/paypal-email (needs password; no UI yet). Migration 20261103190000_add_payout_attempts, applied. Tests in server/test/payouts.test.ts. No new env vars.)
  > Read CLAUDE.md. After capture, send the seller payout through PayPal Payouts (amount minus platform fee): CAPTURED → PAYOUT_PENDING → PAID_OUT, with failure → PAYOUT_RETRY retried by the worker. Post seller_payable / paid_out to the ledger when paid. When done, tick task 3.5 in TASKS.md.

- [x] **3.6 Reauthorize-or-void** (server/src/jobs/authorizationExpiry.ts, worker every 5 min: after the honor period, reauthorize AUTHORIZED (deadline still ahead) and IN_DISPUTE orders and save the new authorization id + honor period; within a day of the 29-day expiry, or if PayPal refuses, void + notify both sides (AUTHORIZED) or notify both sides + log for review (IN_DISPUTE, no legal void). PayPal client: reauthorize. recordVoid takes custom messages; void steps shared as voidAndRecord. Migration 20261103210000_add_honor_period_ends_at (backfilled), applied; checkout now sets it. Tests in server/test/authorizationExpiry.test.ts. No new env vars.)
  > Read CLAUDE.md. Add a worker job for authorizations nearing PayPal's expiry window: reauthorize if the handoff is still pending, otherwise void and notify both sides. When done, tick task 3.6 in TASKS.md.

- [x] **3.7 Reconciliation job** (cut first if behind) (server/src/jobs/reconciliation.ts, worker every 5 min, 25 orders per run, longest-unchecked first, skipping orders changed in the last 15 min: ledger held / captured / paid-out totals vs PayPal's authorization, capture, refunds and payout item; mismatches saved to reconciliation_flags (HELD, CAPTURED, PAID_OUT, PAYPAL_RECORD; OPEN → RESOLVED when they agree again). Never changes orders or the ledger. PayPal client: getAuthorization, getCapture, getRefund. Migration 20261103230000_add_reconciliation_flags (new table, RLS on; orders.last_reconciled_at), applied. Tests in server/test/reconciliation.test.ts. No new env vars.)
  > Read CLAUDE.md. Add a worker job that every few minutes compares ledger totals per order with PayPal's records and saves any mismatch as a flagged record. When done, tick task 3.7 in TASKS.md.

- [x] **3.8 AG Grid admin dashboard** (client /admin in client/src/pages/admin/AdminDashboardPage.tsx, lazy-loaded, behind RequireAuth + new RequireAdmin, "Admin" nav link for admins: ledger money tiles (held / captured / paid out / owed to sellers / fees), orders-by-state grid that filters the orders grid (per-order ledger totals), reconciliation flags, dead-letter outbox; refreshes every 30 s. API GET /api/admin/dashboard (requireAuth + requireAdmin) in server/src/admin/dashboard.ts, tests in server/test/adminDashboard.test.ts. New client deps ag-grid-community + ag-grid-react 36.2.0 (exact). New script `npm run admin:grant -w server -- <email> [--revoke]`. Checked in a browser locally. No migration, no new env vars.)
  > Read CLAUDE.md. Build an admin dashboard in client/ with AG Grid: orders by state, money held vs captured vs paid out (computed from the ledger), flagged reconciliation mismatches, and dead-letter outbox items. Admin-only route. When done, tick task 3.8 in TASKS.md.

**Done when:** every failure scenario (capture timeout, duplicate webhook, QR scan + deadline race, payout failure, chat injection, authorization near expiry, ledger/PayPal mismatch) can be triggered on purpose and shows the right result on the dashboard.

---

## Phase 4 — AI risk engine and dispute agent (Nov 2–7)
Goal: every order gets a risk decision before payment, and complaints are resolved by an agent that proposes and a human approves.

- [x] **4.1 Risk features** (server/src/risk/features.ts: computeRiskFeatures(db, orderId, now) returns seller account age, seller listings in the last 24 h, amount vs category median (other sellers' non-removed listings, same currency, null under 3 comparables), seller + buyer past disputes, off-platform payment phrases in the order's chat; findOffPlatformPhrases catches spacing, leetspeak, lookalike and invisible-character evasion. Output holds only numbers and ids, no listing or chat text. Not called from checkout yet (4.3). Tests in server/test/riskFeatures.test.ts. No migration, no new env vars.)
  > Read CLAUDE.md. Build deterministic risk features for an order: seller account age, listings posted in the last 24 hours, price vs category median, past disputes, and off-platform payment phrases in chat (e-transfer, cash app, etc.). When done, tick task 4.1 in TASKS.md.

- [ ] **4.2 LLM risk classifier**
  > Read CLAUDE.md. Build the LLM risk classifier: inputs are the listing, features and chat, output is JSON-schema validated { risk: low|medium|high, reasons, signals }. Listing and chat text are passed as clearly delimited untrusted data. Invalid output falls back to medium. When done, tick task 4.2 in TASKS.md.

- [x] **4.3 Policy layer** (server/src/risk/policy.ts: pure applyRiskPolicy, hard-rule floor + classifier, low → NORMAL, medium → HOLD_WITH_WARNING, high → BLOCKED. server/src/risk/assess.ts: assessOrderRisk runs features → classifier → policy and saves to decisions; a block commits with its decision. Called from startCheckout before the PayPal order; a block sticks per buyer + listing, and authorize refuses unassessed orders. Longer hold = 120 h handoff deadline (RISK_HOLD_WINDOW_HOURS in shared), kept alive by the reauthorize job. createApp takes `classify`; startApi fakes it, so npm test never calls Claude. Tests in server/test/riskPolicy.test.ts and riskCheckout.test.ts. No migration, no new env vars.)
  > Read CLAUDE.md. Build the risk policy layer: hard rules act as a floor (e.g. off-platform payment phrases mean at least medium), combined with the LLM result, mapped to normal / longer hold with warning / BLOCKED. Run it before checkout and save every decision to the decisions table. When done, tick task 4.3 in TASKS.md.

- [ ] **4.4 Risk evals**
  > Read CLAUDE.md. Create an eval set of 40 labeled listings and chats (scam and legit, including prompt-injection attempts) and a script that runs the full risk pipeline and prints precision and recall. When done, tick task 4.4 in TASKS.md.

- [x] **4.5 Report a problem flow** (server/src/orders/dispute.ts, POST /api/orders/:id/dispute and /dispute/photos, client/src/pages/orders/ReportProblemPage.tsx, shared/src/disputes.ts; no migration or new env vars)
  > Read CLAUDE.md. Build "Report a problem": the buyer opens a dispute on an order, adds text and photos, and the order moves to IN_DISPUTE through the state machine. When done, tick task 4.5 in TASKS.md.

- [x] **4.6 Dispute agent read tools** (server/src/disputes/readTools.ts, server/test/disputeReadTools.test.ts; no migration or new env vars)
  > Read CLAUDE.md. Build the dispute agent's read tools: get order, chat history, photos, QR scan log, and ledger entries for a disputed order. When done, tick task 4.6 in TASKS.md.

- [x] **4.7 Dispute agent action tools + approval gate** (server/src/disputes/actionTools.ts: DISPUTE_ACTION_TOOLS + runDisputeActionTool via REST. Holds aren't captured yet, so full refund = void, partial = final capture of amount − refund, release = full capture, escalate = no PayPal call. Partial refunds are capped at the seller's share, plus a DB check. Orders over DISPUTE_APPROVAL_LIMIT_CENTS ($25, shared) wait for an admin. Admin API + dashboard queue in client/src/pages/admin/DisputeQueues.tsx. New worker queue dispute-decisions retries unknown outcomes. New legal transitions: RELEASED / PARTIAL_REFUND → PAYOUT_PENDING, ESCALATED → REFUNDED | PARTIAL_REFUND | RELEASED (CLAUDE.md + shared). Migration 20261105120000_add_dispute_decision_actions, applied. Tests in server/test/disputeActionTools.test.ts, with a fake PayPal. No agent loop calls these tools yet. PayPal dispute escalation cut. No new env vars.)
  > Read CLAUDE.md. Build the dispute agent's action tools (full refund, partial refund, release to seller, escalate) via the PayPal Agent Toolkit or REST. Refunds are capped at the amount paid. Actions above a set amount need admin approval in the dashboard. Save every decision with evidence, reasoning, proposed action, approver and PayPal transaction ID. Escalation to a PayPal dispute is optional (cut first if behind). When done, tick task 4.7 in TASKS.md.

- [x] **4.8 AI decisions in dashboard** (server/src/admin/dashboard.ts, client/src/pages/admin/AiDecisions.tsx, adminGrid.ts; approval queue from 4.7 stays in DisputeQueues.tsx; no migration or new env vars)
  > Read CLAUDE.md. Show risk decisions and dispute agent decision records in the admin dashboard, including the approval queue. When done, tick task 4.8 in TASKS.md.

  - [x] **4.9 Rate limiting and Claude API budget** (server/src/http/rateLimit.ts, mounted at /api after health + webhooks: in-memory, login + resend-verification per email (10) plus a per-IP backstop (50), signup per IP (20), per user for checkout / report / chat send, general per user or IP; IPs from getClientIp in server/src/http/clientIp.ts (True-Client-IP, else req.ip), also used for qr_scans.ip; 429 JSON + Retry-After, friendly text in client/src/api/client.ts; chat polling 4 s → 5 s to stay under the general limit. JSON body limit 32 kb. server/src/ai/claude.ts: callClaude is the one guard, reserves via conditional upserts in one transaction, per-site max_tokens and input caps (classifier 1024 tokens, was 2048; chat capped by capRiskInput). Classifier falls back with budget_exceeded (or budget_unavailable if the reservation fails). server/src/disputes/agentClaude.ts escalates to an admin when out of budget; no agent loop calls it yet. Dashboard tiles from getClaudeUsage. Migration 20261105130000_add_claude_budget_usage (RLS on), applied. New dep express-rate-limit 8.7.3 (exact). New optional env vars CLAUDE_BUDGET_CALLS_PER_DAY, CLAUDE_BUDGET_CALLS_PER_USER_PER_DAY. Tests in server/test/rateLimit.test.ts, claudeBudget.test.ts. Not checked: risk:classify against real Claude (no key locally), the tiles in a browser, True-Client-IP actually arriving on Render.)
  > Read CLAUDE.md. Add HTTP rate limiting with trust proxy set for Render: signup/login/resend-verification 10 per 15 min per IP, checkout 10 per hour per user, report a problem 5 per hour per user, chat send 30 per minute per user, everything else under /api 300 per 15 min. Exclude GET /api/health and the PayPal webhook route. Return 429 with a JSON error and Retry-After, and show a friendly message in client/. Add request body and text length limits so nobody can send huge text into a Claude prompt. Add a Claude API budget stored in Postgres (new table, with RLS enabled in its migration): hard-coded maximums of 300 calls per UTC day total and 20 per user, which env vars may lower but never raise. Reserve budget atomically before every Claude call through one shared guard (risk classifier, dispute agent), so concurrent requests can't pass the limit; the eval and live check scripts may bypass it with an explicit flag. When the budget is used up, the classifier falls back to medium with cause "budget_exceeded", the dispute agent leaves the dispute for an admin, and checkout never fails because of it. Set tight max_tokens and input size caps per call site. Show today's Claude usage vs. limit in the admin dashboard. Make limits injectable so tests use small limits on purpose; npm test must keep passing. Show me the migration and ask before running migrate:deploy. Add new env var names to .env.example. When done, tick task 4.9 in TASKS.md.

**Done when:** a scam-looking listing is blocked, an injection attempt in chat fails, the eval script prints numbers, and a demo dispute ends in an approved partial refund with a matching ledger entry.

---

## Phase 5 — Polish, demo and submission (Nov 8–12)
Goal: a judge understands the project in 3 minutes and can try it themselves.

- [ ] **5.1 Chaos buttons**
  > Read CLAUDE.md. Add admin "chaos" buttons in the dashboard to trigger failure scenarios live: duplicate webhook, capture timeout, expired deadline. Sandbox only. When done, tick task 5.1 in TASKS.md.

- [ ] **5.2 UI polish**
  > Read CLAUDE.md. Do a UI polish pass in client/: loading and error states on every page, and a mobile-friendly layout for the QR scanner page. When done, tick task 5.2 in TASKS.md.

- [ ] **5.3 Demo seed data**
  > Read CLAUDE.md. Write a demo seed script with one normal completed sale, one blocked scam listing, and one open dispute. When done, tick task 5.3 in TASKS.md.

- [ ] **5.4 Architecture diagram + payment tradeoff**
  > Read CLAUDE.md. Write docs/ARCHITECTURE.md with a Mermaid architecture diagram and a short section on the payment-model tradeoff (authorize-then-capture vs capture-and-hold, including the regulatory note about holding other people's money). When done, tick task 5.4 in TASKS.md.

- [ ] **5.5 README**
  > Read CLAUDE.md. Write the README: what the project is, setup steps, env vars (names only), how to use sandbox test accounts, and how to run evals. No real credentials. When done, tick task 5.5 in TASKS.md.

- [ ] **5.6 Demo video** (manual)
- [ ] **5.7 Devpost page** (together): problem, how escrow works, AI safety design, eval results, failure handling
- [ ] **5.8 Full dry run** (manual, together): deployed app from a fresh browser
- [ ] **5.9 Submit** 🚀

**Done when:** Devpost shows submitted, the video is public, and the deployed demo works with the test accounts in the README.
