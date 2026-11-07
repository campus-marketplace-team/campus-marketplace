import { WORKER_DB_POOL_MAX } from "./env.js"; // first: caps the Prisma pool before server/jobs loads
import { prisma, type RunningWorker, startWorker } from "server/jobs";

// The worker as its own process. Normally it runs inside the API instead
// (RUN_WORKER=true on Render); never run both against the shared database.
// What it starts lives in server/src/worker/startWorker.ts.

let worker: RunningWorker;
try {
  worker = await startWorker({ pgBossMax: WORKER_DB_POOL_MAX });
} catch (err) {
  console.error("Worker failed to start:", (err as Error).message);
  await prisma.$disconnect();
  process.exit(1);
}

async function shutdown(signal: string) {
  console.log(`${signal} received, stopping worker`);
  await worker.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
