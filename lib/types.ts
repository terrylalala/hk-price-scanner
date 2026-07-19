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
  /**
   * Whether `model` was read character-for-character off a label, or inferred.
   *
   * A shelf of Xiaomi ceiling lights showed three cards — D20 $229, D50 $359,
   * D40 $469 — against one display unit. The model returned "D45": a number on
   * no card, sitting between two that were, carrying D40's price, at confidence
   * 0.9. Because a model was PRESENT, the missing-model warning stayed hidden,
   * so a fabricated SKU is worse than a blank one: vagueness warns, invention
   * does not.
   *
   * The prompt already forbade guessing and was ignored. Giving the model a way
   * to admit it guessed works better than telling it not to — the same shape as
   * PriceQuote.exactModel. False is treated exactly like no model at all.
   */
  modelVerbatim: boolean;
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
  /**
   * How many units the tag price covers. 1 for a normal single-item price.
   *
   * Real shelves price things in bundles: a sign reading 蝴蝶脆餅 $20/3包 is
   * twenty dollars for THREE packs, and recording 20 as the price compares a
   * bundle against single-unit market prices. Neither the crossed-out-original
   * nor the member-price rule covers this — it is a distinct decoy class, and
   * the first one the model got wrong on a real photo.
   */
  packQuantity: number;
  /**
   * Whether products in this category normally carry a model or SKU number.
   *
   * Asked of the model rather than derived from a keyword list here. The list
   * approach was tried and failed on real data: it was written against invented
   * categories and then let "Ham" and "Instant Pasta" through, telling a shopper
   * holding cured ham to "add the model number from the label".
   */
  modelExpected: boolean;
  /** 0–1. Low values should visibly warn the user. */
  confidence: number;
  /** Short note on what was assumed or unreadable. */
  assumptions: string;
  /**
   * A rich, search-ready description for finding this item — or things like it —
   * online, written the way a shopper would type it (kind of item, colour,
   * pattern, material, cut, distinctive features). Populated for items with no
   * model number to look up — a scarf on a rail, a jacket on a passer-by — and
   * used as the query for a `similar` search, where a bare "purple scarf" is too
   * thin to match on. "" for anything a brand and model already pin down exactly
   * (electronics, appliances), since the model number is the better query there.
   *
   * Optional and NOT persisted: it matters only at search time, so a scan
   * restored from the database reconstructs without it. See lib/scans.ts.
   */
  searchTerms?: string;
  /**
   * Whether the photo shows several distinct products the shopper could mean —
   * a shelf of different models, a rack of different jackets. When true, the
   * chosen product is only the most prominent guess, so the confirm step nudges
   * the shopper to crop to the one they actually want before searching. This is
   * ambiguity of INTENT, not low confidence in reading a label: a crowded shelf
   * can be read perfectly and still be the wrong item.
   *
   * Optional and NOT persisted, like `searchTerms`.
   */
  multipleProducts?: boolean;
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
  /**
   * Whether this price is for the SAME model the shopper scanned.
   *
   * A search for a D45 returned four prices, all for a 米家吸頂燈450 — a
   * different product. The model flagged every substitution in `note`, but prose
   * cannot be acted on, so the app compared the shopper's tag against another
   * product and told them they were overpaying by 27%.
   *
   * Only exact-model quotes may drive a verdict. Substituted ones still render,
   * as context, clearly marked.
   *
   * Defaults to FALSE when the model omits it. Failing closed costs a missing
   * verdict; failing open costs a confident wrong one.
   */
  exactModel: boolean;
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
  /**
   * Normalized HK district, or "" when unknown.
   *
   * Top-level rather than on `product` because it is derived (via
   * `lib/hkDistricts`) rather than read off the photo. The raw text it was
   * derived from is `ProductIdentity.locationHint`, which is not persisted.
   */
  district: string;
  /** Cheapest EXACT-model quote found at scan time, if any. */
  bestPrice: number | null;
  bestSource: string;
  quotes: PriceQuote[];
  citations: Citation[];
  /**
   * Google's Search Suggestions markup, as captured at scan time.
   *
   * Stored, not merely passed through, because a saved scan's price list is
   * still grounded output: showing it later without these would breach the same
   * term that makes the live results render them. "" for scans saved before the
   * column existed — the UI must then hide the price list rather than show it
   * bare.
   */
  searchSuggestionsHtml: string;
  notes?: string;
  /** True when a photo is stored. The Blob URL itself never reaches the client. */
  hasPhoto: boolean;
  /** How many photos this scan has; fetch each via /api/photo/[id]?i=N. */
  photoCount: number;
  /** Whether the user is tracking this product on the Wishlist tab. */
  watching: boolean;
  /**
   * Which search produced this scan. 'similar' results are deliberately NOT the
   * photographed item, so they must never be rendered as failed exact matches.
   */
  mode: "exact" | "similar";
}

/** Per-user settings, stored as one jsonb blob (see /api/settings). */
export interface UserSettings {
  /**
   * Normalized HK district id the user says they shop in, or "" for unset.
   *
   * Set manually rather than inferred. Grounded search rarely reports a district
   * — most results are online retailers with no physical location — so deriving
   * a "home" district from results was never viable. See finding #4.
   */
  homeDistrict: string;
}

/** One observed price for a watched product, for the history chart. */
export interface PricePoint {
  checkedAt: string;
  price: number;
  source: string;
}
