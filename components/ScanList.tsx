"use client";

import { useCallback, useEffect, useState } from "react";
import { Scan } from "@/lib/types";
import { districtById } from "@/lib/hkDistricts";

/**
 * The saved-scan list, used for both the History and Watch tabs.
 *
 * One component with a `watchingOnly` flag rather than two: Watch differs only
 * by a query filter. There is no re-check mechanism yet — `price_points` exists
 * but nothing writes to it — so a separate component would be a copy of this
 * one with no behavioural difference.
 */

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-HK", {
    timeZone: "Asia/Hong_Kong",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How the shop price compared, at the time of the scan. */
function verdictOf(scan: Scan): { tone: string; text: string } | null {
  const tag = scan.product.tagPrice;
  if (tag === null || scan.bestPrice === null) return null;
  const diff = tag - scan.bestPrice;
  if (tag <= scan.bestPrice * 1.02) return { tone: "good", text: "Good price" };
  if (tag <= scan.bestPrice * 1.15) return { tone: "fair", text: "About right" };
  return { tone: "poor", text: `HK$${Math.round(diff)} over` };
}

export default function ScanList({ watchingOnly = false }: { watchingOnly?: boolean }) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/scans${watchingOnly ? "?watching=true" : ""}`);
      const data = await res.json();
      if (!res.ok) {
        // 501 is "no database", which is a configuration state rather than a
        // fault — say so plainly instead of showing a generic failure.
        setError(
          res.status === 501
            ? "Saved scans need a database. None is configured for this environment."
            : (data.error ?? "Could not load scans."),
        );
        setScans([]);
        return;
      }
      setScans(data.scans as Scan[]);
    } catch {
      setError("Could not reach the server.");
      setScans([]);
    }
  }, [watchingOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleWatch(scan: Scan) {
    setBusyId(scan.id);
    try {
      await fetch(`/api/scans/${scan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watching: !scan.watching }),
      });
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function remove(scan: Scan) {
    // Deleting a scan is not recoverable and the row is the only copy, so it
    // asks first. Everything else here is reversible with another tap.
    if (!confirm(`Delete the scan of ${scan.product.name}?`)) return;
    setBusyId(scan.id);
    try {
      await fetch(`/api/scans/${scan.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusyId("");
    }
  }

  if (scans === null) {
    return (
      <div className="card center" role="status" aria-live="polite">
        <div className="spinner" />
        <p className="note">Loading…</p>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="warning">{error}</div>}

      {!error && scans.length === 0 && (
        <div className="card center">
          <p className="note">
            {watchingOnly
              ? "Nothing tracked yet. Tap ☆ on a scan in History to follow its price."
              : "No saved scans yet. Scans are kept automatically once a price search finishes."}
          </p>
        </div>
      )}

      {scans.map((scan) => {
        const verdict = verdictOf(scan);
        const district = scan.district ? districtById(scan.district) : undefined;
        return (
          <div className="card scan-row" key={scan.id}>
            <div className="scan-row-head">
              <div className="scan-row-title">
                <h3>{scan.product.name}</h3>
                <p className="quote-meta">
                  {[
                    formatWhen(scan.timestamp),
                    district?.en,
                    scan.product.tagPrice !== null
                      ? `shop HK$${Math.round(scan.product.tagPrice)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {verdict && (
                <span className={`pill ${verdict.tone}`}>{verdict.text}</span>
              )}
            </div>

            <p className="note" style={{ marginTop: 8 }}>
              {scan.bestPrice !== null
                ? `Best found: HK$${Math.round(scan.bestPrice)}${
                    scan.bestSource ? ` at ${scan.bestSource}` : ""
                  }`
                : "No exact-model price was found for this scan."}
            </p>

            {scan.notes && (
              <p className="note" style={{ marginTop: 6 }}>
                {scan.notes}
              </p>
            )}

            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="btn quiet small"
                disabled={busyId === scan.id}
                onClick={() => toggleWatch(scan)}
              >
                {scan.watching ? "★ Tracking" : "☆ Track"}
              </button>
              <button
                className="btn quiet small"
                disabled={busyId === scan.id}
                onClick={() => remove(scan)}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
