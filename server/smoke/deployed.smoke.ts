import { beforeAll, describe, expect, it } from "vitest";

// Read-only checks against the deployed API. Base URL from SMOKE_API_URL,
// defaulting to the Render URL in CLAUDE.md (not a secret). If one fails, don't
// change code to make it pass: look at Render's logs and env vars first.

const API_URL = (process.env.SMOKE_API_URL ?? "https://campus-marketplace-api-ia11.onrender.com").replace(/\/+$/, "");

const WAKE_TIMEOUT_MS = 90_000;
/** After a cold start the worker starts just after the server listens; give it this long to report. */
const WORKER_START_GRACE_MS = 60_000;
const MAX_TICK_AGE_MS = 5 * 60 * 1000;

type Health = { ok: boolean; worker?: { enabled: boolean; lastTickAt: string | null } };

async function getHealth(timeoutMs = 15_000): Promise<{ status: number; body: Health }> {
  const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: (await res.json()) as Health };
}

beforeAll(async () => {
  // Wake the API first (Render's free plan sleeps when idle).
  await getHealth(WAKE_TIMEOUT_MS);
});

describe(`deployed API (${API_URL})`, () => {
  it("answers GET /api/health with ok", async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("runs the worker, which finished a job or relay pass within the last 5 minutes", async () => {
    const deadline = Date.now() + WORKER_START_GRACE_MS;
    let worker: Health["worker"];
    for (;;) {
      worker = (await getHealth()).body.worker;
      if ((worker?.enabled && worker.lastTickAt) || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(worker, "health has no worker field: is the latest code deployed?").toBeDefined();
    expect(worker!.enabled, "worker not running: check RUN_WORKER=true and 'Worker failed to start' in Render's logs").toBe(true);
    expect(worker!.lastTickAt, "worker never ticked: check Render's logs for relay or pg-boss errors").not.toBeNull();
    const age = Date.now() - new Date(worker!.lastTickAt!).getTime();
    expect(age, `last tick was ${Math.round(age / 1000)} s ago: check Render's logs for relay or pg-boss errors`).toBeLessThan(MAX_TICK_AGE_MS);
  });
});
