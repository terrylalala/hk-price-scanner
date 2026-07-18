import { NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "./db";

/**
 * Per-user daily caps on AI calls.
 *
 * This matters more here than in a plain vision app: Grounding with Google
 * Search is billed *per search query the model decides to run*, so a single
 * enthusiastic afternoon of scanning can cost real money. Caps are on by
 * default rather than opt-in.
 */

export type UsageKind = "identify" | "prices" | "advice";

const DEFAULTS: Record<UsageKind, number> = {
  identify: 40,
  prices: 40,
  advice: 20,
};

const ENV_KEYS: Record<UsageKind, string> = {
  identify: "DAILY_IDENTIFY_LIMIT",
  prices: "DAILY_PRICES_LIMIT",
  advice: "DAILY_ADVICE_LIMIT",
};

function limitFor(kind: UsageKind): number {
  const n = Number(process.env[ENV_KEYS[kind]]);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULTS[kind];
}

/**
 * Record one use and report whether it is allowed. Without a database there is
 * nowhere to keep counters, so everything is allowed — local development only.
 */
export async function consume(
  userId: string,
  kind: UsageKind,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const limit = limitFor(kind);
  if (!hasDb()) return { allowed: true, used: 0, limit };

  await ensureSchema();
  const sql = getSql();
  const day = new Date().toISOString().slice(0, 10);

  const rows = (await sql`
    insert into usage (user_id, day, kind, count)
    values (${userId}, ${day}, ${kind}, 1)
    on conflict (user_id, day, kind) do update set count = usage.count + 1
    returning count
  `) as unknown as { count: number }[];

  const used = rows[0]?.count ?? 1;
  return { allowed: used <= limit, used, limit };
}

export function rateLimited(limit: number): NextResponse {
  return NextResponse.json(
    {
      error: `Daily limit reached (${limit} per day). Try again tomorrow.`,
      code: "rate-limited",
    },
    { status: 429 },
  );
}
