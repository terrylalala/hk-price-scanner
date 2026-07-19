import { NextRequest, NextResponse } from "next/server";
import { del, put } from "@vercel/blob";
import { ensureSchema, getSql, hasBlob, hasDb } from "@/lib/db";
import { ownerId, requireUser } from "@/lib/session";
import { ScanRow, bestQuote, hongKongDay, rowToScan } from "@/lib/scans";
import { districtFromText } from "@/lib/hkDistricts";
import { Citation, PriceQuote, ProductIdentity } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saved scans.
 *
 * GET  /api/scans      most recent first
 * POST /api/scans      save one scan
 *
 * Without a database this returns 501 rather than pretending to save. Silently
 * accepting a write that goes nowhere would be worse: the client would show a
 * saved scan that vanishes on reload, which is the exact confusion the
 * sessionStorage stand-in was introduced to avoid.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function noDb() {
  return NextResponse.json(
    { error: "No database configured.", code: "no-database" },
    { status: 501 },
  );
}

export async function GET(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  const uid = ownerId(authz.user);
  const url = new URL(req.url);

  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;

  // Optional filters. `day` and `watching` are indexed (`scans_day_idx`,
  // `scans_watch_idx`); `mode` is not — Treasures is a small subset of an
  // already small table, and an index earns its keep at a scale this will not
  // reach. Revisit if that stops being true.
  const day = url.searchParams.get("day");
  const watching = url.searchParams.get("watching") === "true";
  const similar = url.searchParams.get("mode") === "similar";

  try {
    await ensureSchema();
    const sql = getSql();

    const rows = (await (day
      ? sql`select * from scans where user_id = ${uid} and day = ${day}
            order by ts desc limit ${limit}`
      : watching
        ? sql`select * from scans where user_id = ${uid} and watching = true
              order by ts desc limit ${limit}`
        : similar
          ? sql`select * from scans where user_id = ${uid} and mode = 'similar'
                order by ts desc limit ${limit}`
          : sql`select * from scans where user_id = ${uid}
                order by ts desc limit ${limit}`)) as unknown as ScanRow[];

    return NextResponse.json({ scans: rows.map(rowToScan) });
  } catch (err) {
    console.error("[/api/scans GET] failed", err);
    return NextResponse.json({ error: "Could not load scans." }, { status: 500 });
  }
}

interface CreateBody {
  product?: Partial<ProductIdentity>;
  quotes?: PriceQuote[];
  citations?: Citation[];
  district?: string;
  notes?: string;
  /** Required to redisplay the price list later; see lib/db.ts. */
  searchSuggestionsHtml?: string;
  /** Base64 JPEG of the scan photo, no data: prefix. Optional. */
  photoBase64?: string;
  /** All photos for this scan. Takes precedence over photoBase64. */
  photosBase64?: string[];
  /** Which search produced this scan; see lib/db.ts. Defaults to 'exact'. */
  mode?: "exact" | "similar";
  /**
   * Small versions of `photosBase64`, positionally matched. Optional: a client
   * that omits them still saves its photos, and /api/photo falls back to the
   * full image for any index without one.
   */
  thumbsBase64?: string[];
}

/** ~10MB of base64. The client downscales to 1600px, so this is a sanity bound. */
const MAX_PHOTO_BASE64 = 10_000_000;

/**
 * Store the scan photo, returning its Blob URL or null.
 *
 * Never throws. A photo is a nice-to-have attached to a scan that cost a billed
 * search to produce — losing the whole scan because an image upload failed would
 * trade something valuable for something decorative.
 *
 * Uploaded PRIVATE. The URL is unguessable but permanent, so a public blob would
 * mean a leaked link is readable by anyone forever; /api/photo/[id] streams the
 * bytes after checking ownership instead, and the URL never reaches the client.
 */
async function storePhoto(
  id: string,
  base64: string | undefined,
  index: number,
  variant: "full" | "thumb" = "full",
): Promise<string | null> {
  if (!base64 || !hasBlob()) return null;
  const data = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  if (data.length > MAX_PHOTO_BASE64) return null;

  // Thumbnails get their own key so both variants can coexist for one index.
  const key = variant === "thumb" ? `scans/${id}-${index}-t.jpg` : `scans/${id}-${index}.jpg`;
  try {
    const blob = await put(key, Buffer.from(data, "base64"), {
      access: "private",
      contentType: "image/jpeg",
    });
    return blob.url;
  } catch (err) {
    console.warn("[/api/scans] photo upload failed; saving scan without it", err);
    return null;
  }
}

/**
 * Uploads every photo, dropping any that fail. Order is preserved.
 *
 * Thumbnails are uploaded positionally alongside the full images, and a failed
 * thumbnail must NOT shift the array: index N of `thumbs` has to stay the
 * thumbnail of index N of `photos`, or the list would show one scan's photo
 * against another's. So this filters the full list and then keeps only the
 * thumbs whose full image survived.
 */
async function storePhotos(
  id: string,
  list: string[],
  thumbs: string[],
): Promise<{ photos: string[]; thumbs: string[] }> {
  const pairs = await Promise.all(
    list.map(async (b64, i) => ({
      full: await storePhoto(id, b64, i, "full"),
      thumb: await storePhoto(id, thumbs[i], i, "thumb"),
    })),
  );
  const kept = pairs.filter((p): p is { full: string; thumb: string | null } => !!p.full);
  return {
    photos: kept.map((p) => p.full),
    // "" holds the slot for a photo whose thumbnail failed; /api/photo treats an
    // empty entry as "no thumbnail" and serves the full image instead.
    thumbs: kept.map((p) => p.thumb ?? ""),
  };
}

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const p = body.product ?? {};
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing 'product.name'." }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : null;
  };

  const quotes = Array.isArray(body.quotes) ? body.quotes : [];
  const citations = Array.isArray(body.citations) ? body.citations : [];

  // The recorded best price must come from an EXACT-model quote. Taking the
  // cheapest overall would bake finding #5 into stored history: a D45 scan whose
  // "best price" was really a different product, preserved forever and no longer
  // carrying the note that said so.
  const best = bestQuote(quotes);

  // Prefer a district the caller derived; otherwise derive it here so a scan
  // saved by any client is normalized the same way.
  const district =
    districtFromText(str(body.district)) ||
    districtFromText(str(p.locationHint)) ||
    districtFromText(str(p.storeName));

  const uid = ownerId(authz.user);
  const id = crypto.randomUUID();
  const now = new Date();

  const incoming =
    Array.isArray(body.photosBase64) && body.photosBase64.length > 0
      ? body.photosBase64
      : body.photoBase64
        ? [body.photoBase64]
        : [];
  const incomingThumbs = Array.isArray(body.thumbsBase64) ? body.thumbsBase64 : [];
  const { photos: photoUrls, thumbs: thumbUrls } = await storePhotos(
    id,
    incoming,
    incomingThumbs,
  );
  // First photo stays in photo_url: it is what the thumbnail and old rows use.
  const photoUrl = photoUrls[0] ?? null;

  try {
    await ensureSchema();
    const sql = getSql();

    const rows = (await sql`
      insert into scans (
        id, user_id, ts, day,
        product_name, brand, model, category,
        tag_price, currency, store_name, district,
        confidence, assumptions,
        best_price, best_source, quotes, citations, notes,
        search_suggestions_html, photo_url, photo_urls, thumb_urls, mode
      ) values (
        ${id}, ${uid}, ${now.toISOString()}, ${hongKongDay(now)},
        ${name}, ${str(p.brand)}, ${str(p.model)}, ${str(p.category)},
        ${num(p.tagPrice)}, ${str(p.currency) || "HKD"}, ${str(p.storeName)}, ${district},
        ${num(p.confidence) ?? 0}, ${str(p.assumptions)},
        ${best?.price ?? null}, ${best?.store ?? ""},
        ${JSON.stringify(quotes)}, ${JSON.stringify(citations)},
        ${str(body.notes) || null},
        ${str(body.searchSuggestionsHtml) || null}, ${photoUrl},
        ${photoUrls.length ? JSON.stringify(photoUrls) : null},
        ${thumbUrls.length ? JSON.stringify(thumbUrls) : null},
        ${body.mode === "similar" ? "similar" : "exact"}
      )
      returning *
    `) as unknown as ScanRow[];

    // Keep ONE History row per identified product + mode. A re-search of the
    // same product supersedes the previous unsaved row instead of stacking a
    // new one — and because this keys on the product itself, not on the photo or
    // any client-side session id, it holds across a new photo, a page reload, or
    // an app restart (the iOS home-screen case where in-memory tracking was
    // always lost). Done AFTER the insert so a failed save never loses the old
    // row.
    //
    // Scoped so it only ever removes THIS user's UNSAVED rows of the SAME product
    // in the SAME mode: a saved (watching) row is kept, exact and similar stay
    // separate, and a genuinely different product keeps its own row. On a crowded
    // shelf where identification is unstable, different reads produce different
    // keys and correctly stay separate — they are different products.
    //
    // The key is the model when there is one, else the product name — the same
    // string shown as the row title — compared case- and whitespace-insensitively.
    const productKey = str(p.model) || name;
    const modeVal = body.mode === "similar" ? "similar" : "exact";
    try {
      const removed = (await sql`
        delete from scans
        where user_id = ${uid} and id <> ${id} and watching = false
          and mode = ${modeVal}
          and lower(btrim(case when model <> '' then model else product_name end))
              = lower(btrim(${productKey}))
        returning photo_url, photo_urls, thumb_urls
      `) as unknown as {
        photo_url: string | null;
        photo_urls: string[] | null;
        thumb_urls: string[] | null;
      }[];

      // Free every superseded row's Blob objects — there can be several when an
      // earlier pile-up is being collapsed. Blob has no referential integrity to
      // Postgres, so an un-deleted photo leaks storage exactly as documented in
      // /api/scans/[id] DELETE.
      const urls = Array.from(
        new Set(
          removed
            .flatMap((r) => [...(r.photo_urls ?? []), ...(r.thumb_urls ?? []), r.photo_url])
            .filter((u): u is string => !!u),
        ),
      );
      if (urls.length && hasBlob()) {
        await Promise.all(urls.map((u) => del(u)));
      }
    } catch (err) {
      // The new scan is saved, which is what matters. A failed dedupe leaves an
      // older duplicate behind — untidy, not lost data — so it is logged rather
      // than allowed to fail the request.
      console.warn("[/api/scans POST] product dedupe failed", err);
    }

    return NextResponse.json({ scan: rowToScan(rows[0]) }, { status: 201 });
  } catch (err) {
    console.error("[/api/scans POST] failed", err);
    return NextResponse.json({ error: "Could not save the scan." }, { status: 500 });
  }
}
