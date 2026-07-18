# Handoff — HK Price Scanner

Written at the end of the first working session, which ran out of the
**Calorie Tracker** directory. Everything below is already in this repo.

Full plan: `/Users/admin/.claude/plans/create-a-mobile-responsive-web-crystalline-flamingo.md`

## What this app is

Photograph a product (mainly electronics) in a Hong Kong shop. Gemini reads the
product and the price on the tag, then searches the live web for what it
actually sells for in HK, and tells you whether the tag price is any good.

## The one thing you must not undo

The original request was to compare prices by pulling data from **price.com.hk**.
That was researched and rejected — this is not a preference, it is the reason
the architecture looks the way it does:

- `robots.txt` disallows exactly the endpoints the feature needed: `/nearby.php`
  (nearest store), `/map.php`, `/ajax.php` (the JSON endpoint), `/search_mobile.php`
- Terms prohibit copying: 「不進行重製、拷貝、出售、轉售或作任何商業目的之使用」
- No public API or partner feed exists

**The app therefore does not scrape price.com.hk.** It uses Gemini's Grounding
with Google Search, and renders results as attributed outbound links. price.com.hk
often appears as a source and gets click-through traffic — search-engine
behaviour, not harvesting. Do not "improve" this by adding a scraper.

## Compliance obligations already designed in

- `searchSuggestionsHtml` from `/api/prices` **must be rendered**. Google's terms
  require displaying Search Suggestions whenever Search grounding is used. It is
  returned by the route and must not be dropped by the UI.
- Every quote must render as an outbound link to its source.
- Never mirror a catalogue — store price + link + store name only.
- Show a standing disclaimer: prices are AI-retrieved, may be stale, verify in store.

## Status

| | |
|---|---|
| ✅ Scaffold, deps, typecheck clean | `npm run dev` works |
| ✅ `lib/` — db schema, districts, rate limits, session, types | |
| ✅ `/api/identify` — vision + structured output | **passed on a synthetic tag** |
| ✅ `/api/prices` — grounded search | **passed: 6 real HK retailers** |
| ⬜ `/api/scans` CRUD, `/api/advice`, all UI | not started |
| ⬜ GitHub repo | **not created yet** — user chose *private* |
| ⬜ Neon DB, Vercel project | not created yet |

Local git history exists; nothing has been pushed anywhere.

## Two verified findings that should shape the next session

**1. Gate 1 is only half-passed.** `/api/identify` was tested against a *rendered*
price tag, where it correctly picked HK$2,780 over a crossed-out HK$3,290 and a
HK$232/month instalment decoy. It has **never seen a real photograph.** Glare,
angle and small print are the actual risk. Get one real photo from the user and
test before building UI on top of it.

**2. The district filter is weaker than planned.** Gate 2 returned six genuine HK
prices — and every one had an empty `district`, because grounded results are
overwhelmingly *online* retailers with no physical location. The "filter by
nearest store" feature therefore applies to a minority of results. See task #43.
Consider demoting it to an online/in-store split plus a manually-set home district.

## Gotchas already paid for (do not rediscover)

- **Grounding + `responseSchema` do not combine reliably.** `/api/prices`
  deliberately asks for JSON in prose and parses defensively. Grounding metadata
  goes empty in some structured-output combinations, and that metadata carries
  the citations and the required Search Suggestions markup.
- **Thinking settings differ per route, on purpose.** `/api/identify` sets
  `thinkingBudget: 0` (a pure extraction task; thinking tokens truncate the JSON).
  `/api/prices` leaves thinking **on** — it has to reconcile sources.
- **`/api/prices` emits the JSON block BEFORE the prose.** First attempt put prose
  first, hit `maxOutputTokens`, and returned a perfectly plausible summary with the
  JSON silently missing. Order matters; so does the 8192 budget.
- **Model is `gemini-flash-latest`**, an alias. Pinned versions 404 for new keys.
- `.gitignore` uses the broad `.env*` — a narrower rule once missed a
  `.env.local.backup-*` containing live credentials.
- `.env.local` currently holds only `GEMINI_API_KEY`, copied from the Calorie
  Tracker. **The two apps share one key and therefore one quota.** Consider a
  separate key so usage is attributable per app.
- Grounding is **billed per search query**, so `lib/rateLimit.ts` is a cost
  control, not just abuse protection. Caps are on by default.
- When deploying: Vercel's "Redeploy" re-runs the **same commit**. Verify the
  deployed commit SHA — a 200 from a health check proves nothing about what is live.

## Running it

```bash
cd "/Users/admin/Desktop/Claude Code Projects/Price Scanner"
npm run dev            # http://localhost:3000
```

Note: the parent Calorie Tracker's `.claude/launch.json` has a `price-scanner`
entry (port 3040) so the preview tooling could run this app from that session.
A session started *in this directory* doesn't need it — this project has its own
`.claude/launch.json`.
