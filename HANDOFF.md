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
| ✅ `/api/identify` — vision + structured output | passes on rendered tags, **fails on a real shelf photo — see below** |
| ✅ `/api/prices` — grounded search | **passed: 6 real HK retailers** |
| ✅ Scan flow UI — capture → identify → confirm → search → results | `app/page.tsx`, verified end-to-end in browser |
| ⬜ `/api/scans` CRUD, `/api/advice` | not started — **scans are not persisted; reload loses the result** |
| ⬜ History / Watch / Settings tabs | not started |
| ⬜ GitHub repo | **not created yet** — must be **PUBLIC**, see below |
| ⬜ Neon DB, Vercel project | not created yet |

Local git history exists; nothing has been pushed anywhere.

**Create this repo PUBLIC, and commit with the user's real git identity.** The
user initially chose private; that was reversed after it broke deployments on
the sibling project, and the same trap is waiting here:

- On Vercel's **Hobby** plan, a *private* repo only accepts deployments from
  commits authored by a recognised team member. The user's commits are authored
  as an Apple relay address that does not match their Vercel account, so every
  commit is treated as an outside contributor and the deployment is `BLOCKED` —
  no build, no build logs, and the previously-deployed version keeps serving as
  if nothing is wrong. Public repos skip the check entirely.
- **Never pass `-c user.name` / `-c user.email` to `git commit`.** A placeholder
  like `noreply@localhost` is rejected by Vercel outright. Let the repo's own
  git config apply.
- Public is safe here: the only secret is `GEMINI_API_KEY`, which lives in
  `.env.local` and is covered by the broad `.env*` ignore rule.

`components/TabBar.tsx` is inherited from the Calorie Tracker and still has its
tabs (`today | history | coach | settings`). Nothing imports it. Retab or delete
it when the tab bar is actually built — do not assume it fits this app.

## Three verified findings that should shape the next session

**1. Gate 1 FAILED on a real photo — but not the way this doc predicted.**
Tested against a real Mong Kok ASUS counter display (a shelf of ~12 laptops,
~10 starburst price tags, glare, shot at an angle, a stranger in frame).

Glare and angle were *not* the problem. The OCR was fine: it read the correct
**HK$4,498** off an angled starburst among ten competing tags. What broke is an
assumption nobody had written down — **the app assumes one product and one tag.**
A real shop shelf is a counter of twelve. The result:

```
name: "ASUS Laptop"   model: ""   tagPrice: 4498
confidence: 0.8       storeName: "ASUS"   locationHint: ""
```

Every field is *correct* and the result is *useless for a price search*. Note
`confidence: 0.8` — well above any sane warning threshold. **Confidence measures
whether the identification is right, not whether it is specific enough to price.**
Those two come apart exactly when it matters, so do not gate on confidence alone.
(`storeName: "ASUS"` is the display fixture branding, not the shop.)

**The downstream failure is the serious one.** Feeding that identity to
`/api/prices` returned 8 confident quotes, every one for a *Vivobook X1504VA /
X1405VA / X1404VA* — a model never identified from the photo. It silently picked
a plausible laptop and priced that. The UI would have rendered a red
"You can do better — HK$918 above the cheapest (26% more)", comparing an unknown
laptop against a guessed one. A shopper could walk away from a good deal on that.

The current mitigation is a missing-model warning in the confirm step
(`app/page.tsx`), independent of confidence. That is a backstop, not a fix.

**2. `/api/prices` sometimes does not ground at all — intermittently.** One run
returned `grounded: false` with 8 priced quotes, zero citations and zero Search
Suggestions: the model answered from memory instead of searching. Re-running the
identical request twice gave `true`, `true`. **It is nondeterministic**, which
means it will not show up reliably in testing.

Consequences: unsourced recollections would otherwise render identically to
sourced quotes, and `searchSuggestionsHtml` comes back empty so the required
Google markup silently disappears. `app/page.tsx` now suppresses the verdict and
warns when `grounded` is false — but **that branch has never been observed live**,
only reasoned about, because the condition cannot be triggered on demand.
Retrying the call once when grounding does not fire is still an open task.

**3. The district filter is weaker than planned.** Gate 2 returned six genuine HK
prices with an empty `district` on every one; the real-photo run added five more
of the same. Eleven-plus results, effectively no districts, because grounded
results are overwhelmingly *online* retailers with no physical location. The
"filter by nearest store" feature applies to a small minority of results. See
task #43 — recommend the online/in-store split plus a manually-set home district.

Curiosity worth watching, not yet a conclusion: the only run that *did* populate
districts (`wan-chai`, `sham-shui-po`, `yuen-long`) was the ungrounded one, where
they came from recalled price.com.hk listings. n=1, but "districts appear when
the data is least verifiable" would be an unpleasant pattern if it holds.

## Gotchas already paid for (do not rediscover)

- **In a HK electronics shop, the model number is not on the product — it is on
  the small printed spec card beside it.** The capture prompt therefore asks for
  the spec/price card, not the laptop. This looks like a cosmetic copy change and
  is not: it is the cheapest available fix for finding #1, because a photo of the
  product itself structurally cannot yield a SKU.
- **Tap-to-select was considered and rejected as the next step.** It solves
  *disambiguation* (which tag belongs to which item) but not *specificity* —
  cropping to one laptop still yields no model number, and specificity is what
  actually broke the price search. Revisit only if the spec-card framing fails.
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
