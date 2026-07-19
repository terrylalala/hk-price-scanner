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

/**
 * A faceted gem, drawn rather than typed.
 *
 * Unicode has no cut-diamond glyph — ◈ collided with History's ◇ and the
 * pentagon ⬠ is the wrong shape and carries its own metrics, which is what
 * pushed one label out of line. Drawing it also means the facets survive at
 * 20px, which is the whole point of the shape.
 *
 * `currentColor` throughout, so it inherits the tab's active accent exactly as
 * the text glyphs do. Filled when active, matching ◇→◆ and ☆→★.
 */
function GemIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M6 3 L18 3 L22 9 L12 21 L2 9 Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Facets, hidden when filled — they would read as cracks on a solid
          shape at this size. */}
      {!filled && (
        <g stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round">
          <path d="M2 9 H22" />
          <path d="M6 3 L9 9 L12 21 L15 9 L18 3" />
        </g>
      )}
    </svg>
  );
}

const TABS: { id: Tab; label: string; icon: string; iconActive: string }[] = [
  { id: "scan", label: "Scan", icon: "◎", iconActive: "◉" },
  { id: "history", label: "History", icon: "◇", iconActive: "◆" },
  { id: "watch", label: "Wishlist", icon: "☆", iconActive: "★" },
  // Rendered as GemIcon rather than a glyph; these are unused for this tab but
  // kept so the array stays one shape.
  { id: "treasures", label: "Treasures", icon: "", iconActive: "" },
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
              <span className="ico" data-tab={t.id}>
                {t.id === "treasures" ? (
                  <GemIcon filled={isActive} />
                ) : isActive ? (
                  t.iconActive
                ) : (
                  t.icon
                )}
              </span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
