"use client";

import { useEffect, useRef, useState } from "react";
import CameraCapture, { CapturedImage } from "@/components/CameraCapture";
import TabBar, { Tab } from "@/components/TabBar";
import ScanList from "@/components/ScanList";
import SettingsTab from "@/components/SettingsTab";
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

const SCAN_KEY = "price-scanner:scan";

/**
 * Categories whose products carry no model number, so the missing-model warning
 * would be noise. Matched as substrings against the free-text category from
 * /api/identify (e.g. "Wine", "Voice Recorder", "Ceiling light").
 */
const MODEL_LESS_CATEGORIES = [
  "wine",
  "beer",
  "spirit",
  "whisky",
  "whiskey",
  "sake",
  "liquor",
  "drink",
  "beverage",
  "juice",
  "water",
  "coffee",
  "tea",
  "food",
  "snack",
  "confection",
  "chocolate",
  "grocer",
  "produce",
  "fruit",
  "vegetable",
  "meat",
  "seafood",
  "supplement",
  "vitamin",
  "cosmetic",
  "skincare",
  "makeup",
  "perfume",
  "fragrance",
  "shampoo",
  "soap",
  "detergent",
  "clothing",
  "apparel",
  "shoe",
  "book",
  "stationery",
];

/**
 * Whether a missing model number is worth warning about for this category.
 *
 * Deliberately a DENY-list, warning by default. The two failure modes are not
 * symmetric: a spurious warning is mild noise, while a missed one lets the
 * search price a different product and produce a confident wrong verdict — the
 * bug this warning exists to prevent. So an unrecognised category still warns.
 *
 * The trigger was a bottle of wine: identification was perfect, but the warning
 * told the shopper to "add the model from the label", which does not exist.
 */
function hasModelNumbers(category: string): boolean {
  const c = category.trim().toLowerCase();
  if (!c) return true;
  return !MODEL_LESS_CATEGORIES.some((m) => c.includes(m));
}

interface SavedScan {
  photo?: CapturedImage | null;
  identity: ProductIdentity | null;
  draft: Draft;
  result?: PriceResult | null;
}

/**
 * Persist the current scan for the tab.
 *
 * sessionStorage rather than localStorage: a scan is about the shop you are
 * standing in, so it should not still be sitting there next week.
 *
 * The photo is a base64 data URL and is by far the largest field — a 1600px
 * JPEG can approach the ~5MB quota on its own. If the write is rejected, retry
 * without it: losing the thumbnail is a much smaller loss than losing the
 * prices, which cost a billed search to obtain.
 */
function save(scan: SavedScan) {
  try {
    sessionStorage.setItem(SCAN_KEY, JSON.stringify(scan));
  } catch {
    try {
      sessionStorage.setItem(SCAN_KEY, JSON.stringify({ ...scan, photo: null }));
    } catch {
      // Private browsing or a hard quota wall. Nothing more to do.
    }
  }
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [unreadable, setUnreadable] = useState(false);
  const [district, setDistrict] = useState("");
  const [tab, setTab] = useState<Tab>("scan");
  const [photo, setPhoto] = useState<CapturedImage | null>(null);
  const [identity, setIdentity] = useState<ProductIdentity | null>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    brand: "",
    model: "",
    tagPrice: "",
  });
  const [result, setResult] = useState<PriceResult | null>(null);
  const [restored, setRestored] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Restore a scan in progress. Without this, anything that reloads the page —
  // browser back after tapping a shop link, a swipe-back gesture, an OS tab
  // eviction on mobile — drops the user on an empty camera screen with the
  // results silently gone. /api/scans will supersede this; until it exists this
  // is the difference between "back" working and losing the scan.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SCAN_KEY);
      if (saved) {
        const s = JSON.parse(saved) as SavedScan;
        if (s.identity && s.draft) {
          setPhoto(s.photo ?? null);
          setIdentity(s.identity);
          setDraft(s.draft);
          setResult(s.result ?? null);
          setPhase(s.result ? "results" : "confirm");
        }
      }
    } catch {
      // Corrupt or unreadable storage is not worth surfacing — start clean.
    }
    setRestored(true);
  }, []);

  // Persist after the restore pass, never before: writing on the first render
  // would clobber the saved scan with the empty initial state.
  useEffect(() => {
    if (!restored) return;
    try {
      if (phase === "idle" || !identity) {
        sessionStorage.removeItem(SCAN_KEY);
        return;
      }
      save({ photo, identity, draft, result });
    } catch {
      // Quota or private-mode failures are non-fatal; the app still works.
    }
  }, [restored, phase, photo, identity, draft, result]);

  // The scan stays on one screen and results append below it, so after a search
  // the interesting part is off-screen. Bring it into view rather than leaving
  // the user looking at the form they just submitted.
  useEffect(() => {
    if (phase !== "results") return;
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);

  async function identify(img: CapturedImage) {
    setError("");
    setUnreadable(false);
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

      // 422 (the photo could not be analysed) and 502 (the reply could not be
      // parsed) both mean "this photo did not work", not "the app is broken".
      // A red failure banner puts that on the user as a fault; it is an ordinary
      // outcome of photographing a shelf in a shop, and the useful response is
      // advice on the next shot.
      if (res.status === 422 || res.status === 502) {
        setUnreadable(true);
        setPhase("idle");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Could not identify the product.");

      const product = data.product as ProductIdentity;
      setIdentity(product);
      // /api/identify derives this from locationHint; the client would otherwise
      // drop it, and the scan would be saved without a district it already knew.
      setDistrict(typeof data.district === "string" ? data.district : "");
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
      void saveScan(data as PriceResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("confirm");
    }
  }

  /**
   * Persist a completed scan.
   *
   * Deliberately fire-and-forget, and deliberately quiet on failure: the search
   * already succeeded and its result is on screen, so interrupting with a
   * storage error would be louder than the problem. sessionStorage still holds
   * the scan, so nothing visible is lost either way.
   *
   * This is only defensible while nothing SHOWS saved scans. Once the History
   * tab exists (task 9), a silent failure becomes a scan the user believes was
   * kept and cannot find — surface it then.
   */
  async function saveScan(priced: PriceResult) {
    if (!identity) return;
    try {
      const tag = parseFloat(draft.tagPrice);
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: {
            ...identity,
            name: draft.name,
            brand: draft.brand,
            model: draft.model,
            tagPrice: Number.isFinite(tag) && tag > 0 ? tag : null,
          },
          district,
          quotes: priced.quotes,
          citations: priced.citations,
        }),
      });
      if (!res.ok && res.status !== 501) {
        // 501 is the expected answer with no database configured, not a fault.
        console.warn("[saveScan] failed", res.status, await res.text());
      }
    } catch (err) {
      console.warn("[saveScan] failed", err);
    }
  }

  function reset() {
    setPhase("idle");
    setError("");
    setUnreadable(false);
    setDistrict("");
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

  const TITLES: Record<Tab, { h1: string; sub: string }> = {
    scan: { h1: "Price Scanner", sub: "Is that Hong Kong shop price any good?" },
    history: { h1: "History", sub: "Every scan you have saved" },
    watch: { h1: "Watch", sub: "Products you are tracking" },
    settings: { h1: "Settings", sub: "" },
  };

  return (
    <main className="shell has-tabbar">
      <header className="masthead">
        <h1>{TITLES[tab].h1}</h1>
        {TITLES[tab].sub && <p>{TITLES[tab].sub}</p>}
      </header>

      {tab === "history" && <ScanList />}
      {tab === "watch" && <ScanList watchingOnly />}
      {tab === "settings" && <SettingsTab />}

      {/*
        The scan flow stays mounted across tab switches, hidden rather than
        unmounted. Unmounting would discard an in-progress scan — the photo and
        the confirm-step edits — the moment someone glanced at History, which is
        the same class of loss the sessionStorage work fixed for reloads.
      */}
      <div style={{ display: tab === "scan" ? undefined : "none" }}>
      <div className="stack">
        {/*
          An unreadable photo is a normal outcome in a shop, not a failure of the
          app, so it gets advice in a warning tone rather than a red error. The
          guidance is drawn from what actually worked in testing: close on the
          printed label beats a wide shot of the product.
        */}
        {unreadable ? (
          <div className="warning">
            <strong>That photo didn&rsquo;t come out clearly.</strong> Try again,
            closer to the printed label, so the product name and price fill the
            frame. Tilting slightly away from overhead lights avoids the glare
            that washes out small print.
          </div>
        ) : (
          error && <div className="error">{error}</div>
        )}

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
                  onRetry={findPrices}
                />
              </div>
            </div>
          </>
        )}
      </div>
      </div>

      <TabBar active={tab} onChange={setTab} />
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
        {!draft.model.trim() && hasModelNumbers(identity.category) && (
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
  onRetry,
}: {
  result: PriceResult;
  productName: string;
  tagPrice: number;
  onAgain: () => void;
  /** Re-run the same search. User-initiated on purpose — see the empty branch. */
  onRetry: () => void;
}) {
  const { quotes, citations, searchSuggestionsHtml, summary, grounded } = result;
  const hasTag = Number.isFinite(tagPrice) && tagPrice > 0;

  /*
    Only quotes for the SAME model may be judged against.

    A D45 scan returned four prices, every one for a 米家吸頂燈450. Taking the
    cheapest overall produced a confident red "27% more" against a different
    product — and the official listing's own original price for that other model
    was HK$469, the shopper's exact tag. The substitution was flagged in each
    note, but prose cannot be acted on, so the app judged on it anyway.

    Quotes stay sorted by price for display; the verdict uses the cheapest
    EXACT-model quote, which is not necessarily the first row.
  */
  const exactQuotes = quotes.filter((q) => q.exactModel);
  const cheapestExact = exactQuotes.length > 0 ? exactQuotes[0] : null;
  const substitutedOnly = quotes.length > 0 && exactQuotes.length === 0;

  // Grounding is not guaranteed: the model sometimes answers a vague query from
  // memory instead of searching, returning confident prices with no citations
  // and no Search Suggestions. Those numbers are recollection, not evidence, so
  // they must not drive a verdict — a red "you can do better" sourced from
  // nothing is worse than no verdict at all.
  const trustworthy = grounded && quotes.length > 0;
  const verdict =
    trustworthy && hasTag && cheapestExact
      ? verdictFor(tagPrice, cheapestExact.price)
      : null;

  return (
    <>
      {!grounded && quotes.length > 0 && (
        <div className="warning">
          These prices came back without any web sources attached, so they may be
          from the model&rsquo;s memory rather than current listings. Treat them
          as a rough guide only and check the retailer directly.
        </div>
      )}

      {substitutedOnly && (
        <div className="warning">
          <strong>No prices found for this exact model.</strong> Everything below
          is a similar but different product, so there is no verdict — comparing
          your shop price against them would be misleading. Check the model
          number on the label, or use these only as a rough guide.
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
          /*
            An empty result is NOT reliably the user's fault, and the old copy
            ("try a more specific product name") said it was. The search comes
            back empty intermittently — six consecutive empty runs were measured
            on a query that had worked moments earlier and worked again after.
            Sending someone off to rewrite a perfectly good product name is the
            worst possible advice for a transient failure.

            Retrying is offered as a BUTTON rather than done automatically: an
            automatic retry doubles a request that already takes 46–48s of a 50s
            budget, and silently spends a second billed search. Letting the
            shopper choose costs neither.
          */
          <div style={{ marginTop: 12 }}>
            <p className="note">
              No Hong Kong prices came back. This search is unreliable and
              sometimes returns nothing for a product it found a moment earlier,
              so trying again is usually worth more than editing the name.
            </p>
            <button
              className="btn block alt"
              style={{ marginTop: 12 }}
              onClick={onRetry}
            >
              Search again
            </button>
            <p className="note" style={{ marginTop: 10 }}>
              If it stays empty, the product may genuinely not be sold online in
              Hong Kong — or the model number needs checking.
            </p>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {quotes.map((q, i) => (
              <div
                /* The green "cheapest" marker follows the VERDICT, not row 0.
                   Highlighting a cheaper substituted quote would point the
                   shopper at the number the app just refused to judge on. */
                className={`quote ${q === cheapestExact ? "cheapest" : ""} ${
                  q.exactModel ? "" : "substituted"
                }`}
                key={`${q.url}-${i}`}
              >
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
                  {/* A substitution has to be visible at a glance. Left in the
                      grey meta line it read as a footnote, and the app judged
                      the shopper's price against it regardless. */}
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
