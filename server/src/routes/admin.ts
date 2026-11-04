import { Router } from "express";
import { getAdminDashboard } from "../admin/dashboard.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";

// Admin-only endpoints. Every route here needs a logged-in user with is_admin.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// GET /api/admin/dashboard  ->  orders by state, ledger money totals, orders, reconciliation flags, dead letters
adminRouter.get("/dashboard", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await getAdminDashboard());
});
