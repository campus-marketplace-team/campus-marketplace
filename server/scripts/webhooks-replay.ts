// Queues stored PayPal webhook events that were never finished (processed_at
// null) for the worker to process again, e.g. events stored before their
// handler existed. Dry run by default; pass --apply to queue them.
//
//   npm run webhooks:replay -w server            # list what would be queued
//   npm run webhooks:replay -w server -- --apply # queue them
//
// The database is shared with production, so this queues production events.

import { prisma } from "../src/db.js";
import { requeueUnprocessedWebhookEvents } from "../src/webhooks/ingest.js";

const apply = process.argv.includes("--apply");
try {
  const ids = await requeueUnprocessedWebhookEvents({ apply });
  if (ids.length === 0) console.log("No unprocessed webhook events to queue.");
  else if (apply) console.log(`Queued ${ids.length} webhook event(s) for the worker.`);
  else console.log(`${ids.length} unprocessed webhook event(s) would be queued. Run again with --apply to queue them.`);
} finally {
  await prisma.$disconnect();
}
