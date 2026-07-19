import { NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "./db";
import { hongKongDay } from "./scans";

/**
 * Per-user daily caps on AI calls.
 *
 * WHAT THESE ARE FOR CHANGED, and the numbers below only make sense with the
 * new job in mind. They were originally sized as a budget divided by thirty,
 * back when nothing else bounded the bill. Since then a HK$150/month spend cap
 * on the Google project became the real ceiling — a hard cutoff, not an alert —
 * so the monthly worst case is settled whatever these say.
 *
 * That leaves these as a RUNAWAY GUARD: catch a retry loop or a stuck client
 * within a day. So they should sit well above anything a person would do, not
 * at a budget fraction. Usage here is bursty by nature — several scans in one
 * shop, then nothing for days — and a daily cap sized for the average punishes
 * exactly the day you are actually using it.
 *
 * Grounding with Google Search is still billed per search query the model runs
 * (~5 per price search), which is why `prices` stays the tightest of the three.
 */

export type UsageKind = "identify" | "prices" | "advice";

const DEFAULTS: Record<UsageKind, number> = {
  // A heavy afternoon in a shop, with room for re-cropping. Still far under the
  // ~1,270 price searches a month the spend cap allows.
  prices: 150,
  // Cheap: one Flash vision call, no grounding. Every crop and recrop spends
  // one, so this needs the most headroom of the three.
  identify: 400,
  // Ungrounded, and only ever requested deliberately.
  advice: 100,
};

const ENV_KEYS: Record<UsageKind, string> = {
  identify: "DAILY_IDENTIFY_LIMIT",
  prices: "DAILY_PRICES_LIMIT",
  advice: "DAILY_ADVICE_LIMIT",
};

export function limitFor(kind: UsageKind): number {
  const n = Number(process.env[ENV_KEYS[kind]]);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULTS[kind];
}

/** Every effective limit, for display. Exported so the Settings panel reports
 *  what is ACTUALLY enforced: an env override would otherwise make a hardcoded
 *  list of numbers quietly wrong. */
export function allLimits(): Record<UsageKind, number> {
  return { prices: limitFor("prices"), identify: limitFor("identify"), advice: limitFor("advice") };
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
  // Hong Kong day, not UTC. Vercel runs UTC, so `toISOString()` here rolled the
  // counter over at 08:00 local — "try again tomorrow" meant "try again at 8am",
  // and usage rows disagreed with `scans.day`, which has always used this helper.
  const day = hongKongDay();

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
