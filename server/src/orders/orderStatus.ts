import { prisma } from "../db.js";
import { isUuid } from "../ids.js";
import { latestRiskOutcome, latestRiskReasons } from "../risk/assess.js";
import { CheckoutError, orderView } from "./checkout.js";
import { getDisputeView } from "./dispute.js";

// Read-only order views for the order status page and the "My orders" list.
// Only the order's buyer and seller can see it; anyone else gets a 404.

const statusView = {
  ...orderView,
  buyerId: true,
  sellerId: true,
  platformFeeCents: true,
  createdAt: true,
  listing: { select: { id: true, title: true, photoUrls: true } },
  buyer: { select: { displayName: true } },
  seller: { select: { displayName: true } },
} as const;

type StatusRow = Awaited<ReturnType<typeof findStatusRow>>;

function findStatusRow(id: string) {
  return prisma.order.findUnique({ where: { id }, select: statusView });
}

/** Drops the user ids and adds which side of the order the viewer is on. */
function toView(order: NonNullable<StatusRow>, userId: string) {
  const { buyerId, sellerId, ...rest } = order;
  return { ...rest, role: sellerId === userId ? ("seller" as const) : ("buyer" as const) };
}

/** One order, for its buyer or seller. */
export async function getOrderStatus(userId: string, orderId: unknown) {
  const order = isUuid(orderId) ? await findStatusRow(orderId) : null;
  // Someone else's order looks the same as a missing one.
  if (!order || (order.buyerId !== userId && order.sellerId !== userId)) {
    throw new CheckoutError(404, "NOT_FOUND", "Order not found");
  }
  const view = toView(order, userId);
  // Only the buyer is warned. The seller just sees the later deadline.
  const riskWarning = view.role === "buyer" && (await latestRiskOutcome(prisma, order.id)) === "HOLD_WITH_WARNING";
  const riskReasons = riskWarning ? await latestRiskReasons(prisma, order.id) : [];
  return { ...view, riskWarning, riskReasons, dispute: await getDisputeView(order.id) };
}

const LIST_LIMIT = 100;

/**
 * Orders I bought or sold, newest first. CREATED orders are left out: the
 * buyer never finished paying, so there's nothing to hand off.
 */
export async function listMyOrders(userId: string) {
  const orders = await prisma.order.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }], state: { not: "CREATED" } },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: statusView,
  });
  return orders.map((order) => toView(order, userId));
}
