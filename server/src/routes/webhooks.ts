import express, { Router } from "express";
import type { PayPalClient } from "../paypal/client.js";
import { getPayPalWebhookId, ingestPayPalWebhook, signatureHeaders } from "../webhooks/ingest.js";

// POST /api/webhooks/paypal — called by PayPal, not by users, so no requireAuth:
// every event is verified with PayPal instead (src/webhooks/ingest.ts).
// Mounted before express.json() because verification needs the raw body.

const MAX_WEBHOOK_BODY = "256kb";

export function createWebhooksRouter(getPayPal: () => PayPalClient) {
  const router = Router();

  router.post("/paypal", express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY }), async (req, res) => {
    let paypal: PayPalClient;
    try {
      paypal = getPayPal();
    } catch (err) {
      console.error("webhook:", (err as Error).message);
      res.status(503).json({ error: "Webhooks aren't configured" });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const result = await ingestPayPalWebhook(paypal, {
      webhookId: getPayPalWebhookId(),
      headers: signatureHeaders((name) => req.get(name)),
      rawBody,
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
