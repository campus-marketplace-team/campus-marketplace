import "dotenv/config";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { getAuthConfig } from "../../src/auth/config.js";
import { hashPassword } from "../../src/auth/password.js";
import { prisma } from "../../src/db.js";
import type { RiskClassification } from "../../src/risk/classifier.js";

// API tests run the real app against the real database (DATABASE_URL), on a
// random local port. Every user they create has an email starting with
// TEST_EMAIL_PREFIX plus a per-file run id, and cleanup() deletes this file's
// users and everything they own. Test files run in parallel, so cleanup must
// not touch another file's users; leftovers from a crashed run are swept once
// they're an hour old.

export const TEST_EMAIL_PREFIX = "apitest.";
export const TEST_PASSWORD = "test-password-1";

// Vitest loads this module once per test file, so each file gets its own id.
const RUN_PREFIX = `${TEST_EMAIL_PREFIX}${randomUUID().slice(0, 8)}.`;
const STALE_AFTER_MS = 60 * 60 * 1000;

export type Api = {
  url: string;
  call: (method: string, path: string, opts?: { token?: string; json?: unknown }) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
};

/** A classifier answer of "low", so the policy's hard rules alone decide. */
export const lowRisk: RiskClassification = {
  risk: "low",
  reasons: ["test"],
  signals: [],
  source: "llm",
  fallbackReason: null,
  model: "test-model",
  rawOutput: null,
};

/**
 * Pass `paypal` to replace the real PayPal client with a fake. The classifier is
 * always faked unless a test passes another, so `npm test` never calls Claude.
 * Rate limits are effectively off unless a test passes its own, since every test
 * shares one IP and these suites log in far more than a real user would.
 */
const NO_LIMIT = { max: 1_000_000, windowMs: 60_000 };

export async function startApi(options: Parameters<typeof createApp>[0] = {}): Promise<Api> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const rateLimits = { auth: NO_LIMIT, checkout: NO_LIMIT, reportProblem: NO_LIMIT, chatSend: NO_LIMIT, general: NO_LIMIT, ...options.rateLimits };
  const server = createApp({ classify: async () => lowRisk, ...options, rateLimits }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  return {
    url,
    async call(method, path, { token, json } = {}) {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (json !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A unique address on the first allowed school domain. */
export function schoolEmail(label: string) {
  return `${RUN_PREFIX}${label}.${randomUUID().slice(0, 8)}@${getAuthConfig().allowedEmailDomains[0]}`;
}

/** Creates a user directly in the DB (verified unless told otherwise) with TEST_PASSWORD. */
export async function createTestUser(label: string, { verified = true } = {}) {
  return prisma.user.create({
    data: {
      email: schoolEmail(label),
      displayName: `Test ${label}`,
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: verified ? new Date() : null,
    },
    select: { id: true, email: true },
  });
}

export async function login(api: Api, email: string): Promise<string> {
  const res = await api.call("POST", "/auth/login", { json: { email, password: TEST_PASSWORD } });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Deletes this file's test users (and stale ones) with the orders, QR tokens and scans, notifications, outbox rows, listings and messages that reference them. */
export async function cleanup() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { startsWith: RUN_PREFIX } },
        { email: { startsWith: TEST_EMAIL_PREFIX }, createdAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      ],
    },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    const listings = { sellerId: { in: ids } };
    const orders = { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }, { listing: listings }] };
    await prisma.$transaction([
      prisma.chatMessage.deleteMany({
        where: { OR: [{ senderId: { in: ids } }, { recipientId: { in: ids } }, { listing: listings }] },
      }),
      // QR scans and tokens reference orders and users, so they go first.
      prisma.qrScan.deleteMany({ where: { OR: [{ scannerId: { in: ids } }, { order: orders }] } }),
      prisma.qrToken.deleteMany({ where: { OR: [{ sellerId: { in: ids } }, { usedById: { in: ids } }, { order: orders }] } }),
      prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { order: orders }] } }),
      prisma.reconciliationFlag.deleteMany({ where: { order: orders } }),
      // Outbox rows would otherwise outlive their order (order_id ON DELETE SET NULL).
      prisma.outboxEvent.deleteMany({ where: { order: orders } }),
      // So would decisions (order_id and listing_id ON DELETE SET NULL).
      prisma.decision.deleteMany({ where: { OR: [{ order: orders }, { listing: listings }] } }),
      prisma.dispute.deleteMany({ where: { OR: [{ openedById: { in: ids } }, { order: orders }] } }),
      prisma.order.deleteMany({ where: orders }),
      prisma.listing.deleteMany({ where: listings }),
      prisma.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
  }
}

export { prisma };
