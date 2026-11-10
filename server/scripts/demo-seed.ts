// Demo data (task 5.3): one completed sale, one blocked scam listing and one open
// dispute, as described in prisma/demoData.ts. Run it by hand, after the regular
// seed and after the demo photos are deployed:
//
//   npm run seed:demo -w server
//
// Everything goes through the app's own code against the PayPal sandbox, so the
// PayPal ids are real and reconciliation agrees with the ledger. The sale and
// the dispute each need a buyer to approve the payment in PayPal: the script
// prints two links, you log in with a PayPal sandbox personal account, approve,
// and it carries on by itself.
//
// The database is shared with production. Rerunning is safe: each scenario
// checks how far it got and only does what's missing.
//
// Needs, in server/.env: the PayPal sandbox credentials (PAYPAL_BASE_URL must be
// the sandbox), ANTHROPIC_API_KEY for the risk classifier, and
// DEMO_SELLER_PAYPAL_EMAIL, a PayPal sandbox personal account that receives the
// seller's payout. Without it the sale is captured but never paid out.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password.js";
import { prisma } from "../src/db.js";
import { authorizeCheckout, CheckoutError, startCheckout } from "../src/orders/checkout.js";
import { openDispute } from "../src/orders/dispute.js";
import { issueHandoffToken, redeemHandoffToken } from "../src/orders/handoff.js";
import { DISPUTE_PHOTO_GRACE_MS } from "../src/outbox/handlers.js";
import { getPayPalClient, getPayPalConfig, isSandboxBaseUrl, type PayPalClient } from "../src/paypal/client.js";
import { NEW_SELLER_DAYS } from "../src/risk/policy.js";
import { classifyRisk } from "../src/risk/classifier.js";
import type { Classify } from "../src/risk/assess.js";
import { DEMO_DISPUTE_REPORT, DEMO_NEW_USER, DEMO_SCENARIOS, type DemoScenario } from "../prisma/demoData.js";
import { planDemoScenario, type DemoOrder } from "../prisma/demoResume.js";
import { seedPhotoPath } from "../prisma/seedListings.js";

/** Same dev-only password as prisma/seed.ts. Sandbox test data, not a secret. */
const SEED_PASSWORD = "password123";

const IMAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../client/public/images");
const APPROVAL_POLL_MS = 5000;
const APPROVAL_TIMEOUT_MS = 20 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same classifier call the API makes at checkout, charged to the buyer's Claude budget. */
const classify: Classify = (input, budget) => classifyRisk(input, { budget });

type Parties = { buyerId: string; sellerId: string };

async function userId(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`${email} doesn't exist. Run the regular seed first: npm run seed -w server`);
  return user.id;
}

async function parties(scenario: DemoScenario): Promise<Parties> {
  return { buyerId: await userId(scenario.buyerEmail), sellerId: await userId(scenario.listing.sellerEmail) };
}

async function ensureNewSeller() {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_NEW_USER.email }, select: { createdAt: true } });
  if (existing) return existing.createdAt;
  const user = await prisma.user.create({
    data: { ...DEMO_NEW_USER, emailVerifiedAt: new Date(), passwordHash: await hashPassword(SEED_PASSWORD) },
    select: { createdAt: true },
  });
  console.log(`Created ${DEMO_NEW_USER.displayName} (${DEMO_NEW_USER.email}), the scam seller.`);
  return user.createdAt;
}

/** Created once, for sale. An existing listing is left as it is (it may be reserved or sold by now). */
async function ensureListing(scenario: DemoScenario, sellerId: string) {
  const l = scenario.listing;
  if (!existsSync(join(IMAGES_DIR, `${l.slug}.webp`))) {
    console.warn(`  ! client/public/images/${l.slug}.webp is missing: run scripts/fetchListingImages.ts, and deploy it.`);
  }
  const { count } = await prisma.listing.createMany({
    data: [
      {
        id: l.id,
        sellerId,
        title: l.title,
        description: l.description,
        category: l.category,
        priceCents: l.priceCents,
        photoUrls: [seedPhotoPath(l.slug)],
        status: "ACTIVE",
      },
    ],
    skipDuplicates: true,
  });
  if (count) console.log(`  Listed "${l.title}".`);
}

/**
 * The scenario's chat, unless the buyer and seller already talked about this
 * listing. Same rules as POST /api/chats/:listingId/messages: the buyer writes
 * first, on a listing that's still for sale.
 */
async function ensureChat(scenario: DemoScenario, { buyerId, sellerId }: Parties) {
  const listingId = scenario.listing.id;
  const talked = await prisma.chatMessage.count({
    where: { listingId, OR: [{ senderId: buyerId, recipientId: sellerId }, { senderId: sellerId, recipientId: buyerId }] },
  });
  if (talked > 0) return;
  // A few minutes apart, oldest first, so they read as a conversation.
  const start = Date.now() - scenario.chat.length * 3 * 60 * 1000;
  for (const [i, line] of scenario.chat.entries()) {
    const fromBuyer = line.from === "buyer";
    await prisma.chatMessage.create({
      data: {
        listingId,
        senderId: fromBuyer ? buyerId : sellerId,
        recipientId: fromBuyer ? sellerId : buyerId,
        body: line.body,
        createdAt: new Date(start + i * 3 * 60 * 1000),
      },
    });
  }
  console.log(`  Added ${scenario.chat.length} chat messages.`);
}

/** The listing's status and every order on it, from any buyer: what planDemoScenario decides from. */
async function listingOrders(scenario: DemoScenario) {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: scenario.listing.id }, select: { status: true } });
  const rows = await prisma.order.findMany({
    where: { listingId: scenario.listing.id },
    select: { id: true, state: true, createdAt: true, buyer: { select: { email: true } } },
  });
  const orders: DemoOrder[] = rows.map((o) => ({ id: o.id, state: o.state, createdAt: o.createdAt, buyerEmail: o.buyer.email }));
  return { listingStatus: listing.status, orders };
}

// ---------- Scam: blocked before PayPal is called ----------

async function runScam() {
  const scenario = DEMO_SCENARIOS.scam;
  console.log("\nScam listing");
  const sellerCreated = await ensureNewSeller();
  const p = await parties(scenario);
  await ensureListing(scenario, p.sellerId);

  const blocked = await prisma.decision.findFirst({
    where: { kind: "RISK", outcome: "BLOCKED", listingId: scenario.listing.id, order: { buyerId: p.buyerId } },
    select: { orderId: true },
  });
  if (blocked) {
    console.log(`  Already blocked (order ${blocked.orderId}).`);
    return;
  }
  const ageDays = (Date.now() - sellerCreated.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays >= NEW_SELLER_DAYS) {
    console.warn(`  ! ${DEMO_NEW_USER.email} is ${Math.floor(ageDays)} days old, so the new-seller rule won't fire; the classifier alone decides.`);
  }

  await ensureChat(scenario, p);
  try {
    const { riskWarning } = await startCheckout(getPayPalClient(), classify, p.buyerId, scenario.listing.id);
    throw new Error(
      `The scam checkout wasn't blocked (${riskWarning ? "warning only" : "normal"}). A PayPal order was created but nothing was approved or held; it expires on its own.`,
    );
  } catch (err) {
    if (!(err instanceof CheckoutError) || err.code !== "RISK_BLOCKED") throw err;
  }
  const decision = await prisma.decision.findFirst({
    where: { kind: "RISK", listingId: scenario.listing.id, order: { buyerId: p.buyerId } },
    orderBy: { createdAt: "desc" },
    select: { risk: true, evidence: true },
  });
  const rules = (decision?.evidence as { hardRules?: string[] } | null)?.hardRules ?? [];
  console.log(`  Blocked at checkout: risk ${decision?.risk}, hard rules ${rules.join(", ") || "none"}. PayPal was never called.`);
}

// ---------- Sale and dispute: real sandbox authorizations ----------

type Prepared = { key: "sale" | "dispute"; scenario: DemoScenario; parties: Parties; orderId: string; paypalOrderId: string | null };

const PLAN_NOTE: Record<"finish" | "wait" | "done", Record<"sale" | "dispute", string>> = {
  finish: { sale: "resuming: next is the QR scan and capture", dispute: "resuming: next is the dispute report" },
  wait: { sale: "nothing to do here: the worker sends the seller's payout", dispute: "" },
  done: { sale: "the sale is complete", dispute: "the dispute is open" },
};

/**
 * Gets the scenario's order as far as AUTHORIZED, except for the buyer's approval
 * in PayPal, or picks up an order that's already further along. Returns null,
 * after saying why, when the scenario can't continue (see planDemoScenario).
 */
async function prepare(key: "sale" | "dispute", paypal: PayPalClient): Promise<Prepared | null> {
  const scenario = DEMO_SCENARIOS[key];
  console.log(`\n${key === "sale" ? "Completed sale" : "Open dispute"}`);
  const p = await parties(scenario);
  await ensureListing(scenario, p.sellerId);

  const { listingStatus, orders } = await listingOrders(scenario);
  const plan = planDemoScenario(key, scenario.buyerEmail, listingStatus, orders);
  if (plan.step === "stuck") {
    console.error(`  ! Can't continue: ${plan.reason}`);
    if (plan.order) console.error(`    ${scenario.buyerEmail}'s own latest order is ${plan.order.id} (${plan.order.state}).`);
    return null;
  }
  if (plan.step !== "start") {
    console.log(`  Order ${plan.order.id} is ${plan.order.state}: ${PLAN_NOTE[plan.step][key]}.`);
    return { key, scenario, parties: p, orderId: plan.order.id, paypalOrderId: null };
  }

  await ensureChat(scenario, p);
  // Reuses an unpaid CREATED order (and its PayPal order) if there is one.
  const { orderId, paypalOrderId, riskWarning } = await startCheckout(paypal, classify, p.buyerId, scenario.listing.id);
  console.log(`  Order ${orderId}: risk check passed${riskWarning ? " with a warning (longer hold)" : ""}, PayPal order ${paypalOrderId}.`);
  return { key, scenario, parties: p, orderId, paypalOrderId };
}

const approveUrl = (paypalOrderId: string) => `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(paypalOrderId)}`;

/**
 * Waits for the buyer to approve each PayPal order, then authorizes it once.
 * Polls PayPal's read-only order status rather than retrying authorize, whose
 * PayPal-Request-Id would replay an early "not approved".
 */
async function authorizeAll(paypal: PayPalClient, waiting: Prepared[]) {
  if (waiting.length === 0) return;
  console.log("\nApprove each payment in PayPal, logged in as a sandbox *personal* account:");
  for (const w of waiting) console.log(`  ${w.key.padEnd(8)} ${w.scenario.listing.title}: ${approveUrl(w.paypalOrderId!)}`);
  console.log("Waiting for the approvals (checks every 5 s, gives up after 20 min; rerun to pick up where it left off)...");

  const left = new Set(waiting);
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (left.size > 0 && Date.now() < deadline) {
    for (const w of [...left]) {
      const { status } = await paypal.getCheckoutOrder({ paypalOrderId: w.paypalOrderId! });
      if (status === "APPROVED") {
        await authorizeCheckout(paypal, w.parties.buyerId, w.orderId);
        console.log(`  ${w.key}: approved and authorized. The money is on hold.`);
        left.delete(w);
      } else if (status === "VOIDED") {
        throw new Error(`PayPal order ${w.paypalOrderId} was voided before approval. Rerun to start a new one.`);
      }
    }
    if (left.size > 0) await sleep(APPROVAL_POLL_MS);
  }
  if (left.size > 0) throw new Error("Timed out waiting for approval. Rerun the script to get the links again.");
}

async function stateOf(orderId: string) {
  return (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true } })).state;
}

async function finishSale(paypal: PayPalClient, w: Prepared) {
  if ((await stateOf(w.orderId)) !== "AUTHORIZED") return;
  // The seller shows the QR code and the buyer scans it: the same two calls as the app.
  const { token } = await issueHandoffToken(w.parties.sellerId, w.orderId);
  await redeemHandoffToken(paypal, w.parties.buyerId, token, { userAgent: "demo-seed script" });
  console.log("\nSale: QR scanned and captured. The worker sends the seller's payout next.");
}

async function finishDispute(w: Prepared) {
  if ((await stateOf(w.orderId)) !== "AUTHORIZED") return;
  await openDispute(w.parties.buyerId, w.orderId, DEMO_DISPUTE_REPORT);
  console.log(`\nDispute: reported. The worker's dispute agent reviews it in about ${DISPUTE_PHOTO_GRACE_MS / 60_000} minutes.`);
}

async function ensureSellerPayoutEmail(sellerEmail: string) {
  const receiver = (process.env.DEMO_SELLER_PAYPAL_EMAIL ?? "").trim();
  if (!receiver) {
    console.warn(`! DEMO_SELLER_PAYPAL_EMAIL isn't set, so ${sellerEmail} has no payout address: the sale will be captured but not paid out.`);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) throw new Error("DEMO_SELLER_PAYPAL_EMAIL isn't an email address");
  await prisma.user.update({ where: { email: sellerEmail }, data: { paypalEmail: receiver } });
}

async function main() {
  if (!isSandboxBaseUrl(getPayPalConfig()?.baseUrl)) {
    throw new Error("The demo seed only runs against the PayPal sandbox: set PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com");
  }
  const paypal = getPayPalClient();
  await ensureSellerPayoutEmail(DEMO_SCENARIOS.sale.listing.sellerEmail);

  await runScam();
  // A stuck scenario doesn't stop the other one; the script still exits non-zero.
  const [sale, dispute] = [await prepare("sale", paypal), await prepare("dispute", paypal)];
  const prepared = [sale, dispute].filter((w): w is Prepared => w !== null);
  await authorizeAll(paypal, prepared.filter((w) => w.paypalOrderId !== null));
  if (sale) await finishSale(paypal, sale);
  if (dispute) await finishDispute(dispute);

  console.log("\nWhere each one stands:");
  for (const w of prepared) console.log(`  ${w.key.padEnd(8)} order ${w.orderId}: ${await stateOf(w.orderId)}`);
  if (prepared.length < 2) {
    console.error("\nAt least one scenario couldn't continue (see the ! lines above). Nothing was changed for it.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nLog in as seed.alex.chen@mcmaster.ca (password ${SEED_PASSWORD}, admin) to see them on /admin.`);
  console.log("The sale reaches PAID_OUT once the worker's payout goes through; the dispute agent's proposal waits in the approval queue.");
}

main()
  .catch((err) => {
    console.error(`\nDemo seed stopped: ${err instanceof CheckoutError ? `${err.message} (${err.code})` : (err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
