"use client";

import { Scan } from "@/lib/types";
import { districtById } from "@/lib/hkDistricts";

/**
 * A saved scan's full price list.
 *
 * The compliance obligations that apply to live results apply here too — this is
 * the same grounded output, just read from a row instead of a response:
 *   - every quote is an outbound link to its source, never a mirrored listing
 *   - Search Suggestions are rendered
 *   - the staleness disclaimer is shown, and matters MORE here: these prices
 *     were true when the scan was taken, which may have been weeks ago
 *
 * Scans saved before `search_suggestions_html` existed have no suggestions, so
 * the price list is withheld rather than shown without them. Degrading is the
 * only correct option: showing it bare would breach the term, and silently
 * dropping the suggestions is exactly the failure the compliance note warns
 * against.
 */

export default function ScanDetail({ scan, onBack }: { scan: Scan; onBack: () => void }) {
  const { quotes, citations, searchSuggestionsHtml } = scan;
  const district = scan.district ? districtById(scan.district) : undefined;
  const canShowPrices = quotes.length > 0 && !!searchSuggestionsHtml;

  const when = new Date(scan.timestamp).toLocaleString("en-HK", {
    timeZone: "Asia/Hong_Kong",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="stack">
      <button className="btn quiet small" style={{ alignSelf: "flex-start" }} onClick={onBack}>
        ← Back
      </button>

      <div className="card">
        <h2>{scan.product.name}</h2>
        <p className="quote-meta" style={{ marginTop: 6 }}>
          {[
            when,
            district?.en,
            scan.product.brand || null,
            scan.product.model || null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="note" style={{ marginTop: 10 }}>
          {scan.product.tagPrice !== null
            ? `Shop price HK$${Math.round(scan.product.tagPrice)}`
            : "No shop price was read"}
          {scan.bestPrice !== null &&
            ` · best found HK$${Math.round(scan.bestPrice)}${
              scan.bestSource ? ` at ${scan.bestSource}` : ""
            }`}
        </p>
        {scan.notes && (
          <p className="note" style={{ marginTop: 6 }}>
            {scan.notes}
          </p>
        )}
      </div>

      {canShowPrices ? (
        <div className="card">
          <h3>Prices at the time of the scan</h3>
          <div style={{ marginTop: 10 }}>
            {quotes.map((q, i) => (
              <div
                className={`quote ${q.exactModel ? "" : "substituted"}`}
                key={`${q.url}-${i}`}
              >
                <div>
                  {q.url ? (
                    <a
                      className="quote-store"
                      href={q.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      {q.store}
                    </a>
                  ) : (
                    <span className="quote-store">{q.store}</span>
                  )}
                  {!q.exactModel && <span className="tag-different">different model</span>}
                  {(q.district || q.note) && (
                    <div className="quote-meta">
                      {[q.district, q.note].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="quote-price">
                  {q.currency === "HKD" ? "HK$" : `${q.currency} `}
                  {Math.round(q.price).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <h3>Prices not available</h3>
          <p className="note" style={{ marginTop: 8 }}>
            {quotes.length === 0
              ? "This scan found no prices."
              : "This scan was saved before the app kept everything needed to redisplay its prices. Scan the product again to see current prices."}
          </p>
        </div>
      )}

      {canShowPrices && citations.length > 0 && (
        <div className="card">
          <h3>Sources</h3>
          <ul className="citations">
            {citations.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* REQUIRED whenever grounded results are displayed — including these. */}
      {canShowPrices && (
        <div
          className="search-suggestions"
          dangerouslySetInnerHTML={{ __html: searchSuggestionsHtml }}
        />
      )}

      {canShowPrices && (
        <p className="disclaimer">
          These prices were retrieved by AI when the scan was taken, not now. They
          may be well out of date. Always verify in store before buying.
        </p>
      )}
    </div>
  );
}
