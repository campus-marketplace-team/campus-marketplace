import { Router, type Response } from "express";
import { getAdminDashboard } from "../admin/dashboard.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { approveDisputeDecision, rejectDisputeDecision, resolveEscalatedDispute } from "../disputes/actionTools.js";
import { CheckoutError } from "../orders/checkout.js";
import type { PayPalClient } from "../paypal/client.js";

/** Admin-only endpoints. Every route here needs a logged-in user with is_admin. */
export function createAdminRouter(getPayPal: () => PayPalClient) {
  const router = Router();
  router.use(requireAuth, requireAdmin);

  async function respond(res: Response, run: () => Promise<unknown>) {
    try {
      res.json(await run());
    } catch (err) {
      if (err instanceof CheckoutError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  }

  /** `getPayPal` is resolved per request, so the API starts without PayPal configured. */
  async function withPayPal(res: Response, run: (paypal: PayPalClient) => Promise<unknown>) {
    let paypal: PayPalClient;
    try {
      paypal = getPayPal();
    } catch (err) {
      console.error((err as Error).message);
      res.status(503).json({ error: "Payments aren't available right now", code: "PAYPAL_NOT_CONFIGURED" });
      return;
    }
    await respond(res, () => run(paypal));
  }

  // GET /api/admin/dashboard  ->  orders by state, ledger money totals, orders, reconciliation flags, dead letters, dispute decisions waiting, AI decision records
  router.get("/dashboard", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAdminDashboard());
  });

  // POST /api/admin/dispute-decisions/:id/approve  ->  { decision }, whose actionStatus says how it went
  router.post("/dispute-decisions/:id/approve", (req, res) =>
    withPayPal(res, async (paypal) => ({ decision: await approveDisputeDecision(paypal, req.params.id, req.user!.id) })),
  );

  // POST /api/admin/dispute-decisions/:id/reject  { note? }  ->  { decision }
  router.post("/dispute-decisions/:id/reject", (req, res) =>
    respond(res, async () => ({ decision: await rejectDisputeDecision(req.params.id, req.user!.id, req.body?.note) })),
  );

  // POST /api/admin/disputes/:orderId/resolve  { action, refundCents?, reasoning }  ->  { decision }, for escalated disputes
  router.post("/disputes/:orderId/resolve", (req, res) =>
    withPayPal(res, async (paypal) => ({ decision: await resolveEscalatedDispute(paypal, req.params.orderId, req.body, req.user!.id) })),
  );

  return router;
}
