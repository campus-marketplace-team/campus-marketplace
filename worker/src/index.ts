import { WORKER_DB_POOL_MAX } from "./env.js"; // first: caps the Prisma pool before server/jobs loads
import { PgBoss } from "pg-boss";
import {
  DRAIN_BATCH_SIZE,
  drainOutbox,
  getPayPalClient,
  outboxHandlers,
  prisma,
  sweepHandoffDeadlines,
} from "server/jobs";

// Background jobs on pg-boss, which keeps its queue in the same Postgres (its
// own `pgboss` schema). The job logic lives in server/src/jobs so it shares
// the state machine, ledger and PayPal client with the API.

const HANDOFF_DEADLINE_QUEUE = "handoff-deadline";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Fail fast on missing PayPal settings instead of on the first overdue order.
const paypal = getPayPalClient();

// No LISTEN/NOTIFY: it would hold one more connection outside `max`. The sweep runs on a schedule anyway.
const boss = new PgBoss({ connectionString, max: WORKER_DB_POOL_MAX, useListenNotify: false });
boss.on("error", (err) => console.error("pg-boss error:", err));

await boss.start();

// stately: at most one sweep queued and one running, so slow runs don't pile up.
await boss.createQueue(HANDOFF_DEADLINE_QUEUE, { policy: "stately", retryLimit: 2, expireInSeconds: 600 });
await boss.schedule(HANDOFF_DEADLINE_QUEUE, "* * * * *"); // every minute

await boss.work(HANDOFF_DEADLINE_QUEUE, async () => {
  const result = await sweepHandoffDeadlines(paypal);
  if (result.checked > 0) console.log("handoff-deadline sweep:", result);
  return result;
});

// Outbox relay: a plain polling loop rather than a pg-boss schedule, whose
// cron granularity (one minute) is coarser than the outbox's 30 s first retry.
// The claim uses FOR UPDATE SKIP LOCKED, so running several workers is safe.
const OUTBOX_POLL_MS = 5_000;
let stopping = false;
let wakeRelay: (() => void) | undefined;

async function runOutboxRelay() {
  while (!stopping) {
    let busy = false;
    try {
      const result = await drainOutbox(outboxHandlers);
      if (result.claimed > 0) console.log("outbox drain:", result);
      busy = result.claimed === DRAIN_BATCH_SIZE; // a full batch: more may be waiting
    } catch (err) {
      console.error("outbox relay error:", (err as Error).message);
    }
    if (!busy && !stopping) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, OUTBOX_POLL_MS);
        wakeRelay = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}
const outboxRelay = runOutboxRelay();

console.log(`Worker started: ${HANDOFF_DEADLINE_QUEUE} every minute, outbox relay every ${OUTBOX_POLL_MS / 1000}s`);

async function shutdown(signal: string) {
  console.log(`${signal} received, stopping worker`);
  stopping = true;
  wakeRelay?.();
  await outboxRelay; // let an in-flight batch finish recording its results
  await boss.stop({ graceful: true });
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
