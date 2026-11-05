import Anthropic from "@anthropic-ai/sdk";
import { type Db, prisma } from "../db.js";

// The one way to call Claude. callClaude reserves budget first, so concurrent
// requests can't pass the limit, then sends the request with its call site's caps.
// A reserved call stays counted even if the API call then fails.

/** Ceilings. Env vars and injected limits can lower them, never raise them. */
export const CLAUDE_BUDGET_MAX = { callsPerDay: 300, callsPerUserPerDay: 20 } as const;

export type ClaudeBudgetLimits = { callsPerDay: number; callsPerUserPerDay: number };

/**
 * Per call site. Opus 5.5 always thinks, and thinking counts toward maxTokens, so these
 * leave room for it above the answer's size. A truncated answer is wasted money.
 * maxInputChars covers the system prompt and messages.
 */
export const CLAUDE_CALL_CAPS = {
  risk_classifier: { maxTokens: 1024, maxInputChars: 32_000 },
  // A decision can hold 4,000 characters of reasoning plus 20 evidence items.
  dispute_agent: { maxTokens: 4096, maxInputChars: 120_000 },
} as const;

export type ClaudeCallSite = keyof typeof CLAUDE_CALL_CAPS;

/**
 * Who pays for a call. `userId` is who caused it, or null for a system job, which
 * counts toward the total only. Only the eval and live check scripts may bypass.
 */
export type ClaudeBudget = { userId: string | null; limits?: Partial<ClaudeBudgetLimits>; now?: Date } | { bypass: "eval" | "live_check" };

export type ClaudeBudgetScope = "day" | "user";

export class ClaudeBudgetExceededError extends Error {
  constructor(readonly scope: ClaudeBudgetScope) {
    super(`Claude budget used up (${scope})`);
    this.name = "ClaudeBudgetExceededError";
  }
}

/** The reservation itself failed, so we don't know the budget and don't call Claude. */
export class ClaudeBudgetUnavailableError extends Error {
  constructor() {
    super("Could not reserve Claude budget");
    this.name = "ClaudeBudgetUnavailableError";
  }
}

export class ClaudeInputTooLargeError extends Error {
  constructor(site: ClaudeCallSite, chars: number) {
    super(`${site} input is ${chars} characters, over its cap of ${CLAUDE_CALL_CAPS[site].maxInputChars}`);
    this.name = "ClaudeInputTooLargeError";
  }
}

// ---------- Limits ----------

function lowered(ceiling: number, value: number | string | undefined): number {
  const parsed = typeof value === "string" ? (/^\d+$/.test(value.trim()) ? Number(value) : Number.NaN) : (value ?? Number.NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(ceiling, parsed) : ceiling;
}

/** The limits in force. Unset or invalid values leave the ceiling in place. */
export function claudeBudgetLimits(injected: Partial<ClaudeBudgetLimits> = {}, env: NodeJS.ProcessEnv = process.env): ClaudeBudgetLimits {
  return {
    callsPerDay: lowered(lowered(CLAUDE_BUDGET_MAX.callsPerDay, env.CLAUDE_BUDGET_CALLS_PER_DAY), injected.callsPerDay),
    callsPerUserPerDay: lowered(lowered(CLAUDE_BUDGET_MAX.callsPerUserPerDay, env.CLAUDE_BUDGET_CALLS_PER_USER_PER_DAY), injected.callsPerUserPerDay),
  };
}

// ---------- Reservation ----------

const TOTAL_SCOPE = "total";
const USER_SCOPE_PREFIX = "user:";

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Adds one call if the row is under `limit`. Returns 0 if it isn't. The row lock makes concurrent reservations wait their turn. */
function bump(db: Db, day: string, scope: string, limit: number) {
  return db.$executeRaw`
    INSERT INTO claude_budget_usage (day, scope, calls, updated_at)
    VALUES (${day}::date, ${scope}, 1, now())
    ON CONFLICT (day, scope) DO UPDATE
      SET calls = claude_budget_usage.calls + 1, updated_at = now()
      WHERE claude_budget_usage.calls < ${limit}::int`;
}

class OverLimit extends Error {
  constructor(readonly scope: ClaudeBudgetScope) {
    super(scope);
  }
}

/**
 * Takes one call from the user's and the day's budget, or neither. Returns the
 * limit that stopped it, or null if reserved. Rows are always locked user first,
 * then total, so two reservations can't deadlock.
 */
export async function reserveClaudeCall({ userId, limits, now = new Date() }: { userId: string | null; limits?: Partial<ClaudeBudgetLimits>; now?: Date }): Promise<ClaudeBudgetScope | null> {
  const { callsPerDay, callsPerUserPerDay } = claudeBudgetLimits(limits);
  // The upsert's insert ignores the limit, so a limit of zero has to stop here.
  if (callsPerDay === 0) return "day";
  if (userId && callsPerUserPerDay === 0) return "user";

  const day = utcDay(now);
  try {
    await prisma.$transaction(
      async (tx) => {
        if (userId && (await bump(tx, day, `${USER_SCOPE_PREFIX}${userId}`, callsPerUserPerDay)) === 0) throw new OverLimit("user");
        if ((await bump(tx, day, TOTAL_SCOPE, callsPerDay)) === 0) throw new OverLimit("day");
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
    return null;
  } catch (err) {
    if (err instanceof OverLimit) return err.scope;
    throw err;
  }
}

/** Today's usage against the limits, for the admin dashboard. */
export async function getClaudeUsage(now = new Date(), limits?: Partial<ClaudeBudgetLimits>) {
  const { callsPerDay, callsPerUserPerDay } = claudeBudgetLimits(limits);
  const day = utcDay(now);
  const rows = await prisma.claudeBudgetUsage.findMany({ where: { day: new Date(day) }, select: { scope: true, calls: true } });
  const users = rows.filter((row) => row.scope.startsWith(USER_SCOPE_PREFIX));
  return {
    day,
    calls: rows.find((row) => row.scope === TOTAL_SCOPE)?.calls ?? 0,
    limit: callsPerDay,
    perUserLimit: callsPerUserPerDay,
    usersAtLimit: users.filter((row) => row.calls >= callsPerUserPerDay).length,
    busiestUserCalls: Math.max(0, ...users.map((row) => row.calls)),
  };
}

// ---------- The call ----------

export type ClaudeParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "max_tokens">;

export type CreateMessage = (
  params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  options: { timeout: number; maxRetries: number },
) => Promise<Anthropic.Beta.Messages.BetaMessage>;

let client: Anthropic | undefined;

// Created on first use, so importing this file doesn't need ANTHROPIC_API_KEY.
const createWithClaude: CreateMessage = (params, options) => {
  client ??= new Anthropic();
  return client.beta.messages.create(params, options);
};

const textChars = (content: unknown) => (typeof content === "string" ? content.length : JSON.stringify(content ?? "").length);

function inputChars({ system, messages }: ClaudeParams) {
  return messages.reduce((total, message) => total + textChars(message.content), textChars(system));
}

/**
 * Sends one request. Throws ClaudeBudgetExceededError or ClaudeBudgetUnavailableError
 * if it wasn't sent because of the budget, ClaudeInputTooLargeError if it's over its
 * call site's input cap, and otherwise whatever the API call throws. `options.maxRetries`
 * covers the SDK's retries of a failed request, which count as this one call.
 */
export async function callClaude(
  site: ClaudeCallSite,
  budget: ClaudeBudget,
  params: ClaudeParams,
  options: { timeout: number; maxRetries: number },
  createMessage: CreateMessage = createWithClaude,
): Promise<Anthropic.Beta.Messages.BetaMessage> {
  const chars = inputChars(params);
  if (chars > CLAUDE_CALL_CAPS[site].maxInputChars) throw new ClaudeInputTooLargeError(site, chars);

  if (!("bypass" in budget)) {
    let exceeded: ClaudeBudgetScope | null;
    try {
      exceeded = await reserveClaudeCall(budget);
    } catch (err) {
      console.error(`[claude] budget reservation failed for ${site}:`, err instanceof Error ? err.name : "unknown error");
      throw new ClaudeBudgetUnavailableError();
    }
    if (exceeded) throw new ClaudeBudgetExceededError(exceeded);
  }
  return createMessage({ ...params, max_tokens: CLAUDE_CALL_CAPS[site].maxTokens }, options);
}
