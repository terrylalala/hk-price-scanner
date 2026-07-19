import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "@/lib/db";
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

  // Optional filters, both indexed: `scans_day_idx` and `scans_watch_idx`.
  const day = url.searchParams.get("day");
  const watching = url.searchParams.get("watching") === "true";

  try {
    await ensureSchema();
    const sql = getSql();

    const rows = (await (day
      ? sql`select * from scans where user_id = ${uid} and day = ${day}
            order by ts desc limit ${limit}`
      : watching
        ? sql`select * from scans where user_id = ${uid} and watching = true
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
        search_suggestions_html
      ) values (
        ${id}, ${uid}, ${now.toISOString()}, ${hongKongDay(now)},
        ${name}, ${str(p.brand)}, ${str(p.model)}, ${str(p.category)},
        ${num(p.tagPrice)}, ${str(p.currency) || "HKD"}, ${str(p.storeName)}, ${district},
        ${num(p.confidence) ?? 0}, ${str(p.assumptions)},
        ${best?.price ?? null}, ${best?.store ?? ""},
        ${JSON.stringify(quotes)}, ${JSON.stringify(citations)},
        ${str(body.notes) || null},
        ${str(body.searchSuggestionsHtml) || null}
      )
      returning *
    `) as unknown as ScanRow[];

    return NextResponse.json({ scan: rowToScan(rows[0]) }, { status: 201 });
  } catch (err) {
    console.error("[/api/scans POST] failed", err);
    return NextResponse.json({ error: "Could not save the scan." }, { status: 500 });
  }
}
