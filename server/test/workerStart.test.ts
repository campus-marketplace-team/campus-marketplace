import { afterEach, describe, expect, it, vi } from "vitest";
import type { PayPalClient } from "../src/paypal/client.js";

// startWorker's wiring, with pg-boss and every job replaced by fakes (no DB):
// each schedule and both outbox relays run with skipTestUsers, the relays only
// claim topics they have handlers for, and the health status follows it.

const boss = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<unknown>>(),
  schedules: new Map<string, string>(),
  options: [] as unknown[],
  stop: vi.fn(async () => {}),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: unknown) {
      boss.options.push(options);
    }
    on() {}
    async start() {}
    async createQueue() {}
    async schedule(name: string, cron: string) {
      boss.schedules.set(name, cron);
    }
    async work(name: string, handler: () => Promise<unknown>) {
      boss.handlers.set(name, handler);
    }
    stop = boss.stop;
  },
}));

const sweepResult = { checked: 0, flagged: 0, failed: 0 };
vi.mock("../src/jobs/handoffDeadline.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepHandoffDeadlines: vi.fn(async () => sweepResult),
}));
vi.mock("../src/jobs/authorizationExpiry.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepExpiringAuthorizations: vi.fn(async () => sweepResult),
}));
vi.mock("../src/jobs/reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepReconciliation: vi.fn(async () => sweepResult),
}));
vi.mock("../src/payouts/payouts.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepPayouts: vi.fn(async () => sweepResult),
}));
vi.mock("../src/disputes/actionTools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepApprovedDisputeDecisions: vi.fn(async () => sweepResult),
}));
vi.mock("../src/outbox/outbox.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  drainOutbox: vi.fn(async () => ({ claimed: 0, done: 0, retried: 0, dead: 0 })),
}));

const { sweepApprovedDisputeDecisions } = await import("../src/disputes/actionTools.js");
const { sweepExpiringAuthorizations } = await import("../src/jobs/authorizationExpiry.js");
const { sweepHandoffDeadlines } = await import("../src/jobs/handoffDeadline.js");
const { sweepReconciliation } = await import("../src/jobs/reconciliation.js");
const { outboxHandlers, SLOW_OUTBOX_TOPICS } = await import("../src/outbox/handlers.js");
const { drainOutbox } = await import("../src/outbox/outbox.js");
const { sweepPayouts } = await import("../src/payouts/payouts.js");
const { checkConnectionBudget, PGBOSS_POOL_MAX, runWorkerFromEnv, startWorker, WORKER_PROCESS_MAX_CONNECTIONS } = await import(
  "../src/worker/startWorker.js"
);
const { getWorkerStatus, resetWorkerStatus } = await import("../src/worker/status.js");

const fakePayPal = {} as PayPalClient;

afterEach(() => {
  resetWorkerStatus();
  boss.handlers.clear();
  boss.schedules.clear();
  boss.options.length = 0;
  vi.clearAllMocks();
});

describe("startWorker", () => {
  it("runs every scheduled job with skipTestUsers", async () => {
    const worker = await startWorker({ connectionString: "postgres://fake", paypal: fakePayPal });
    try {
      expect(Object.fromEntries(boss.schedules)).toEqual({
        "handoff-deadline": "* * * * *",
        payouts: "* * * * *",
        "dispute-decisions": "* * * * *",
        "authorization-expiry": "*/5 * * * *",
        reconciliation: "*/5 * * * *",
      });
      for (const handler of boss.handlers.values()) await handler();
      for (const sweep of [sweepHandoffDeadlines, sweepPayouts, sweepExpiringAuthorizations, sweepReconciliation, sweepApprovedDisputeDecisions]) {
        expect(sweep).toHaveBeenCalledExactlyOnceWith(fakePayPal, { skipTestUsers: true });
      }
    } finally {
      await worker.stop();
    }
  });

  it("runs both outbox relays with skipTestUsers, each on only the topics it has handlers for", async () => {
    const worker = await startWorker({ connectionString: "postgres://fake", paypal: fakePayPal });
    await worker.stop();
    const scopes = vi.mocked(drainOutbox).mock.calls.map(([, options]) => options);
    const fast = Object.keys(outboxHandlers).filter((t) => !SLOW_OUTBOX_TOPICS.includes(t));
    expect(scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skipTestUsers: true, topics: { only: fast } }),
        expect.objectContaining({ skipTestUsers: true, topics: { only: SLOW_OUTBOX_TOPICS } }),
      ]),
    );
    expect(scopes.every((s) => s?.skipTestUsers === true)).toBe(true);
    expect(fast.length).toBeGreaterThan(0);
  });

  it("caps pg-boss at 2 connections and without LISTEN/NOTIFY", async () => {
    const worker = await startWorker({ connectionString: "postgres://fake", paypal: fakePayPal });
    await worker.stop();
    expect(boss.options).toEqual([expect.objectContaining({ max: PGBOSS_POOL_MAX, useListenNotify: false })]);
    expect(PGBOSS_POOL_MAX).toBe(2);
  });

  it("shows up in the health status while it runs, and stops once however often stop() is called", async () => {
    expect(getWorkerStatus()).toEqual({ enabled: false, lastTickAt: null });
    const worker = await startWorker({ connectionString: "postgres://fake", paypal: fakePayPal });
    await vi.waitFor(() => expect(getWorkerStatus().lastTickAt).not.toBeNull()); // the relays' first pass
    expect(getWorkerStatus().enabled).toBe(true);

    await Promise.all([worker.stop(), worker.stop()]);
    await worker.stop();
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(getWorkerStatus().enabled).toBe(false);
  });

  it("refuses to start without a database URL", async () => {
    await expect(startWorker({ connectionString: "", paypal: fakePayPal })).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("checkConnectionBudget", () => {
  it("allows Prisma's pool plus pg-boss up to 6 connections", () => {
    expect(WORKER_PROCESS_MAX_CONNECTIONS).toBe(6);
    expect(() => checkConnectionBudget(4, 2)).not.toThrow();
    expect(() => checkConnectionBudget(2, 2)).not.toThrow();
  });

  it("refuses more, including an unset DATABASE_POOL_MAX (pg's default of 10)", () => {
    expect(() => checkConnectionBudget(5, 2)).toThrow(/DATABASE_POOL_MAX at most 4/);
    expect(() => checkConnectionBudget(undefined, 2)).toThrow(/unset/);
  });
});

describe("runWorkerFromEnv", () => {
  it("is on only for RUN_WORKER=true", () => {
    expect(runWorkerFromEnv({})).toBe(false);
    expect(runWorkerFromEnv({ RUN_WORKER: "" })).toBe(false);
    expect(runWorkerFromEnv({ RUN_WORKER: "false" })).toBe(false);
    expect(runWorkerFromEnv({ RUN_WORKER: "1" })).toBe(false);
    expect(runWorkerFromEnv({ RUN_WORKER: "true" })).toBe(true);
    expect(runWorkerFromEnv({ RUN_WORKER: " TRUE " })).toBe(true);
  });
});
