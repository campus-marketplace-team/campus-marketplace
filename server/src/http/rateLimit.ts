import type { Request, RequestHandler } from "express";
import { type AugmentedRequest, ipKeyGenerator, rateLimit } from "express-rate-limit";
import { normalizeEmail } from "../auth/email.js";
import { verifySessionToken } from "../auth/tokens.js";
import { getClientIp } from "./clientIp.js";

// HTTP rate limits for everything under /api. Health checks and PayPal webhooks are
// mounted ahead of this in app.ts, so they're never limited. Counters live in this
// process's memory: the API runs as one instance, and a restart resets them.

export type RateLimitRule = { max: number; windowMs: number };

const MINUTE = 60 * 1000;

export const DEFAULT_RATE_LIMITS = {
  /** Login and resend-verification share one count per email, so a shared or wrong IP can't lock everyone out together. */
  authEmail: { max: 10, windowMs: 15 * MINUTE },
  /** Login and resend-verification together, per IP: a looser backstop against trying many emails. */
  authIp: { max: 50, windowMs: 15 * MINUTE },
  signup: { max: 20, windowMs: 15 * MINUTE },
  checkout: { max: 10, windowMs: 60 * MINUTE },
  /** "Check & buy", which can cost a Claude call: as strict as checkout, counted apart so checking doesn't use up paying. */
  riskCheck: { max: 10, windowMs: 60 * MINUTE },
  reportProblem: { max: 5, windowMs: 60 * MINUTE },
  chatSend: { max: 30, windowMs: MINUTE },
  /** The nav badge's poll (every 30 s plus tab focus), kept out of `general` so it never crowds out chat polling. */
  chatUnread: { max: 120, windowMs: 15 * MINUTE },
  /** Per user when logged in, otherwise per IP, so students sharing campus wifi don't share a limit. */
  general: { max: 300, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimits = Record<keyof typeof DEFAULT_RATE_LIMITS, RateLimitRule>;

// Paths relative to /api. Case-insensitive and with an optional trailing slash, because
// Express routes match that way too and a variant mustn't dodge its limit.
const LOGIN_OR_RESEND_ROUTE = /^\/auth\/(login|resend-verification)\/?$/i;
const SIGNUP_ROUTE = /^\/auth\/signup\/?$/i;
const CHECKOUT_ROUTE = /^\/orders\/?$/i;
const RISK_CHECK_ROUTE = /^\/orders\/assess\/?$/i;
const REPORT_PROBLEM_ROUTE = /^\/orders\/[^/]+\/dispute\/?$/i;
const CHAT_SEND_ROUTE = /^\/chats\/[^/]+\/messages\/?$/i;
const CHAT_UNREAD_ROUTE = /^\/chats\/unread-count\/?$/i;

function perUserBucket({ method, path }: Request): "checkout" | "riskCheck" | "reportProblem" | "chatSend" | "chatUnread" | null {
  if (method === "GET" && CHAT_UNREAD_ROUTE.test(path)) return "chatUnread";
  if (method !== "POST") return null;
  if (CHECKOUT_ROUTE.test(path)) return "checkout";
  if (RISK_CHECK_ROUTE.test(path)) return "riskCheck";
  if (REPORT_PROBLEM_ROUTE.test(path)) return "reportProblem";
  if (CHAT_SEND_ROUTE.test(path)) return "chatSend";
  return null;
}

/** The session's user id, from the token alone. No database read: this runs on every request. */
async function sessionUserId(req: Request): Promise<string | null> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token ? verifySessionToken(token) : null;
}

const limiter = ({ max, windowMs }: RateLimitRule) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (_req, res) => res.locals.rateLimitKey as string,
    handler: (req, res) => {
      const resetAt = (req as AugmentedRequest).rateLimit?.resetTime?.getTime() ?? Date.now() + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many requests. Please try again later.", code: "RATE_LIMITED", retryAfterSeconds });
    },
  });

/**
 * Two middlewares, both for mounting at /api. `beforeBody` goes ahead of body parsing, so
 * a refused request costs as little as possible. `afterBody` goes after it, because the
 * per-email limit has to read the email.
 */
export function createRateLimiters(overrides: Partial<RateLimits> = {}): { beforeBody: RequestHandler; afterBody: RequestHandler } {
  const rules: RateLimits = { ...DEFAULT_RATE_LIMITS, ...overrides };
  const limiters = {
    authEmail: limiter(rules.authEmail),
    authIp: limiter(rules.authIp),
    signup: limiter(rules.signup),
    checkout: limiter(rules.checkout),
    riskCheck: limiter(rules.riskCheck),
    reportProblem: limiter(rules.reportProblem),
    chatSend: limiter(rules.chatSend),
    chatUnread: limiter(rules.chatUnread),
    general: limiter(rules.general),
  };

  const beforeBody: RequestHandler = async (req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    const ipKey = `ip:${ipKeyGenerator(getClientIp(req) ?? "unknown")}`;
    if (req.method === "POST" && (LOGIN_OR_RESEND_ROUTE.test(req.path) || SIGNUP_ROUTE.test(req.path))) {
      res.locals.rateLimitKey = ipKey;
      await (SIGNUP_ROUTE.test(req.path) ? limiters.signup : limiters.authIp)(req, res, next);
      return;
    }

    const userId = await sessionUserId(req);
    const bucket = userId ? perUserBucket(req) : null;
    // Without a valid session these routes answer 401, counted against the IP like any other request.
    res.locals.rateLimitKey = userId ? `user:${userId}` : ipKey;
    await limiters[bucket ?? "general"](req, res, next);
  };

  const afterBody: RequestHandler = async (req, res, next) => {
    // The same normalization as the routes, so spelling an address differently isn't a new limit.
    const email = req.method === "POST" && LOGIN_OR_RESEND_ROUTE.test(req.path) ? normalizeEmail(req.body?.email) : null;
    if (!email) {
      next();
      return;
    }
    res.locals.rateLimitKey = `email:${email}`;
    await limiters.authEmail(req, res, next);
  };

  return { beforeBody, afterBody };
}
