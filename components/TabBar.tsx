"use client";

/**
 * Bottom tab bar.
 *
 * Retabbed from the Calorie Tracker original, which had `today | history |
 * coach | settings`. Only the shape survived; the tabs themselves were wrong for
 * this app and were never wired up.
 *
 * "Wishlist" and "Treasures" both reuse the History list with a filter rather
 * than being distinct views — there is no re-check mechanism yet (the
 * `price_points` table exists but nothing writes to it), so separate components
 * would duplicate the list for no behavioural difference.
 *
 * They filter on genuinely different things, which is why they are two tabs and
 * not one: Wishlist is `watching`, set by hand on anything worth keeping.
 * Treasures is every "find similar" search — things spotted with no price tag,
 * filed automatically because that search is never an answer to "should I buy
 * this now", only a note to come back to.
 */

export type Tab = "scan" | "history" | "watch" | "treasures" | "settings";

const TABS: { id: Tab; label: string; icon: string; iconActive: string }[] = [
  { id: "scan", label: "Scan", icon: "◎", iconActive: "◉" },
  { id: "history", label: "History", icon: "◇", iconActive: "◆" },
  { id: "watch", label: "Wishlist", icon: "☆", iconActive: "★" },
  // Five-sided, so it reads as a cut gem and — more usefully — does not
  // collide with History's ◇/◆, which ◈ did at tab-bar size.
  { id: "treasures", label: "Treasures", icon: "⬠", iconActive: "⬟" },
  { id: "settings", label: "Settings", icon: "○", iconActive: "●" },
];

export default function TabBar({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <nav className="tabbar">
      <div className="tabbar-inner">
        {TABS.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              className={`tab ${isActive ? "active" : ""}`}
              onClick={() => onChange(t.id)}
              aria-label={t.label}
              aria-current={isActive ? "page" : undefined}
            >
              {/* data-tab lets one icon be size-corrected without giving every
                  tab a bespoke class; ⬠/⬟ render narrower than the rest. */}
              <span className="ico" data-tab={t.id}>
                {isActive ? t.iconActive : t.icon}
              </span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
