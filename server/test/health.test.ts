import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordWorkerTick, resetWorkerStatus, setWorkerEnabled } from "../src/worker/status.js";
import { type Api, prisma, startApi } from "./helpers/api.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  resetWorkerStatus();
  await api.close();
  await prisma.$disconnect();
});

describe("GET /api/health", () => {
  it("says the worker is off when this process doesn't run it (the default, as in npm test)", async () => {
    const res = await api.call("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, worker: { enabled: false, lastTickAt: null } });
  });

  it("shows when a running worker last ticked, and nothing else", async () => {
    const at = new Date("2026-11-07T12:00:00.000Z");
    setWorkerEnabled(true);
    recordWorkerTick(at);
    const res = await api.call("GET", "/health");
    expect(res.body).toEqual({ ok: true, worker: { enabled: true, lastTickAt: at.toISOString() } });
  });
});
