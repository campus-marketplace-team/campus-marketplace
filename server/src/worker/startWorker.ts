import { PgBoss } from "pg-boss";
import { PG_DEFAULT_POOL_MAX, poolMax } from "../db.js";
import { sweepApprovedDisputeDecisions } from "../disputes/actionTools.js";
import { sweepExpiringAuthorizations } from "../jobs/authorizationExpiry.js";
import { sweepHandoffDeadlines } from "../jobs/handoffDeadline.js";
import { sweepReconciliation } from "../jobs/reconciliation.js";
import { outboxHandlers, SLOW_OUTBOX_TOPICS } from "../outbox/handlers.js";
import { DRAIN_BATCH_SIZE, drainOutbox, type OutboxTopicFilter } from "../outbox/outbox.js";
import { sweepPayouts } from "../payouts/payouts.js";
import { getPayPalClient, type PayPalClient } from "../paypal/client.js";
import { recordWorkerTick, setWorkerEnabled } from "./status.js";

// The background worker: pg-boss schedules (pg-boss keeps its queue in the same
// Postgres, schema `pgboss`) plus two outbox relays. It runs either inside the
// API (RUN_WORKER=true, src/index.ts) or as its own process (worker/src/index.ts).
//
// Every job and relay skips test users' data (src/testUsers.ts): `npm test`
// shares this database, and its rows must never reach PayPal or Claude.

const HANDOFF_DEADLINE_QUEUE = "handoff-deadline";
const PAYOUTS_QUEUE = "payouts";
const AUTHORIZATION_EXPIRY_QUEUE = "authorization-expiry";
const RECONCILIATION_QUEUE = "reconciliation";
const DISPUTE_DECISIONS_QUEUE = "dispute-decisions";

/** Connections pg-boss may hold. */
export const PGBOSS_POOL_MAX = 2;
/**
 * Most DB connections a process running the worker may hold: Prisma's pool
 * (shared with the API's requests when it runs inside the API) plus pg-boss's.
 * Supabase's session pooler allows 15 in total, shared with local dev and tests.
 */
export const WORKER_PROCESS_MAX_CONNECTIONS = 6;

const OUTBOX_POLL_MS = 5_000;

/** Throws unless Prisma's pool plus pg-boss's fits in WORKER_PROCESS_MAX_CONNECTIONS. */
export function checkConnectionBudget(prismaPoolMax: number | undefined, pgBossMax: number) {
  const prismaMax = prismaPoolMax ?? PG_DEFAULT_POOL_MAX;
  if (prismaMax + pgBossMax > WORKER_PROCESS_MAX_CONNECTIONS) {
    throw new Error(
      `the worker needs DATABASE_POOL_MAX at most ${WORKER_PROCESS_MAX_CONNECTIONS - pgBossMax} ` +
        `(Prisma ${prismaPoolMax === undefined ? `unset, so pg's default of ${PG_DEFAULT_POOL_MAX}` : prismaMax} + pg-boss ${pgBossMax} ` +
        `would be over ${WORKER_PROCESS_MAX_CONNECTIONS} connections)`,
    );
  }
}

/** RUN_WORKER=true starts the worker inside the API. Anything else (or unset) leaves it off. */
export function runWorkerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.RUN_WORKER?.trim().toLowerCase() === "true";
}

export type RunningWorker = {
  /** Stops the relays (letting in-flight rows record their results) and pg-boss (letting running jobs finish). Safe to call twice. */
  stop: () => Promise<void>;
};

export async function startWorker({
  connectionString = process.env.DATABASE_URL,
  paypal = getPayPalClient(), // fails fast on missing PayPal settings
  pgBossMax = PGBOSS_POOL_MAX,
}: { connectionString?: string; paypal?: PayPalClient; pgBossMax?: number } = {}): Promise<RunningWorker> {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  checkConnectionBudget(poolMax(), pgBossMax);
  // Not fatal: without it the dispute agent's calls fail, and every dispute goes to an admin.
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: disputes will go straight to an admin");

  const skipTestUsers = true;

  // No LISTEN/NOTIFY: it would hold one more connection outside `max`. The sweeps run on a schedule anyway.
  const boss = new PgBoss({ connectionString, max: pgBossMax, useListenNotify: false });
  boss.on("error", (err) => console.error("pg-boss error:", err));

  /** A scheduled sweep. stately: at most one queued and one running, so slow runs don't pile up. */
  async function schedule<R>(queue: string, cron: string, retryLimit: number, run: () => Promise<R>, worthLogging: (r: R) => boolean) {
    await boss.createQueue(queue, { policy: "stately", retryLimit, expireInSeconds: 600 });
    await boss.schedule(queue, cron);
    await boss.work(queue, async () => {
      const result = await run();
      recordWorkerTick();
      if (worthLogging(result)) console.log(`${queue} sweep:`, result);
      return result;
    });
  }

  let stopping = false;
  const wakeRelays = new Set<() => void>();

  // Outbox relay: a plain polling loop rather than a pg-boss schedule, whose
  // cron granularity (one minute) is coarser than the outbox's 30 s first retry.
  // The claim uses FOR UPDATE SKIP LOCKED, so running several workers is safe.
  async function runOutboxRelay(name: string, limit: number, topics: OutboxTopicFilter) {
    while (!stopping) {
      let busy = false;
      try {
        const result = await drainOutbox(outboxHandlers, { limit, topics, skipTestUsers });
        recordWorkerTick();
        if (result.claimed > 0) console.log(`${name} drain:`, result);
        busy = result.claimed === limit; // a full batch: more may be waiting
      } catch (err) {
        console.error(`${name} error:`, (err as Error).message);
      }
      if (!busy && !stopping) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            wakeRelays.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, OUTBOX_POLL_MS);
          wakeRelays.add(wake);
        });
      }
    }
  }

  try {
    await boss.start();

    await schedule(HANDOFF_DEADLINE_QUEUE, "* * * * *", 2, () => sweepHandoffDeadlines(paypal, { skipTestUsers }), (r) => r.checked > 0);
    // Seller payouts: send after capture, re-send failed ones after a backoff, and check PayPal for sent ones no webhook has settled.
    await schedule(PAYOUTS_QUEUE, "* * * * *", 2, () => sweepPayouts(paypal, { skipTestUsers }), (r) => r.checked > 0);
    // Authorizations past their honor period or near PayPal's 29-day expiry: reauthorize or void.
    await schedule(AUTHORIZATION_EXPIRY_QUEUE, "*/5 * * * *", 2, () => sweepExpiringAuthorizations(paypal, { skipTestUsers }), (r) => r.checked > 0);
    // Reconciliation: compare a batch of orders' ledger totals with PayPal and flag mismatches.
    await schedule(RECONCILIATION_QUEUE, "*/5 * * * *", 1, () => sweepReconciliation(paypal, { skipTestUsers }), (r) => r.flagged > 0 || r.failed > 0);
    // Approved dispute decisions PayPal hasn't given a definite answer on: re-send with the same request id.
    await schedule(DISPUTE_DECISIONS_QUEUE, "* * * * *", 2, () => sweepApprovedDisputeDecisions(paypal, { skipTestUsers }), (r) => r.checked > 0);
  } catch (err) {
    await boss.stop({ graceful: false }).catch(() => {});
    throw err;
  }

  // Only topics with a handler: rows of other topics (e.g. a test's own) are left alone.
  // Slow topics (a dispute agent run takes minutes) get their own relay, one row at a
  // time, so they don't hold up webhooks or outlast the lease on a claimed batch.
  const fastTopics = Object.keys(outboxHandlers).filter((t) => !SLOW_OUTBOX_TOPICS.includes(t));
  const relays = Promise.all([
    runOutboxRelay("outbox relay", DRAIN_BATCH_SIZE, { only: fastTopics }),
    runOutboxRelay("slow outbox relay", 1, { only: SLOW_OUTBOX_TOPICS }),
  ]);

  setWorkerEnabled(true);
  console.log(
    `Worker started: ${HANDOFF_DEADLINE_QUEUE}, ${PAYOUTS_QUEUE} and ${DISPUTE_DECISIONS_QUEUE} every minute, ` +
      `${AUTHORIZATION_EXPIRY_QUEUE} and ${RECONCILIATION_QUEUE} every 5 minutes, outbox relays every ${OUTBOX_POLL_MS / 1000}s`,
  );

  let stopped: Promise<void> | null = null;
  return {
    stop() {
      stopped ??= (async () => {
        stopping = true;
        for (const wake of [...wakeRelays]) wake();
        await relays; // let in-flight rows finish recording their results
        await boss.stop({ graceful: true });
        setWorkerEnabled(false);
        console.log("Worker stopped");
      })();
      return stopped;
    },
  };
}
