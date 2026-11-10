import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JSON_BODY_LIMIT } from "../src/app.js";
import { getClientIp } from "../src/http/clientIp.js";
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
      authEmail: { max: 10, windowMs: 15 * MINUTE },
      authIp: { max: 50, windowMs: 15 * MINUTE },
      signup: { max: 20, windowMs: 15 * MINUTE },
      checkout: { max: 10, windowMs: 60 * MINUTE },
      riskCheck: { max: 10, windowMs: 60 * MINUTE },
      reportProblem: { max: 5, windowMs: 60 * MINUTE },
      chatSend: { max: 30, windowMs: MINUTE },
      chatUnread: { max: 120, windowMs: 15 * MINUTE },
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

  describe("login and resend-verification", () => {
    const loginAs = (api: Api, email: string, ip?: string) => send(api, "POST", "/auth/login", { ip, json: { email, password: "wrong-password" } });

    it("doesn't share the limit between two emails on the same IP", async () => {
      const api = await start({ authEmail: 2, authIp: 1000 });
      expect((await loginAs(api, "first@example.com")).status).toBe(401);
      expect((await loginAs(api, "first@example.com")).status).toBe(401);
      expect((await loginAs(api, "first@example.com")).status).toBe(429);
      expect((await loginAs(api, "second@example.com")).status).toBe(401);
    });

    it("shares the limit for one email across different IPs", async () => {
      const api = await start({ authEmail: 2, authIp: 1000 });
      expect((await loginAs(api, "same@example.com", "203.0.113.1")).status).toBe(401);
      expect((await loginAs(api, "same@example.com", "203.0.113.2")).status).toBe(401);
      expect((await loginAs(api, "same@example.com", "203.0.113.3")).status).toBe(429);
    });

    it("counts login and resend-verification together per email", async () => {
      const api = await start({ authEmail: 1, authIp: 1000 });
      expect((await send(api, "POST", "/auth/resend-verification", { json: { email: "both@example.com" } })).status).toBe(200);
      expect((await loginAs(api, "both@example.com")).status).toBe(429);
    });

    it("treats differently spelled addresses as the same email", async () => {
      const api = await start({ authEmail: 1, authIp: 1000 });
      expect((await loginAs(api, "spelled@example.com")).status).toBe(401);
      expect((await loginAs(api, "  SPELLED@Example.com ")).status).toBe(429);
    });

    it("stops one IP trying many emails with the looser backstop, without affecting other IPs", async () => {
      const api = await start({ authEmail: 1000, authIp: 2 });
      expect((await loginAs(api, "a@example.com")).status).toBe(401);
      expect((await send(api, "POST", "/auth/resend-verification", { json: { email: "b@example.com" } })).status).toBe(200);
      expect((await loginAs(api, "c@example.com")).status).toBe(429);
      expect((await loginAs(api, "c@example.com", "203.0.113.2")).status).toBe(401);
    });

    it("counts a missing or invalid email against the backstop only", async () => {
      const api = await start({ authEmail: 1, authIp: 2 });
      expect((await send(api, "POST", "/auth/login", { json: { email: "not-an-email", password: "x" } })).status).toBe(401);
      expect((await send(api, "POST", "/auth/login", { json: { password: "x" } })).status).toBe(401);
      expect((await send(api, "POST", "/auth/login", { json: { password: "x" } })).status).toBe(429);
    });

    it("can't be dodged with a different case or a trailing slash", async () => {
      const api = await start({ authEmail: 1, authIp: 1000 });
      const json = { email: "nobody@example.com", password: "wrong-password" };
      expect((await send(api, "POST", "/AUTH/Login/", { json })).status).toBe(401);
      expect((await send(api, "POST", "/auth/login", { json })).status).toBe(429);
    });

    it("answers the same for an email with no account, so a 429 doesn't reveal which exist", async () => {
      const api = await start({ authEmail: 1, authIp: 1000 });
      const { email } = await createTestUser("limit-existing");
      await loginAs(api, email);
      await loginAs(api, "missing@example.com");
      const [existing, missing] = [await loginAs(api, email), await loginAs(api, "missing@example.com")];
      expect([existing.status, missing.status]).toEqual([429, 429]);
      expect((await existing.json()).error).toBe((await missing.json()).error);
    });
  });

  describe("signup", () => {
    const signup = (api: Api, email: string, ip?: string) => send(api, "POST", "/auth/signup", { ip, json: { email, password: "short" } });

    it("limits per IP only, and separately from login", async () => {
      const api = await start({ signup: 2, authEmail: 1000, authIp: 1000 });
      expect((await signup(api, "one@example.com")).status).toBe(400);
      expect((await signup(api, "two@example.com")).status).toBe(400);
      expect((await signup(api, "three@example.com")).status).toBe(429);
      expect((await signup(api, "three@example.com", "203.0.113.2")).status).toBe(400);
      expect((await send(api, "POST", "/auth/login", { json: { email: "one@example.com", password: "x" } })).status).toBe(401);
    });
  });

  describe("client IP", () => {
    it("prefers True-Client-IP over the proxy's address", async () => {
      const api = await start({ general: 1 });
      const fromClient = (client: string) => send(api, "GET", "/listings", { ip: "10.0.0.1", headers: { "True-Client-IP": client } });
      expect((await fromClient("203.0.113.1")).status).toBe(200);
      expect((await fromClient("203.0.113.1")).status).toBe(429);
      expect((await fromClient("203.0.113.2")).status).toBe(200);
    });

    it("falls back to req.ip when the header is absent or not one valid IP", () => {
      const req = (header?: string) => ({ ip: "198.51.100.7", headers: header === undefined ? {} : { "true-client-ip": header } });
      expect(getClientIp(req())).toBe("198.51.100.7");
      expect(getClientIp(req("not-an-ip"))).toBe("198.51.100.7");
      expect(getClientIp(req("203.0.113.1, 203.0.113.2"))).toBe("198.51.100.7");
      expect(getClientIp(req(""))).toBe("198.51.100.7");
      expect(getClientIp(req(" 2001:db8::1 "))).toBe("2001:db8::1");
    });
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

  it("limits Check & buy per user, apart from checkout", async () => {
    const api = await start({ riskCheck: 1, checkout: 1000, general: 1000 });
    const assess = (token: string, path = "/orders/assess") => send(api, "POST", path, { token, json: { listingId: LISTING } });

    expect((await assess(tokenA)).status).not.toBe(429);
    expect((await assess(tokenA)).status).toBe(429);
    expect((await assess(tokenA, "/Orders/Assess/")).status).toBe(429);
    expect((await assess(tokenB)).status).not.toBe(429);
    // Paying has its own count.
    expect((await send(api, "POST", "/orders", { token: tokenA, json: { listingId: LISTING } })).status).not.toBe(429);
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

  it("gives the unread badge poll its own per-user limit, separate from general and chat", async () => {
    const api = await start({ chatUnread: 2, chatSend: 1, general: 1 });
    const unread = (token: string) => send(api, "GET", "/chats/unread-count", { token });

    expect((await unread(tokenA)).status).toBe(200);
    expect((await unread(tokenA)).status).toBe(200);
    expect((await unread(tokenA)).status).toBe(429);
    expect((await unread(tokenB)).status).toBe(200);
    // Polling the badge used none of tokenA's general or chat-send allowance.
    expect((await send(api, "GET", "/listings", { token: tokenA })).status).toBe(200);
    expect((await send(api, "POST", `/chats/${LISTING}/messages`, { token: tokenA, json: { body: "hi" } })).status).toBe(404);
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
    const api = await start({ general: 1, authEmail: 1, authIp: 1, checkout: 1 });
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
