/** Shared types. Safe to import from both client and server. */

/** What the vision call reads off the photo. */
export interface ProductIdentity {
  /** Best full product name, e.g. "Sony WH-1000XM5 Wireless Headphones". */
  name: string;
  brand: string;
  /** Model/SKU if legible, else "". */
  model: string;
  /** Rough category, e.g. "Headphones", "Laptop", "Kettle". */
  category: string;
  /** The price printed on the tag, or null if none was legible. */
  tagPrice: number | null;
  currency: string;
  /** Shop name if visible on the tag/shelf, else "". */
  storeName: string;
  /**
   * Branch/district/area text copied verbatim from the photo, else "".
   * A chain name alone says nothing about location, so this is the field the
   * district lookup actually depends on.
   */
  locationHint: string;
  /** 0–1. Low values should visibly warn the user. */
  confidence: number;
  /** Short note on what was assumed or unreadable. */
  assumptions: string;
}

/** One price found by the grounded search. */
export interface PriceQuote {
  store: string;
  price: number;
  currency: string;
  /** Source URL — always rendered as an outbound link. */
  url: string;
  /** HK district if the source names one, else "". */
  district: string;
  /** e.g. "online only", "in stock", "refurbished". */
  note: string;
}

/** A grounding source, rendered for attribution. */
export interface Citation {
  title: string;
  url: string;
}

/** Result of a price lookup. */
export interface PriceLookup {
  quotes: PriceQuote[];
  citations: Citation[];
  /**
   * Google's Search Suggestions markup. Rendering this is REQUIRED by the
   * Gemini API terms whenever Search grounding is used — it is not optional
   * and must not be stripped.
   */
  searchSuggestionsHtml: string;
  /** Plain-language summary from the model. */
  summary: string;
}

/** A saved scan. */
export interface Scan {
  id: string;
  timestamp: string;
  /** Local calendar day, YYYY-MM-DD. Local, not UTC. */
  date: string;
  product: ProductIdentity;
  /** Cheapest quote found at scan time, if any. */
  bestPrice: number | null;
  bestSource: string;
  quotes: PriceQuote[];
  citations: Citation[];
  notes?: string;
  /** True when a photo is stored. The Blob URL itself never reaches the client. */
  hasPhoto: boolean;
  /** Whether the user is tracking this product on the Watch tab. */
  watching: boolean;
}

/** One observed price for a watched product, for the history chart. */
export interface PricePoint {
  checkedAt: string;
  price: number;
  source: string;
}
