"use client";

import { useEffect, useRef, useState } from "react";
import CameraCapture, { CapturedImage } from "@/components/CameraCapture";
import { markdownToHtml } from "@/lib/markdown";
import { Citation, PriceQuote, ProductIdentity } from "@/lib/types";

/**
 * The scan flow: photograph → identify → confirm → grounded price search.
 *
 * The confirm step is not a formality. Identification is the weakest link in
 * the chain (glare, angle, small print), and a wrong model number sends the
 * price search after the wrong product entirely. Showing the user what was
 * read, and letting them correct it before any billed search runs, is both the
 * accuracy mitigation and the cost control.
 *
 * Scans are not persisted yet — /api/scans does not exist. Reloading loses the
 * result.
 */

type Phase = "idle" | "identifying" | "confirm" | "searching" | "results";

interface PriceResult {
  quotes: PriceQuote[];
  citations: Citation[];
  searchSuggestionsHtml: string;
  summary: string;
  grounded: boolean;
}

/** Editable subset of the identification — what the price search actually uses. */
interface Draft {
  name: string;
  brand: string;
  model: string;
  tagPrice: string;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<CapturedImage | null>(null);
  const [identity, setIdentity] = useState<ProductIdentity | null>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    brand: "",
    model: "",
    tagPrice: "",
  });
  const [result, setResult] = useState<PriceResult | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // The scan stays on one screen and results append below it, so after a search
  // the interesting part is off-screen. Bring it into view rather than leaving
  // the user looking at the form they just submitted.
  useEffect(() => {
    if (phase !== "results") return;
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);

  async function identify(img: CapturedImage) {
    setError("");
    setPhoto(img);
    setPhase("identifying");
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: img.base64,
          mediaType: img.mediaType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not identify the product.");

      const product = data.product as ProductIdentity;
      setIdentity(product);
      setDraft({
        name: product.name,
        brand: product.brand,
        model: product.model,
        tagPrice: product.tagPrice === null ? "" : String(product.tagPrice),
      });
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  async function findPrices() {
    setError("");
    setPhase("searching");
    const tagPrice = parseFloat(draft.tagPrice);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          brand: draft.brand,
          model: draft.model,
          tagPrice: Number.isFinite(tagPrice) && tagPrice > 0 ? tagPrice : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not search for prices.");
      setResult(data as PriceResult);
      setPhase("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("confirm");
    }
  }

  function reset() {
    setPhase("idle");
    setError("");
    setPhoto(null);
    setIdentity(null);
    setResult(null);
    setDraft({ name: "", brand: "", model: "", tagPrice: "" });
  }

  /**
   * Reopen the editable form after a search.
   *
   * Clearing the result is the point: leaving old prices on screen under edited
   * inputs would show a verdict for a product the user has just changed.
   */
  function editDetails() {
    setResult(null);
    setError("");
    setPhase("confirm");
  }

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Price Scanner</h1>
        <p>Is that Hong Kong shop price any good?</p>
      </header>

      <div className="stack">
        {error && <div className="error">{error}</div>}

        {phase === "idle" && (
          <div className="card center">
            <CameraCapture onCapture={identify} onError={setError} />
          </div>
        )}

        {phase === "identifying" && <Busy label="Reading the tag…" />}

        {/*
          One screen, not a wizard. The scan stays put and results append below
          it, so there is never a navigation step to undo — pressing browser back
          used to leave the app entirely, since a phase change creates no history
          entry to return to.
        */}
        {(phase === "confirm" || phase === "searching") && identity && (
          <ConfirmStep
            photo={photo}
            identity={identity}
            draft={draft}
            onChange={setDraft}
            onSubmit={findPrices}
            onCancel={reset}
            busy={phase === "searching"}
          />
        )}

        {phase === "searching" && <Busy label="Searching Hong Kong retailers…" />}

        {/*
          Once results exist the editable form collapses to a compact read-only
          summary. Keeping the full form would push the verdict — the thing the
          user actually came for — well below the fold, and would invite edits
          that silently leave the prices below it stale.
        */}
        {phase === "results" && result && (
          <>
            <ScanSummary photo={photo} draft={draft} onEdit={editDetails} />
            <div ref={resultsRef}>
              <div className="stack">
                <Results
                  result={result}
                  productName={draft.name}
                  tagPrice={parseFloat(draft.tagPrice)}
                  onAgain={reset}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** What was scanned, kept visible above the results as read-only context. */
function ScanSummary({
  photo,
  draft,
  onEdit,
}: {
  photo: CapturedImage | null;
  draft: Draft;
  onEdit: () => void;
}) {
  const price = parseFloat(draft.tagPrice);
  return (
    <div className="card scan-summary">
      {photo && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="thumb" src={photo.dataUrl} alt="The product you photographed" />
      )}
      <div className="scan-summary-text">
        <h3>{draft.name}</h3>
        <p className="note">
          {Number.isFinite(price) && price > 0
            ? `Shop price HK$${Math.round(price)}`
            : "No shop price read"}
        </p>
      </div>
      <button className="btn quiet small" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <div className="card center" role="status" aria-live="polite">
      <div className="spinner" />
      <p className="note">{label}</p>
    </div>
  );
}

function ConfirmStep({
  photo,
  identity,
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  photo: CapturedImage | null;
  identity: ProductIdentity;
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [k]: e.target.value });

  return (
    <>
      {photo && (
        <div className="card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="preview" src={photo.dataUrl} alt="The product you photographed" />
        </div>
      )}

      <div className="card">
        <h2>Check what was read</h2>
        <p className="note" style={{ margin: "4px 0 14px" }}>
          Correct anything wrong before searching — a wrong model finds the wrong
          product&rsquo;s prices.
        </p>

        {identity.confidence < 0.6 && (
          <div className="warning" style={{ marginBottom: 14 }}>
            Low confidence in this identification. Check the name carefully, or
            retake the photo closer to the label.
          </div>
        )}

        {/*
          Confidence alone does not predict a useful search. A shelf photo of a
          dozen laptops yields "ASUS Laptop" at confidence 0.8 — correct, but far
          too vague to price, and the search then quietly prices some *other*
          model. Missing specificity is the signal that actually matters, so it
          gets its own warning regardless of confidence.
        */}
        {!draft.model.trim() && (
          <div className="warning" style={{ marginBottom: 14 }}>
            No model number was read. Prices found will be for whichever variant
            the search picks, which may not be this one. Add the model from the
            label if you can — it is the single biggest accuracy win.
          </div>
        )}

        <label className="field">
          <span>Product</span>
          <input value={draft.name} onChange={set("name")} disabled={busy} />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Brand</span>
            <input value={draft.brand} onChange={set("brand")} disabled={busy} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={draft.model} onChange={set("model")} disabled={busy} />
          </label>
        </div>

        <label className="field">
          <span>Shop price (HK$)</span>
          <input
            value={draft.tagPrice}
            onChange={set("tagPrice")}
            inputMode="decimal"
            placeholder="Not read from the tag"
            disabled={busy}
          />
        </label>

        {identity.assumptions && (
          <p className="note" style={{ marginBottom: 14 }}>
            {identity.assumptions}
          </p>
        )}

        <div className="btn-row">
          <button className="btn quiet" onClick={onCancel} disabled={busy}>
            Start over
          </button>
          <button className="btn" onClick={onSubmit} disabled={busy || !draft.name.trim()}>
            Find prices
          </button>
        </div>
      </div>
    </>
  );
}

/** Compare the shop's tag price against the cheapest price found. */
function verdictFor(tagPrice: number, cheapest: number) {
  const diff = tagPrice - cheapest;
  if (tagPrice <= cheapest * 1.02) {
    return {
      tone: "good",
      label: "Good price",
      detail:
        diff < 0
          ? `HK$${Math.round(-diff)} cheaper than anything found online.`
          : "Matches the cheapest price found.",
    };
  }
  if (tagPrice <= cheapest * 1.15) {
    return {
      tone: "fair",
      label: "About right",
      detail: `HK$${Math.round(diff)} above the cheapest found — close enough that stock and warranty may matter more.`,
    };
  }
  return {
    tone: "poor",
    label: "You can do better",
    detail: `HK$${Math.round(diff)} above the cheapest found (${Math.round((diff / cheapest) * 100)}% more).`,
  };
}

function Results({
  result,
  productName,
  tagPrice,
  onAgain,
}: {
  result: PriceResult;
  productName: string;
  tagPrice: number;
  onAgain: () => void;
}) {
  const { quotes, citations, searchSuggestionsHtml, summary, grounded } = result;
  const cheapest = quotes.length > 0 ? quotes[0].price : null;
  const hasTag = Number.isFinite(tagPrice) && tagPrice > 0;

  // Grounding is not guaranteed: the model sometimes answers a vague query from
  // memory instead of searching, returning confident prices with no citations
  // and no Search Suggestions. Those numbers are recollection, not evidence, so
  // they must not drive a verdict — a red "you can do better" sourced from
  // nothing is worse than no verdict at all.
  const trustworthy = grounded && quotes.length > 0;
  const verdict =
    trustworthy && hasTag && cheapest !== null ? verdictFor(tagPrice, cheapest) : null;

  return (
    <>
      {!grounded && quotes.length > 0 && (
        <div className="warning">
          These prices came back without any web sources attached, so they may be
          from the model&rsquo;s memory rather than current listings. Treat them
          as a rough guide only and check the retailer directly.
        </div>
      )}

      {verdict && (
        <div className={`card verdict ${verdict.tone}`}>
          <div className="verdict-label">{verdict.label}</div>
          <p>
            Shop price HK${Math.round(tagPrice)}. {verdict.detail}
          </p>
        </div>
      )}

      <div className="card">
        <h2>{quotes.length > 0 ? "Prices found" : "No prices found"}</h2>
        <p className="note" style={{ marginTop: 4 }}>
          {productName}
        </p>

        {quotes.length === 0 ? (
          <p className="note" style={{ marginTop: 12 }}>
            No genuine Hong Kong prices came back. Try a more specific product
            name, or check the model number.
          </p>
        ) : (
          <div style={{ marginTop: 10 }}>
            {quotes.map((q, i) => (
              <div className={`quote ${i === 0 ? "cheapest" : ""}`} key={`${q.url}-${i}`}>
                <div>
                  {/* Every quote is an attributed outbound link to its source —
                      never a mirrored catalogue entry. */}
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
        )}
      </div>

      {summary && (
        <div className="card">
          <h3>What this means</h3>
          <div
            className="summary"
            style={{ marginTop: 8 }}
            dangerouslySetInnerHTML={{ __html: markdownToHtml(summary) }}
          />
        </div>
      )}

      {citations.length > 0 && (
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

      {/*
        Google Search Suggestions. Rendering this is REQUIRED by the Gemini API
        terms whenever Search grounding is used — it is not decoration and must
        not be conditionally hidden, collapsed or restyled away.
      */}
      {searchSuggestionsHtml && (
        <div
          className="search-suggestions"
          dangerouslySetInnerHTML={{ __html: searchSuggestionsHtml }}
        />
      )}

      <p className="disclaimer">
        Prices are retrieved by AI from live web search and may be out of date,
        exclude delivery, or refer to a different variant. Always verify in store
        before buying.
      </p>

      <button className="btn block alt" onClick={onAgain}>
        Scan another
      </button>
    </>
  );
}
