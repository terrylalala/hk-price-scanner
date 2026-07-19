import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "@/lib/db";
import { ownerId, requireUser } from "@/lib/session";
import { hongKongDay } from "@/lib/scans";
import { allLimits } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent daily AI usage, so the caps can be tuned against reality.
 *
 * Exists because the caps were guesses. Usage here is bursty — several scans in
 * one shop, then nothing for days — so an average tells you very little and the
 * only number that matters for the bill is the monthly total against the free
 * tier's 5,000 grounded queries.
 *
 * Read-only and derived entirely from the `usage` table the rate limiter
 * already writes; nothing new is recorded to produce this.
 */

/** How far back to report. Long enough to see a fortnight's pattern. */
const DAYS = 21;

/** Grounded search queries the model runs per /api/prices call, approximately.
 *  Measured, not documented — see HANDOFF. Used only to translate calls into
 *  the unit Google actually bills, so the monthly figure means something. */
const QUERIES_PER_PRICE_CALL = 5;

/**
 * Pricing used for the cost ESTIMATE below. Not fetched from Google.
 *
 * There is no endpoint that reports what an AI Studio key has spent. Real
 * figures need the Cloud Billing API — a service account, a JSON key to store
 * as a secret, the API enabled — and still lag about 24 hours. That is a lot of
 * machinery, and a new secret to manage, for a number that arrives stale.
 *
 * So this is computed from counters we already keep, and the UI says so and
 * points at the authoritative page. These constants are the thing that will rot:
 * if Google changes pricing or the free allowance, they are wrong until edited,
 * which is the honest cost of not calling the billing API.
 */
const FREE_QUERIES_PER_MONTH = 5000;
const USD_PER_1000_QUERIES = 14;
/** HKD is pegged to USD in a narrow band, so a constant is fine here. */
const HKD_PER_USD = 7.8;
/** The AI Studio spend cap set on this project, for context on the estimate. */
const SPEND_CAP_HKD = 150;

export async function GET(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) {
    return NextResponse.json({ error: "No database configured." }, { status: 501 });
  }

  try {
    await ensureSchema();
    const sql = getSql();
    const uid = ownerId(authz.user);

    const since = new Date();
    since.setDate(since.getDate() - DAYS);
    const from = hongKongDay(since);

    const rows = (await sql`
      select day, kind, count from usage
      where user_id = ${uid} and day >= ${from}
      order by day desc
    `) as unknown as { day: string; kind: string; count: number }[];

    // Collapse to one entry per day so the client renders a simple list.
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const e = byDay.get(r.day) ?? {};
      e[r.kind] = r.count;
      byDay.set(r.day, e);
    }

    const days = [...byDay.entries()].map(([day, kinds]) => ({
      day,
      identify: kinds.identify ?? 0,
      prices: kinds.prices ?? 0,
      advice: kinds.advice ?? 0,
    }));

    // This calendar month only — the window the free tier and the spend cap
    // both reset on, so it is the figure worth watching.
    const monthPrefix = hongKongDay().slice(0, 7);
    const monthPriceCalls = days
      .filter((d) => d.day.startsWith(monthPrefix))
      .reduce((n, d) => n + d.prices, 0);

    const estimatedQueries = monthPriceCalls * QUERIES_PER_PRICE_CALL;
    // Only queries BEYOND the free allowance cost anything, so the estimate is
    // zero for a long time — which is the useful thing to be able to see.
    const billableQueries = Math.max(0, estimatedQueries - FREE_QUERIES_PER_MONTH);
    const estimatedHkd =
      (billableQueries / 1000) * USD_PER_1000_QUERIES * HKD_PER_USD;

    return NextResponse.json({
      days,
      // The limits actually in force, env overrides included.
      limits: allLimits(),
      month: {
        priceCalls: monthPriceCalls,
        estimatedQueries,
        freeQueries: FREE_QUERIES_PER_MONTH,
        billableQueries,
        // Rounded to cents; presented as an estimate, never as billed spend.
        estimatedHkd: Math.round(estimatedHkd * 100) / 100,
        spendCapHkd: SPEND_CAP_HKD,
      },
    });
  } catch (err) {
    console.error("[/api/usage] failed", err);
    return NextResponse.json({ error: "Could not load usage." }, { status: 500 });
  }
}
