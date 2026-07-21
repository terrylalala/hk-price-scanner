import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SerpApi's monthly search allowance, reported by SerpApi itself.
 *
 * Deliberately unlike /api/usage, which ESTIMATES Gemini spend from this app's
 * own counters because Google exposes no spend endpoint for an AI Studio key.
 * SerpApi does expose one, so these are the provider's real numbers and the UI
 * can state them plainly rather than hedging them as an estimate.
 *
 * The account endpoint does NOT consume a search credit, so polling it is free —
 * checking how many searches are left never costs one.
 *
 * Note nothing in the app calls SerpApi yet; visual search is unbuilt. This
 * reports the allowance so the free tier can be watched from inside the app
 * instead of SerpApi's dashboard, and so it is already in place if Lens is
 * built. Until then it simply reads 0 used.
 */

/**
 * SerpApi is a third party on the critical path of rendering Settings, so it
 * gets a deadline like every other outbound call here. Without one a hung
 * request would leave the panel spinning indefinitely. Short, because this is
 * a lookup against a status endpoint, not a search.
 */
const ACCOUNT_TIMEOUT_MS = 8_000;

export async function GET(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const key = process.env.SERPAPI_KEY;
  // Not an error: the key is optional and absent in any environment where
  // visual search has not been set up. The client hides the panel on this,
  // rather than showing a broken one.
  if (!key) {
    return NextResponse.json({ configured: false });
  }

  try {
    const res = await fetch(
      `https://serpapi.com/account?api_key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS), cache: "no-store" },
    );

    if (!res.ok) {
      console.warn(`[/api/serpapi-usage] SerpApi returned ${res.status}`);
      return NextResponse.json(
        { configured: true, error: "SerpApi could not be reached." },
        { status: 502 },
      );
    }

    const a = await res.json();

    // Echo ONLY the allowance fields. The response also carries account_id and
    // the registered email, which the browser has no use for and which would
    // otherwise be visible in devtools on a shared-password app.
    return NextResponse.json({
      configured: true,
      planName: String(a.plan_name ?? "Unknown"),
      monthlyPriceUsd: Number(a.plan_monthly_price ?? 0),
      searchesPerMonth: Number(a.searches_per_month ?? 0),
      used: Number(a.this_month_usage ?? 0),
      // plan_searches_left excludes extra credits; total includes them. Both are
      // reported so a purchased top-up cannot silently mask a used-up plan.
      planSearchesLeft: Number(a.plan_searches_left ?? 0),
      extraCredits: Number(a.extra_credits ?? 0),
      renewalDate: String(a.renewal_date ?? a.plan_renewal_date ?? ""),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    console.warn(
      `[/api/serpapi-usage] ${timedOut ? "timed out" : "failed"}`,
      err,
    );
    return NextResponse.json(
      { configured: true, error: "SerpApi could not be reached." },
      { status: 502 },
    );
  }
}
