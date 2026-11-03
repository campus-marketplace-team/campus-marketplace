import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { getPayPalClient, type PayPalClient } from "./paypal/client.js";
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

/** Tests pass a fake PayPal client; the real one is built from env on first use. */
export function createApp({ paypal = getPayPalClient }: { paypal?: () => PayPalClient } = {}) {
  const app = express();
  // Render puts one proxy in front of us; trust it so req.ip is the real client IP (scan logs).
  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  app.use(cors(allowedOrigins));
  // Before express.json(): signature verification needs the raw body.
  app.use("/api/webhooks", createWebhooksRouter(paypal));
  app.use(express.json());

  // Cheap liveness check for the host's health checks; does not touch the DB.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/listings", listingsRouter);
  app.use("/api/chats", chatRouter);
  app.use("/api/orders", createOrdersRouter(paypal));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
