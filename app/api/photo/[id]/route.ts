import { NextRequest, NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { ensureSchema, getSql, hasDb } from "@/lib/db";
import { ownerId, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a scan's photo, but only to the account that owns the scan.
 *
 * The underlying Blob URL is deliberately never sent to the browser. Blob
 * objects live on a public (if unguessable) URL, so exposing it would mean a
 * leaked link could be opened by anyone, forever. Instead we look the URL up
 * server-side after checking ownership and stream the bytes back.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) {
    return NextResponse.json({ error: "No database configured." }, { status: 501 });
  }

  const { id } = await ctx.params;
  const uid = ownerId(authz.user);

  try {
    await ensureSchema();
    const sql = getSql();
    // Ownership is enforced here: a row belonging to someone else simply
    // doesn't match, so it is indistinguishable from a missing photo.
    const rows = (await sql`
      select photo_url, photo_urls from scans where id = ${id} and user_id = ${uid}
    `) as unknown as { photo_url: string | null; photo_urls: string[] | null }[];

    // ?i=N selects which photo. photo_urls is the full list; photo_url is the
    // fallback for rows written before multiple photos existed, where index 0
    // is the only valid one.
    const row = rows[0];
    const all = Array.isArray(row?.photo_urls)
      ? row.photo_urls
      : row?.photo_url
        ? [row.photo_url]
        : [];

    const iParam = Number(req.nextUrl.searchParams.get("i"));
    const index = Number.isFinite(iParam) && iParam > 0 ? Math.floor(iParam) : 0;

    const url = all[index];
    if (!url) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // The blob lives in a private store, so this read is authenticated with the
    // store token that only the server holds.
    const result = await get(url, { access: "private" });
    if (!result || !result.stream) {
      return NextResponse.json({ error: "Image unavailable." }, { status: 502 });
    }

    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType ?? "image/jpeg",
        // Private: cache in this user's browser only, never in a shared CDN.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (err) {
    console.error("[/api/photo] failed", err);
    return NextResponse.json({ error: "Could not load the photo." }, { status: 500 });
  }
}
