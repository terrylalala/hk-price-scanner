import { NextRequest, NextResponse } from "next/server";
import { getSql, hasDb } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Nothing here is slow except waking the database, and if that takes longer
// than this the user has already reached History and paid the cost anyway.
export const maxDuration = 15;

/**
 * Wakes the database so the first real query does not pay for it.
 *
 * Neon's free tier suspends compute after ~5 minutes idle. Measured from Hong
 * Kong: the first query after idle took 2057ms, then 1145ms, settling to ~400ms.
 * That is the whole of the reported "History is slow the first time, fast
 * afterwards" — not photo size, which was already fixed in 084cfe2, and not the
 * function/database region split, which would slow every load equally rather
 * than only the first.
 *
 * This does not avoid the wake; it moves it. Fired when the app opens, the ~2s
 * is spent while the user is still looking at the camera screen, so History is
 * warm by the time they tap it.
 *
 * Deliberately behind auth. An unauthenticated warm endpoint would let anyone
 * spin up the database at will, and Neon's free tier bills compute-hours — a
 * trivial endpoint that costs money when strangers call it is a bad trade for
 * saving the user one round trip.
 */
export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  // No database configured (local dev without DATABASE_URL) is not an error
  // here — there is simply nothing to warm.
  if (!hasDb()) return new NextResponse(null, { status: 204 });

  try {
    const sql = getSql();
    await sql`select 1`;
  } catch {
    // Warming is best-effort by definition. A failure here must never surface
    // to the user or block anything: the real query will wake the database on
    // its own, exactly as it did before this route existed.
  }

  return new NextResponse(null, { status: 204 });
}
