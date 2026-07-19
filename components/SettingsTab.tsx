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

      <div className="card">
        <h2>Daily limits</h2>
        <p className="note" style={{ marginTop: 4 }}>
          Product identification and price searches are capped at 40 each per day.
          Grounded search is billed per query, so the cap is a cost control rather
          than only abuse protection.
        </p>
      </div>
    </div>
  );
}
