import { Citation, PriceQuote, ProductIdentity, Scan } from "./types";

/**
 * Row ⇄ Scan mapping for the `scans` table.
 *
 * Two deliberate asymmetries between `Scan` and the table, both worth knowing
 * before "fixing" either side:
 *
 * - The table stores `district` but `ProductIdentity` does not carry one, so
 *   `Scan.district` sits at the top level. It is the derived, normalized value
 *   (`lib/hkDistricts`), not raw text off the photo.
 * - `ProductIdentity.locationHint` is NOT persisted. It is the raw branch/area
 *   text used to derive `district`, useful only at identification time. It comes
 *   back as "" and nothing downstream depends on it.
 */

export interface ScanRow {
  id: string;
  ts: Date | string;
  day: string;
  product_name: string;
  brand: string;
  model: string;
  category: string;
  tag_price: number | null;
  currency: string;
  store_name: string;
  district: string;
  confidence: number;
  assumptions: string;
  best_price: number | null;
  best_source: string;
  quotes: PriceQuote[] | null;
  citations: Citation[] | null;
  notes: string | null;
  watching: boolean;
  /** Server-side only. Mapped to `hasPhoto`; the URL never reaches the client. */
  photo_url: string | null;
}

export function rowToScan(row: ScanRow): Scan {
  const product: ProductIdentity = {
    name: row.product_name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    tagPrice: row.tag_price,
    currency: row.currency,
    storeName: row.store_name,
    locationHint: "",
    confidence: row.confidence,
    assumptions: row.assumptions,
  };

  return {
    id: row.id,
    timestamp: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    date: row.day,
    product,
    district: row.district,
    bestPrice: row.best_price,
    bestSource: row.best_source,
    quotes: Array.isArray(row.quotes) ? row.quotes : [],
    citations: Array.isArray(row.citations) ? row.citations : [],
    notes: row.notes ?? undefined,
    // The Blob URL is never serialized. The client learns only that one exists
    // and fetches it through /api/photo/[id], which re-checks ownership.
    hasPhoto: !!row.photo_url,
    watching: row.watching,
  };
}

/**
 * Today's date in Hong Kong, as YYYY-MM-DD.
 *
 * `Scan.date` is the LOCAL calendar day, and this app is Hong Kong specific.
 * Computing it from the server clock would be wrong: Vercel runs UTC, and HK is
 * UTC+8, so anything scanned before 08:00 local would be filed under the
 * previous day. Pinning the zone is both correct and not dependent on the
 * client's clock being honest.
 */
export function hongKongDay(when: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return when.toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

/** The cheapest EXACT-model quote — the only kind allowed to represent a scan. */
export function bestQuote(quotes: PriceQuote[]): PriceQuote | null {
  const exact = quotes.filter((q) => q.exactModel);
  if (exact.length === 0) return null;
  return exact.reduce((a, b) => (b.price < a.price ? b : a));
}
