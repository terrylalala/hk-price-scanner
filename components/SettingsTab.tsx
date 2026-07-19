"use client";

import { useEffect, useState } from "react";
import { HK_DISTRICTS } from "@/lib/hkDistricts";
import { UserSettings } from "@/lib/types";

/**
 * Settings.
 *
 * The home district is set by hand, not detected. Grounded search almost never
 * reports a district — most results are online retailers with no physical
 * location — so there is nothing reliable to infer it from (finding #4).
 *
 * NOTE this stores the preference only. Whether and how it filters results is
 * still an open decision (task 7), so nothing reads it yet. That is deliberate:
 * storing a preference is reversible, changing how prices are ranked is not.
 */

interface UsageDay {
  day: string;
  identify: number;
  prices: number;
  advice: number;
}

/**
 * Recent usage, so the daily caps can be tuned against what actually happens
 * rather than against a guess.
 *
 * Leads with the MONTHLY price-search total, because that is the number tied to
 * money: the free tier and the spend cap both reset monthly, and daily figures
 * on bursty usage — several scans in one shop, then nothing for days — say very
 * little on their own.
 */
function UsagePanel() {
  const [days, setDays] = useState<UsageDay[] | null>(null);
  const [month, setMonth] = useState<{
    priceCalls: number;
    estimatedQueries: number;
    freeQueries: number;
  } | null>(null);
  const [limits, setLimits] = useState<{
    prices: number;
    identify: number;
    advice: number;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/usage");
        if (!res.ok) {
          setUnavailable(true);
          setDays([]);
          return;
        }
        const data = await res.json();
        setDays(data.days ?? []);
        setMonth(data.month ?? null);
        setLimits(data.limits ?? null);
      } catch {
        setUnavailable(true);
        setDays([]);
      }
    })();
  }, []);

  return (
    <div className="card">
      <h2>Usage</h2>

      {month && (
        <p className="note" style={{ marginTop: 6 }}>
          This month: <strong>{month.priceCalls}</strong> price searches, about{" "}
          <strong>{month.estimatedQueries.toLocaleString()}</strong> billed Google
          queries of {month.freeQueries.toLocaleString()} free.
        </p>
      )}

      {/* Reported by the server, not hardcoded: an env override would otherwise
          make these numbers quietly disagree with what is enforced. */}
      {limits && (
        <p className="note" style={{ marginTop: 6 }}>
          Daily caps: <strong>{limits.prices}</strong> price searches,{" "}
          <strong>{limits.identify}</strong> identifications,{" "}
          <strong>{limits.advice}</strong> advice. They are a runaway guard, not
          the budget — the HK$150 monthly spend cap on the Google project is the
          real ceiling, and it stops the API outright.
        </p>
      )}

      {days === null && <p className="note" style={{ marginTop: 10 }}>Loading…</p>}

      {unavailable && (
        <p className="note" style={{ marginTop: 10 }}>
          Usage needs a database, and none is configured here.
        </p>
      )}

      {days && days.length === 0 && !unavailable && (
        <p className="note" style={{ marginTop: 10 }}>
          Nothing recorded in the last three weeks.
        </p>
      )}

      {days && days.length > 0 && (
        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Searches</th>
                <th>IDs</th>
                <th>Advice</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.prices}</td>
                  <td>{d.identify}</td>
                  <td>{d.advice}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SettingsTab() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        setSettings(data.settings ?? { homeDistrict: "" });
        setPersisted(data.persisted !== false);
      } catch {
        setSettings({ homeDistrict: "" });
        setPersisted(false);
      }
    })();
  }, []);

  async function save(next: UserSettings) {
    setSettings(next);
    setStatus("Saving…");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setStatus(res.ok ? "Saved" : "Could not save");
      if (res.ok) setPersisted(true);
    } catch {
      setStatus("Could not save");
    }
    setTimeout(() => setStatus(""), 2000);
  }

  if (!settings) {
    return (
      <div className="card center" role="status" aria-live="polite">
        <div className="spinner" />
        <p className="note">Loading…</p>
      </div>
    );
  }

  const byRegion = HK_DISTRICTS.reduce<Record<string, typeof HK_DISTRICTS>>(
    (acc, d) => {
      (acc[d.region] ??= []).push(d);
      return acc;
    },
    {},
  );

  return (
    <div className="stack">
      <div className="card">
        <h2>Home district</h2>
        <p className="note" style={{ marginTop: 4, marginBottom: 12 }}>
          Where you usually shop. Set by hand — price results rarely name a
          district, so it cannot be worked out from your scans.
        </p>

        <label className="field">
          <span>District</span>
          <select
            className="select"
            value={settings.homeDistrict}
            onChange={(e) => save({ ...settings, homeDistrict: e.target.value })}
          >
            <option value="">Not set</option>
            {Object.entries(byRegion).map(([region, districts]) => (
              <optgroup key={region} label={region}>
                {districts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.en} · {d.zh}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {status && <p className="note">{status}</p>}

        {!persisted && (
          <div className="warning" style={{ marginTop: 10 }}>
            No database is configured here, so this setting cannot be saved.
          </div>
        )}

        <p className="note" style={{ marginTop: 12 }}>
          Nothing uses this yet. How local shops should be weighted against online
          ones is still undecided, and guessing would change which price the app
          calls &ldquo;best&rdquo;.
        </p>
      </div>

      <UsagePanel />
    </div>
  );
}
