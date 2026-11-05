import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JSON_BODY_LIMIT } from "../src/app.js";
import { DEFAULT_RATE_LIMITS, type RateLimits } from "../src/http/rateLimit.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// The real app with small limits passed in on purpose. Each test starts its own API,
// so it starts with empty counters. Trust proxy is on, so X-Forwarded-For sets the
// client's IP here, as Render's proxy does in production.

const WINDOW_MS = 60_000;
const limits = (overrides: Partial<Record<keyof RateLimits, number>>) =>
  Object.fromEntries(Object.entries(overrides).map(([name, max]) => [name, { max, windowMs: WINDOW_MS }])) as Partial<RateLimits>;

let apis: Api[] = [];
let tokenA: string;
let tokenB: string;
let bootstrap: Api;

async function start(overrides: Partial<Record<keyof RateLimits, number>>) {
  const api = await startApi({ rateLimits: limits(overrides) });
  apis.push(api);
  return api;
}

function send(api: Api, method: string, path: string, { token, ip = "203.0.113.1", json, headers }: { token?: string; ip?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(api.url + path, {
    method,
    headers: {
      "X-Forwarded-For": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

beforeAll(async () => {
  bootstrap = await startApi();
  tokenA = await login(bootstrap, (await createTestUser("limit-a")).email);
  tokenB = await login(bootstrap, (await createTestUser("limit-b")).email);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apis.map((api) => api.close()));
  apis = [];
});

afterAll(async () => {
  await bootstrap.close();
  await cleanup();
  await prisma.$disconnect();
});

const LISTING = randomUUID();

describe("rate limits", () => {
  it("defaults to the agreed numbers", () => {
    const MINUTE = 60_000;
    expect(DEFAULT_RATE_LIMITS).toEqual({
      auth: { max: 10, windowMs: 15 * MINUTE },
      checkout: { max: 10, windowMs: 60 * MINUTE },
      reportProblem: { max: 5, windowMs: 60 * MINUTE },
      chatSend: { max: 30, windowMs: MINUTE },
      general: { max: 300, windowMs: 15 * MINUTE },
    });
  });

  it("answers 429 with a JSON error and Retry-After", async () => {
    const api = await start({ general: 1 });
    expect((await send(api, "GET", "/listings")).status).toBe(200);

    const res = await send(api, "GET", "/listings");
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "RATE_LIMITED", retryAfterSeconds: retryAfter });
  });

  it("lets a browser on an allowed origin read Retry-After", async () => {
    vi.stubEnv("CORS_ORIGINS", "https://campus.example");
    const api = await start({ general: 1 });
    await send(api, "GET", "/listings");
    const res = await send(api, "GET", "/listings", { headers: { Origin: "https://campus.example" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://campus.example");
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After");
  });

  it("counts signup, login and resend-verification together, per IP", async () => {
    const api = await start({ auth: 3, general: 1000 });
    const json = { email: "nobody@example.com", password: "wrong-password" };
    expect((await send(api, "POST", "/auth/login", { json })).status).toBe(401);
    expect((await send(api, "POST", "/auth/signup", { json })).status).toBe(400);
    expect((await send(api, "POST", "/auth/resend-verification", { json })).status).toBe(200);
    expect((await send(api, "POST", "/auth/login", { json })).status).toBe(429);

    expect((await send(api, "POST", "/auth/login", { json, ip: "203.0.113.2" })).status).toBe(401);
  });

  it("can't be dodged with a different case or a trailing slash", async () => {
    const api = await start({ auth: 1, general: 1000 });
    const json = { email: "nobody@example.com", password: "wrong-password" };
    expect((await send(api, "POST", "/AUTH/Login/", { json })).status).toBe(401);
    expect((await send(api, "POST", "/auth/login", { json })).status).toBe(429);
  });

  it("limits checkout per user, wherever they connect from", async () => {
    const api = await start({ checkout: 2, general: 1000 });
    const post = (token: string, ip: string) => send(api, "POST", "/orders", { token, ip, json: { listingId: LISTING } });

    expect((await post(tokenA, "203.0.113.1")).status).not.toBe(429);
    expect((await post(tokenA, "203.0.113.2")).status).not.toBe(429);
    expect((await post(tokenA, "203.0.113.3")).status).toBe(429);
    expect((await post(tokenB, "203.0.113.1")).status).not.toBe(429);
    // Reading orders isn't checkout.
    expect((await send(api, "GET", "/orders", { token: tokenA })).status).toBe(200);
  });

  it("limits report a problem per user, but not adding photos to the report", async () => {
    const api = await start({ reportProblem: 1, general: 1000 });
    const order = randomUUID();
    const report = (token: string) => send(api, "POST", `/orders/${order}/dispute`, { token, json: { reason: "OTHER", description: "broken" } });

    expect((await report(tokenA)).status).toBe(404);
    expect((await report(tokenA)).status).toBe(429);
    expect((await report(tokenB)).status).toBe(404);
    expect((await send(api, "POST", `/orders/${order}/dispute/photos`, { token: tokenA, json: {} })).status).not.toBe(429);
  });

  it("limits chat sends per user, but not reading messages", async () => {
    const api = await start({ chatSend: 1, general: 1000 });
    const chat = (token: string) => send(api, "POST", `/chats/${LISTING}/messages`, { token, json: { body: "hi" } });

    expect((await chat(tokenA)).status).toBe(404);
    expect((await chat(tokenA)).status).toBe(429);
    expect((await chat(tokenB)).status).toBe(404);
    expect((await send(api, "GET", `/chats/${LISTING}/messages`, { token: tokenA })).status).not.toBe(429);
  });

  it("doesn't count routes with their own limit toward the general one", async () => {
    const api = await start({ chatSend: 100, general: 1 });
    for (let i = 0; i < 3; i++) expect((await send(api, "POST", `/chats/${LISTING}/messages`, { token: tokenA, json: { body: "hi" } })).status).toBe(404);
    expect((await send(api, "GET", "/listings", { token: tokenA })).status).toBe(200);
  });

  it("gives each logged-in user their own general limit on a shared IP", async () => {
    const api = await start({ general: 1 });
    expect((await send(api, "GET", "/listings", { token: tokenA })).status).toBe(200);
    expect((await send(api, "GET", "/listings", { token: tokenA })).status).toBe(429);
    expect((await send(api, "GET", "/listings", { token: tokenB })).status).toBe(200);
    expect((await send(api, "GET", "/listings")).status).toBe(200);
  });

  it("counts a forged token against the IP, so it can't get a fresh limit", async () => {
    const api = await start({ general: 1, checkout: 1000 });
    expect((await send(api, "POST", "/orders", { token: "forged-1", json: {} })).status).toBe(401);
    expect((await send(api, "POST", "/orders", { token: "forged-2", json: {} })).status).toBe(429);
  });

  it("never limits the health check or the PayPal webhook", async () => {
    const api = await start({ general: 1, auth: 1, checkout: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await send(api, "GET", "/health")).status).toBe(200);
      expect((await send(api, "POST", "/webhooks/paypal", { json: {} })).status).not.toBe(429);
    }
  });
});

describe("body limit", () => {
  it(`refuses JSON over ${JSON_BODY_LIMIT} with a JSON 413, and accepts the longest real form`, async () => {
    const api = await start({ general: 1000 });
    const huge = await send(api, "POST", `/chats/${LISTING}/messages`, { token: tokenA, json: { body: "x".repeat(40 * 1024) } });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: "Request body is too large" });

    // 2,000 characters of three-byte text, the most a listing description can be.
    const longest = await send(api, "POST", `/chats/${LISTING}/messages`, { token: tokenA, json: { body: "€".repeat(2000) } });
    expect(longest.status).toBe(404);
  });
});
