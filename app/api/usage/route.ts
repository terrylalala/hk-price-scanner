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

    return NextResponse.json({
      days,
      // The limits actually in force, env overrides included.
      limits: allLimits(),
      month: {
        priceCalls: monthPriceCalls,
        estimatedQueries: monthPriceCalls * QUERIES_PER_PRICE_CALL,
        freeQueries: 5000,
      },
    });
  } catch (err) {
    console.error("[/api/usage] failed", err);
    return NextResponse.json({ error: "Could not load usage." }, { status: 500 });
  }
}
