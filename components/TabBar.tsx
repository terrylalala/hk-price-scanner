"use client";

export type Tab = "today" | "history" | "coach" | "settings";

const TABS: { id: Tab; label: string; icon: string; iconActive: string }[] = [
  { id: "today", label: "Today", icon: "☾", iconActive: "☾" },
  { id: "history", label: "History", icon: "◇", iconActive: "◆" },
  { id: "coach", label: "Coach", icon: "☆", iconActive: "★" },
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
