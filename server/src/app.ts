import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { createRateLimiters, type RateLimits } from "./http/rateLimit.js";
import { getPayPalClient, type PayPalClient } from "./paypal/client.js";
import type { Classify } from "./risk/assess.js";
import { classifyRisk } from "./risk/classifier.js";
import { createAdminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { listingsRouter } from "./routes/listings.js";
import { createOrdersRouter } from "./routes/orders.js";
import { createWebhooksRouter } from "./routes/webhooks.js";

// Origins allowed to call the API from a browser, e.g. the Vercel URL.
// Comma-separated in CORS_ORIGINS. Empty in local dev, where Vite proxies /api.
function cors(allowed: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      // Lets the client read when to retry after a 429.
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        res.sendStatus(204);
        return;
      }
    }
    next();
  };
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Client errors raised by Express itself, e.g. malformed JSON (400) or a body that's too large (413).
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status >= 400 && status < 500) {
    const message = status === 400 ? "Malformed request body" : status === 413 ? "Request body is too large" : "Bad request";
    res.status(status).json({ error: message });
    return;
  }
  console.error(err);
  // Never send internal error details (SQL, stack traces) to the client.
  res.status(500).json({ error: "Internal server error" });
};

/** Largest JSON body. Well above any real form (the longest text field is 4,000 characters), so huge text never reaches a handler. */
export const JSON_BODY_LIMIT = "32kb";

/** Tests pass a fake PayPal client and classifier, and their own rate limits; the real PayPal client is built from env on first use. */
export function createApp({
  paypal = getPayPalClient,
  classify = (input, budget) => classifyRisk(input, { budget }),
  rateLimits,
}: { paypal?: () => PayPalClient; classify?: Classify; rateLimits?: Partial<RateLimits> } = {}) {
  const app = express();
  // Render puts a proxy in front of us. Only a fallback for getClientIp, which prefers True-Client-IP.
  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  app.use(cors(allowedOrigins));
  // Before express.json(): signature verification needs the raw body.
  // Also before the rate limiter: PayPal's retries must never get a 429.
  app.use("/api/webhooks", createWebhooksRouter(paypal));

  // Cheap liveness check for the host's health checks; does not touch the DB, and isn't rate limited.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  const limiters = createRateLimiters(rateLimits);
  app.use("/api", limiters.beforeBody);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use("/api", limiters.afterBody);

  app.use("/api/auth", authRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/chats", chatRouter);
  app.use("/api/orders", createOrdersRouter(paypal, classify));
  app.use("/api/admin", createAdminRouter(paypal));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
