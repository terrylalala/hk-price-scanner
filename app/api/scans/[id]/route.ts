import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { ensureSchema, getSql, hasBlob, hasDb } from "@/lib/db";
import { ownerId, requireUser } from "@/lib/session";
import { ScanRow, rowToScan } from "@/lib/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One saved scan.
 *
 * GET    /api/scans/[id]
 * PATCH  /api/scans/[id]   { notes?, watching? }
 * DELETE /api/scans/[id]
 *
 * Every statement is scoped by `user_id` as well as `id`, following
 * /api/photo/[id]: a row belonging to someone else simply does not match, so it
 * is indistinguishable from a missing one. That keeps ownership enforcement in
 * the query rather than in a separate check that a later edit could skip.
 */

function noDb() {
  return NextResponse.json(
    { error: "No database configured.", code: "no-database" },
    { status: 501 },
  );
}

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  const { id } = await ctx.params;
  const uid = ownerId(authz.user);

  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      select * from scans where id = ${id} and user_id = ${uid}
    `) as unknown as ScanRow[];

    if (rows.length === 0) return notFound();
    return NextResponse.json({ scan: rowToScan(rows[0]) });
  } catch (err) {
    console.error("[/api/scans/[id] GET] failed", err);
    return NextResponse.json({ error: "Could not load the scan." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  let body: { notes?: unknown; watching?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasNotes = typeof body.notes === "string" || body.notes === null;
  const hasWatching = typeof body.watching === "boolean";
  if (!hasNotes && !hasWatching) {
    return NextResponse.json(
      { error: "Nothing to update. Send 'notes' and/or 'watching'." },
      { status: 400 },
    );
  }

  const { id } = await ctx.params;
  const uid = ownerId(authz.user);

  try {
    await ensureSchema();
    const sql = getSql();

    // Two narrow statements rather than one dynamically-assembled UPDATE. The
    // neon driver's tagged template is what parameterizes these safely, and
    // building a SET clause by string concatenation would give that up for the
    // sake of avoiding one extra round trip.
    if (hasNotes) {
      const notes = typeof body.notes === "string" ? body.notes.trim() : null;
      await sql`update scans set notes = ${notes || null}
                where id = ${id} and user_id = ${uid}`;
    }
    if (hasWatching) {
      await sql`update scans set watching = ${body.watching as boolean}
                where id = ${id} and user_id = ${uid}`;
    }

    const rows = (await sql`
      select * from scans where id = ${id} and user_id = ${uid}
    `) as unknown as ScanRow[];

    if (rows.length === 0) return notFound();
    return NextResponse.json({ scan: rowToScan(rows[0]) });
  } catch (err) {
    console.error("[/api/scans/[id] PATCH] failed", err);
    return NextResponse.json({ error: "Could not update the scan." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  const { id } = await ctx.params;
  const uid = ownerId(authz.user);

  try {
    await ensureSchema();
    const sql = getSql();
    // price_points rows cascade via the foreign key. photo_url does NOT — Blob
    // is a separate service with no referential integrity to Postgres — so the
    // object is returned here and deleted explicitly. Verified: without this a
    // deleted scan left a 714 KB photo in the store permanently, unreachable
    // (since /api/photo/[id] needs the row) but still counted against storage.
    const rows = (await sql`
      delete from scans where id = ${id} and user_id = ${uid}
      returning id, photo_url, photo_urls
    `) as unknown as {
      id: string;
      photo_url: string | null;
      photo_urls: string[] | null;
    }[];

    if (rows.length === 0) return notFound();

    // Every photo, not just the first. photo_url duplicates photo_urls[0], so
    // dedupe or the second delete fails on an already-removed object.
    const urls = Array.from(
      new Set(
        [...(rows[0].photo_urls ?? []), rows[0].photo_url].filter(
          (u): u is string => !!u,
        ),
      ),
    );
    if (urls.length && hasBlob()) {
      try {
        await Promise.all(urls.map((u) => del(u)));
      } catch (err) {
        // The row is gone, which is what was asked for. A failed blob delete
        // leaks storage — worth logging, not worth failing the request over,
        // since retrying would find no row to delete.
        console.warn("[/api/scans/[id]] scan deleted but photo remains", err);
      }
    }

    return NextResponse.json({ deleted: rows[0].id });
  } catch (err) {
    console.error("[/api/scans/[id] DELETE] failed", err);
    return NextResponse.json({ error: "Could not delete the scan." }, { status: 500 });
  }
}
