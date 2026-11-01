import "dotenv/config";

// Imported first by index.ts: ES modules run in import order, so this is set
// before server/jobs creates its Prisma client and reads DATABASE_POOL_MAX.
// Supabase's session pooler allows 15 clients, shared with the API.

/** Max DB connections for each of the worker's two pools (Prisma and pg-boss). */
export const WORKER_DB_POOL_MAX = 2;

process.env.DATABASE_POOL_MAX = String(WORKER_DB_POOL_MAX);
