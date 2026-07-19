"use client";

/**
 * Bottom tab bar.
 *
 * Retabbed from the Calorie Tracker original, which had `today | history |
 * coach | settings`. Only the shape survived; the tabs themselves were wrong for
 * this app and were never wired up.
 *
 * "Watch" reuses the History list filtered to tracked scans rather than being a
 * distinct view — there is no re-check mechanism yet (the `price_points` table
 * exists but nothing writes to it), so a separate component would duplicate the
 * list for no behavioural difference.
 */

export type Tab = "scan" | "history" | "watch" | "settings";

const TABS: { id: Tab; label: string; icon: string; iconActive: string }[] = [
  { id: "scan", label: "Scan", icon: "◎", iconActive: "◉" },
  { id: "history", label: "History", icon: "◇", iconActive: "◆" },
  { id: "watch", label: "Watch", icon: "☆", iconActive: "★" },
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
              <span className="ico">{isActive ? t.iconActive : t.icon}</span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
