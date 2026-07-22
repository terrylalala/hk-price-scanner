import type { PriceQuote } from "./types";

/** Registrable-ish host, lowercased and stripped of "www.". "" when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * A store's own search-results URL for `query`, or null if we don't have a
 * VERIFIED format for that store. This upgrades a bare-homepage fallback into a
 * link that lands on the item, without the fabricated-product-URL hazard that
 * withBestLinks guards against: a search URL that turns out wrong fails VISIBLY
 * (an empty results page), it can never silently serve a different product the
 * way a guessed product id does.
 *
 * Each format was confirmed by hand against the live site (2026-07-23) — do not
 * add a store on memory alone. A wrong template lands the shopper on a broken
 * search, which is worse than the home page we would otherwise show, so the bar
 * is "checked it returns real results", not "looks plausible". `host` arrives
 * lowercased and www-stripped from hostOf(). Regional domains are preserved by
 * building on the host we were given (amazon.co.uk, hk.iherb.com, …).
 */
export function storeSearchUrl(host: string, query: string): string | null {
  const q = encodeURIComponent(query.trim());
  if (!q) return null;

  // Amazon (any region): /s?k= — verified on amazon.com.
  if (host === "amazon.com" || host.startsWith("amazon."))
    return `https://www.${host}/s?k=${q}`;
  // ASOS (single global domain): /search/?q= — verified on asos.com.
  if (host === "asos.com") return `https://www.asos.com/search/?q=${q}`;
  // iHerb (geo-redirects to a regional subdomain): /search?kw= — verified.
  if (host === "iherb.com" || host.endsWith(".iherb.com"))
    return `https://${host}/search?kw=${q}`;

  return null;
}

/**
 * True only for a truly bare home page ("" or "/", no query) — not a category
 * or product path, which already drops the shopper closer to the item.
 */
export function isBareHomepage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") === "" && !u.search;
  } catch {
    return false;
  }
}

/**
 * When a quote's link is a bare store home page AND we have a verified search
 * format for that store, point it at the store's search for `query` instead, so
 * the shopper lands on the item rather than the front door. Everything else is
 * left exactly as-is: real product/category pages, unknown stores (home page
 * stays — never worse), and the opaque Google-redirect links that withBestLinks
 * produces for cited quotes (their host is Google's, so no template matches, and
 * their path is non-empty anyway).
 */
export function withStoreSearchFallback(
  quotes: PriceQuote[],
  query: string,
): PriceQuote[] {
  if (!query.trim()) return quotes;
  return quotes.map((q) => {
    if (!q.url || !isBareHomepage(q.url)) return q;
    const search = storeSearchUrl(hostOf(q.url), query);
    return search ? { ...q, url: search } : q;
  });
}

/** A Google search URL for `query`, or null when the query is empty. */
export function googleSearchUrl(query: string): string | null {
  const q = encodeURIComponent(query.trim());
  return q ? `https://www.google.com/search?q=${q}` : null;
}

/**
 * On an UNGROUNDED result every quote — price, store and link alike — is the
 * model's memory, and the links are guesses that frequently 404. Rather than
 * send the shopper to a dead page, point each link at a Google search for the
 * item, plus the store the model named (a real store then narrows the search; a
 * made-up one is simply ignored). The prices already carry the "from memory"
 * warning; this makes the one tappable thing actually land somewhere real.
 *
 * Applied ONLY to ungrounded results — grounded quotes have verified/citation
 * links and must never be downgraded to a search. A quote with neither an item
 * query nor a store name is left as-is (nothing better to search for).
 */
export function withUngroundedSearchLinks(
  quotes: PriceQuote[],
  itemQuery: string,
): PriceQuote[] {
  return quotes.map((q) => {
    const terms = [itemQuery, q.store]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const url = googleSearchUrl(terms);
    return url ? { ...q, url } : q;
  });
}
