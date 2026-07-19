"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
  /**
   * Which photo is open full-size, or null.
   *
   * An in-app overlay rather than a link to /api/photo. Opening the raw image
   * URL is a full page navigation OUT of the app: it renders at the image's
   * native size with no way to fit it to the screen, and the back button then
   * returns to the app's initial state — the Scan tab — rather than to this
   * scan, because the History tab and the open detail are component state that
   * the reload discards.
   */
  const [zoomed, setZoomed] = useState<number | null>(null);

  /**
   * Whether the DOM exists yet, so the viewer can be portalled to document.body.
   *
   * Portalled because a modal overlay should not be nested inside a layout
   * container, where its painting depends on ancestor stacking contexts. That
   * is good practice on its own.
   *
   * RESOLVED — and the resolution is worth keeping, because the investigation
   * was long and pointed the wrong way. The in-app preview browser photographs
   * this backdrop as fully transparent, while on a real phone it renders
   * correctly. Every measurement had already said the CSS was fine (computed
   * colour, full-viewport geometry, hit-testing topmost, no ancestor
   * transform/filter/contain); an opaque colour on the same element painted,
   * and a cloneNode of it painted. All of that was true and none of it was a
   * bug. **Do not trust that browser's screenshots for full-screen overlays —
   * check a device.**
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Escape closes the viewer. Bound only while it is open so this component
  // does not listen on every keystroke in the rest of the app.
  useEffect(() => {
    if (zoomed === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

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

        {/*
          Every photo taken for this scan, served through /api/photo/[id]?i=N.
          The Blob URLs stay server-side; see that route for why.

          `photoCount` drives this rather than `hasPhoto`, so a scan saved with
          three views shows three. Old rows report a count of 1 from photo_url
          alone, which keeps them working without a backfill.
        */}
        {scan.photoCount > 0 && (
          <div className="thumb-strip">
            {Array.from({ length: scan.photoCount }, (_, i) => (
              <button
                key={i}
                className="thumb-button"
                onClick={() => setZoomed(i)}
                aria-label={`View photo ${i + 1} of ${scan.photoCount} full size`}
              >
                <img
                  className="thumb"
                  src={`/api/photo/${scan.id}?i=${i}&size=thumb`}
                  alt={
                    scan.photoCount > 1
                      ? `Photo ${i + 1} of ${scan.photoCount} of ${scan.product.name}`
                      : `Photo of ${scan.product.name}`
                  }
                  loading="lazy"
                />
              </button>
            ))}
          </div>
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

      {/* Full-size viewer. Tapping anywhere closes it, which is the gesture
          people already expect from a photo overlay; Escape does the same for
          anyone on a keyboard. */}
      {zoomed !== null &&
        mounted &&
        createPortal(
          <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Photo of ${scan.product.name}`}
            onClick={() => setZoomed(null)}
          >
            <img src={`/api/photo/${scan.id}?i=${zoomed}`} alt={`Photo of ${scan.product.name}`} />
            <button className="lightbox-close" aria-label="Close photo">
              ✕
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
