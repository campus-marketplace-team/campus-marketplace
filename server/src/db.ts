import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client.js";

// Runtime queries use DATABASE_URL. DATABASE_POOL_MAX optionally caps the pg
// pool (pg's default is 10); the worker sets it low because Supabase's session
// pooler allows few clients and the API shares them. With the pg adapter,
// Prisma's `connection_limit` URL parameter is ignored, so it's set here.
function poolMax(): number | undefined {
  const raw = process.env.DATABASE_POOL_MAX?.trim();
  if (!raw) return undefined;
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1) throw new Error(`DATABASE_POOL_MAX must be a positive integer, got ${raw}`);
  return max;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: poolMax() });

export const prisma = new PrismaClient({ adapter });

/** The root client or an interactive-transaction client (`tx` in prisma.$transaction). */
export type Db = PrismaClient | Prisma.TransactionClient;
