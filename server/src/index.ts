import "dotenv/config";
import { createApp } from "./app.js";
import { getAuthConfig } from "./auth/config.js";
import { prisma } from "./db.js";
import { type RunningWorker, runWorkerFromEnv, startWorker } from "./worker/startWorker.js";

// Fail fast on missing auth settings instead of on the first login.
getAuthConfig();

const app = createApp();

/** Render waits about 30 s after SIGTERM before killing the process; finish before that. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

let workerStarting: Promise<RunningWorker | null> = Promise.resolve(null);

const port = Number(process.env.PORT) || 4000;
const server = app.listen(port, () => {
  console.log(`Server on http://localhost:${port}`);
  // Off unless RUN_WORKER=true, so local dev and npm test never start it.
  if (runWorkerFromEnv()) {
    workerStarting = startWorker().catch((err) => {
      // The API keeps serving; GET /api/health shows the worker as not enabled.
      console.error("Worker failed to start:", (err as Error).message);
      return null;
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => {
    console.error("Shutdown took too long, exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    // Worker first: its in-flight rows and jobs record their results while the DB pool is still open.
    await (await workerStarting)?.stop();
  } catch (err) {
    console.error("Worker didn't stop cleanly:", (err as Error).message);
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
