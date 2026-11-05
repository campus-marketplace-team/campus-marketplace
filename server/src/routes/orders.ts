import { Router, type Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { authorizeCheckout, CheckoutError, startCheckout } from "../orders/checkout.js";
import { issueHandoffToken, redeemHandoffToken } from "../orders/handoff.js";
import { getOrderStatus, listMyOrders } from "../orders/orderStatus.js";
import type { PayPalClient } from "../paypal/client.js";
import type { Classify } from "../risk/assess.js";

// Order endpoints. GET / and GET /:id back "My orders" and the order status
// page. The PayPal Buttons in the client call POST / from
// createOrder and POST /:id/authorize from onApprove. The QR handoff uses
// POST /:id/handoff-token (seller) and POST /handoff/scan (buyer). PayPal
// itself is only ever called from the server.

/** `getPayPal` is resolved per request so the API starts without PayPal configured. */
export function createOrdersRouter(getPayPal: () => PayPalClient, classify: Classify) {
  const router = Router();
  router.use(requireAuth);

  async function respond(res: Response, run: () => Promise<unknown>, status = 200) {
    try {
      res.status(status).json(await run());
    } catch (err) {
      if (err instanceof CheckoutError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  }

  async function handle(res: Response, run: (paypal: PayPalClient) => Promise<unknown>, status = 200) {
    let paypal: PayPalClient;
    try {
      paypal = getPayPal();
    } catch (err) {
      console.error((err as Error).message);
      res.status(503).json({ error: "Payments aren't available right now", code: "PAYPAL_NOT_CONFIGURED" });
      return;
    }
    await respond(res, () => run(paypal), status);
  }

  // GET /api/orders  — orders I bought or sold (not CREATED), newest first. Returns { orders }.
  router.get("/", (req, res) => respond(res, async () => ({ orders: await listMyOrders(req.user!.id) })));

  // GET /api/orders/:id  (the order's buyer or seller) — status page data. Returns { order }.
  router.get("/:id", (req, res) =>
    respond(res, async () => ({ order: await getOrderStatus(req.user!.id, req.params.id) })),
  );

  // POST /api/orders  { listingId }  (buyer) — assesses risk and starts checkout, returns
  // { orderId, paypalOrderId, riskWarning }, or 403 RISK_BLOCKED.
  router.post("/", (req, res) => handle(res, (paypal) => startCheckout(paypal, classify, req.user!.id, req.body?.listingId), 201));

  // POST /api/orders/:id/authorize  (the order's buyer) — after PayPal approval. Returns { order }.
  router.post("/:id/authorize", (req, res) =>
    handle(res, async (paypal) => ({ order: await authorizeCheckout(paypal, req.user!.id, req.params.id) })),
  );

  // POST /api/orders/:id/handoff-token  (the order's seller) — a fresh single-use QR token.
  // Returns { token, expiresAt }.
  router.post("/:id/handoff-token", (req, res) =>
    respond(res, () => issueHandoffToken(req.user!.id, req.params.id), 201),
  );

  // POST /api/orders/handoff/scan  { token }  (the order's buyer) — redeems the QR token and
  // captures the payment. Returns { order }.
  router.post("/handoff/scan", (req, res) =>
    handle(res, async (paypal) => ({
      order: await redeemHandoffToken(paypal, req.user!.id, req.body?.token, {
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }),
    })),
  );

  return router;
}
