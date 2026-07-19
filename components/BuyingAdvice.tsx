"use client";

import { useState } from "react";
import { markdownToHtml } from "@/lib/markdown";
import { PriceQuote } from "@/lib/types";

/**
 * Buying advice, fetched on demand.
 *
 * On demand, not automatically, for two reasons. It is a billed AI call capped
 * at 20/day, and most scans do not need it — the verdict and the price list
 * already answer "is this a good price". Advice answers a different question
 * ("should I buy it *here*"), which only some scans raise.
 *
 * Self-contained rather than lifted into the page: nothing else needs the
 * advice text, and threading four more props through Results to reach it would
 * be all cost and no benefit.
 */

export default function BuyingAdvice({
  name,
  brand,
  model,
  tagPrice,
  quotes,
}: {
  name: string;
  brand: string;
  model: string;
  tagPrice: number | null;
  quotes: PriceQuote[];
}) {
  const [advice, setAdvice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Advice on a product the shopper is not holding is the harm finding #5
  // describes, so the route refuses without an exact-model quote. Hiding the
  // button is kinder than offering one that always fails.
  const hasExact = quotes.some((q) => q.exactModel);
  if (!hasExact) return null;

  async function load() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, brand, model, tagPrice, quotes }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not get advice.");
        return;
      }
      setAdvice(data.advice as string);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (advice) {
    return (
      <div className="card">
        <h3>Buying it here</h3>
        <div
          className="summary"
          style={{ marginTop: 8 }}
          dangerouslySetInnerHTML={{ __html: markdownToHtml(advice) }}
        />
      </div>
    );
  }

  return (
    <div className="card center">
      {error && (
        <div className="warning" style={{ marginBottom: 12, textAlign: "left" }}>
          {error}
        </div>
      )}
      {busy ? (
        <div role="status" aria-live="polite">
          <div className="spinner" />
          <p className="note">Thinking it through…</p>
        </div>
      ) : (
        <>
          <button className="btn block alt" onClick={load}>
            Should I buy it here?
          </button>
          <p className="note" style={{ marginTop: 8 }}>
            Warranty, official vs parallel import, and what to check before paying.
          </p>
        </>
      )}
    </div>
  );
}
