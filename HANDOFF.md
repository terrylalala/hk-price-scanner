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
| ✅ `/api/identify` — vision + structured output | passes on close-ups of a single item incl. a real shelf label; **fails on a multi-product shelf — see finding #1** |
| ⚠️ `/api/prices` — grounded search | works, but **unreliable in five distinct ways — see finding #6** |
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

## Verified findings that should shape the next session

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

**Update — two further real photos, both PASSED.** The remedy (get close to one
item) is validated; only the multi-product shelf case remains broken.

*A. Plaud Note Pro retail box, close up* (`confidence: 1.0`)
```
name: "Plaud Note Pro AI Note Taker"   brand: "Plaud"   model: "Note Pro"
tagPrice: null   storeName: ""   locationHint: ""
```
Three predicted failures did **not** materialise, and the predictions are recorded
here so nobody re-derives them as risks: the Vast World Limited warranty sticker
did *not* leak 鰂魚涌 into `locationHint` (predicted an `eastern` false positive);
the distributor was *not* misread as `storeName`; and the `$165` electronics
recycling levy on a paper in frame was *not* misread as the price. `tagPrice: null`
was correct — there is no price on the box. Downstream: 6 grounded quotes, all at
HK$1,399, 8 citations. Photo was stored rotated 90° and that caused no trouble.

*B. Supermarket shelf label, Korean raspberry wine* (`confidence: 0.95`) — the
harder and more valuable test, because it has a **dual price and neither is
crossed out**: 直送公價 `$69.00` versus 會員77折實價 `$53.10`, the member price
rendered much larger and bolder.
```
name: "Seon Un Korean Raspberry Wine 375ml"   tagPrice: 69
assumptions: "Assumed the standard non-member price of 69.00 HKD as the
              primary tag price…"
```
It chose the standard price over the visually dominant member price and explained
itself. The existing prompt rule only covers crossed-out originals and instalments;
**conditional member pricing is a third decoy class it handled without being told
to.** Trilingual label (Chinese/Korean/English) was no obstacle.

**See also finding #5**, the other half of this failure: a name specific enough to
pass this guard, for a product that does not exist, so the search silently prices
a different one.

**Known defect from this testing:** the missing-model warning is electronics-specific
and fires spuriously on categories that have no model numbers. On the wine it told
the user "Add the model from the label if you can — it is the single biggest
accuracy win", which is useless advice for a bottle. Gate it by category.

**2. `/api/prices` breaches a hard 60-second ceiling, and `maxDuration = 90` is a
promise the plan will not keep.** The wine search 500'd twice. Not a refusal —
`TypeError: fetch failed` / `UND_ERR_SOCKET: other side closed`, `bytesRead: 0`.
Sorting every observed run by duration makes the ceiling obvious:

| outcome | durations |
|---|---|
| 500 | 60.5s, 61.1s, 61.4s |
| 200 | 24s, 29s, 37s, 47s, 49s |

Duration-correlated and intermittent — the same query failed at 60.5s and then
succeeded at 37.5s. The local cause may be a sandbox proxy and is unproven, **but
that does not matter**, because Vercel's Hobby plan caps `maxDuration` at 60s
(raised from 10s in May 2024) and `app/api/prices/route.ts` declares **90**. The
route is written expecting time it will never get. Successful runs already reach
49s, so the headroom is thin even when it works.

<https://vercel.com/changelog/vercel-functions-for-hobby-can-now-run-up-to-60-seconds>

**FIXED.** `maxDuration` is now 60, a 50s client-side `abortSignal` bounds the
call, SDK retries are capped at 2 instead of 5, and a timeout returns a clean
`504` with `code: "search-timeout"` and advice to narrow the product name —
instead of "Unexpected server error" after a minute. Verified both paths: forced
abort returns 504 in 2.2s; success path still returns grounded results with
citations and Search Suggestions in 14–34s. See the timeout gotcha below.

**This still changes the design of the retry in finding #3.** Observed successes
run **14–49s against a 50s deadline** — there is no room for a second full call.
A naive "call it again" cannot fit. Options: a shorter deadline on the first
attempt, or accept the ungrounded result and rely on the warning the UI already
renders.

Also seen in today's logs: `finishReason=MAX_TOKENS` with `thoughtsTokenCount: 687`
— the truncation the gotchas below warn about, still occurring in practice.

**3. `/api/prices` sometimes does not ground at all — intermittently.** One run
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

**4. The district filter is weaker than planned — but NOT dead. This finding was
previously too pessimistic; read the revision before deleting anything.** Gate 2
returned six genuine HK prices with an empty `district` on every one; the ASUS run
added five more of the same. That looked like eleven-for-eleven and the feature
looked worthless.

**Revision:** the Plaud run returned **2 districts out of 6** (`wan-chai`,
`eastern`) — and both came from **price.com.hk dealer listings**, not the big
chains. So districts are not absent, they are *concentrated in local dealer
listings*. Big-chain online storefronts have no location to report; small dealers
do. The earlier ungrounded run that populated `wan-chai / sham-shui-po / yuen-long`
also drew on price.com.hk listings, which now looks like the same mechanism rather
than the "districts appear when data is least verifiable" pattern feared earlier —
that suspicion is **retracted**.

Practical read: the "filter by nearest store" feature applies to a minority of
results, but a real and identifiable one. See task #43 — the online/in-store split
plus a manually-set home district still looks right, but it should *keep* district
data where dealers provide it rather than discarding the field.

**5. "Specific but substituted" — a second way to price the wrong product, and
the finding #1 guard does NOT catch it. FIXED, but understand it before touching
the verdict.** Finding #1's fix stops the model pricing a *generic* name. This is
the other half: the name is perfectly specific, the product just does not exist.

Scanning a Xiaomi 吸頂燈 **D45** returned four prices, every one for a
米家吸頂燈**450** or a **D40** — different products. The model behaved correctly:
the prompt says to name any substitution in `note`, and it did, every time. The
app then ignored the notes, sorted by price, and rendered a confident red
**"You can do better — HK$101 above the cheapest, 27% more."**

The detail that makes it worse: one substituted listing recorded an *original
price of HK$469* — exactly the shopper's tag. The scanned price was very
plausibly fine, and the app said otherwise.

Fix: `PriceQuote.exactModel`, a required boolean the model must set honestly.
Only exact-model quotes may drive a verdict; substituted ones still render, as
context, dimmed and pilled "different model". Three properties worth preserving:

- It **fails closed** — missing or malformed means `false`. A missing verdict
  costs nothing; a confident wrong one is the bug.
- The green "cheapest" marker follows the **verdict**, not row 0. Highlighting a
  cheaper substituted price would point at the number the app just refused to
  judge on.
- Verified in **both** directions against the live API, which matters: a flag
  stuck at `false` would silently suppress every verdict forever and look fine
  from the D45 case alone. D40 (real) → 6 of 6 exact, verdict shown. D45
  (nonexistent) → 0 of 5 exact, verdict suppressed.

**6. `/api/prices` is unreliable in five distinct ways. Read this before
designing the retry in task 3.** Individually each is rare and explainable;
together they mean the route's output is far less dependable than the UI implies.
Observed in a single session on one product:

| mode | what it looks like |
|---|---|
| ungrounded success | quotes, but no citations and no Search Suggestions (finding #3) |
| timeout | `AbortError` at the 50s deadline → clean `504` |
| upstream error | HTTP 503 from the API, ~24–36s |
| empty success | HTTP 200, grounded, **zero quotes**, for a query that works on retry |
| slow success | 200 at 46–48s, i.e. inside 50s with almost nothing to spare |

Consecutive empty runs happen — six in a row at one point, while a different
query kept working throughout. **This is why task 3 needs a decision rather than
a reflexive retry:** a retry addresses only the first row, costs a second billed
search, and cannot fit in the budget anyway (see finding #2).

Measurement caveat, because it wasted time once: an error response has no
`quotes` key, so naive test scripts count it as "zero quotes" and make timeouts
look like empty results. Always check the HTTP status alongside the body.

## Gotchas already paid for (do not rediscover)

- **In a HK electronics shop, the model number is not on the product — it is on
  the small printed spec card beside it.** The capture prompt therefore asks for
  the spec/price card, not the laptop. This looks like a cosmetic copy change and
  is not: it is the cheapest available fix for finding #1, because a photo of the
  product itself structurally cannot yield a SKU.
- **The scan flow is deliberately ONE screen with no router and no `pushState`.**
  Results append below the scan rather than replacing it. Searching used to swap
  the confirm step out, which hid the photo and product details exactly when they
  were most useful for reading the prices, and made browser back leave the app
  entirely — a phase change creates no history entry to return to. If you find
  yourself "fixing" the dead back button by adding routing, you are reintroducing
  the navigation step that was removed on purpose. Two supporting details that
  are easy to undo by accident: the confirm form **collapses to a compact summary**
  once results exist (keeping it full-size pushes the verdict below the fold), and
  **Edit clears the results** (otherwise edited inputs sit above stale prices for
  a product the user is no longer looking at).
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
- **`abortSignal` and `httpOptions.timeout` are NOT the same mechanism**, and the
  difference costs an afternoon if you assume otherwise. Probed against the live
  API with `@google/genai` 1.52.0:
  - `abortSignal` is **client-side** and is the authoritative bound. Fires on
    time, throws `AbortError`. Use this one.
  - `httpOptions.timeout` is sent to Google as a **server-side deadline with a
    10-second floor**. Below 10_000 it does not time out fast — it returns an
    immediate HTTP **400 `INVALID_ARGUMENT`**: *"Manually set deadline 2s is too
    short. Minimum allowed deadline is 10s."* That looks nothing like a timeout
    and sends you hunting in the wrong place.
  - The SDK retries **5 times by default** (`HttpRetryOptions.attempts`). Inside
    a 60s function budget that can stack attempts until the platform kills the
    function. `/api/prices` caps it at 2.
- **Grounding citations are keyed by TITLE, not by URL host.** Every citation URL
  is a `vertexaisearch.cloud.google.com/grounding-api-redirect/…`, so parsing the
  host off the URL returns Google for all of them and matches nothing. Google puts
  the real source domain in the title (`yohohongkong.com`). `withBestLinks()` in
  `/api/prices` depends on this.
- **THE MODEL FABRICATES PRODUCT URLS, and the failure is silent and severe.
  Never prefer a model `url` over a citation.** Verified against YOHO, which
  routes on the numeric id and ignores the slug completely:

  | URL | source | lands on |
  |---|---|---|
  | `/product/183299-Xiaomi-D40-Ceiling-Lamp` | citation | ✅ the D40 |
  | `/product/114945-Xiaomi-D40-Ceiling-Lamp` | model | redirects to home page |
  | `/product/98144-Xiaomi-D40-Ceiling-Lamp-BHR9933GL` | model | ❌ **JBL headphones** |

  Four different ids appeared for the same product across runs; only the
  citation-derived one was real. A shopper tapped "YOHO" on a ceiling light and
  landed on Yves Saint Laurent perfume.

  **No URL-shape heuristic can catch this** — a fabricated URL is shaped exactly
  like a real one and even contains the right product name. An earlier version of
  `withBestLinks()` kept a model URL whenever it "had a real path", reasoning that
  it named its destination honestly. That reasoning was untested and wrong: it
  names a destination it does not go to. The shape tests it relied on
  (`isBareHomepage`, `looksLikeListing`) were deleted along with it — do not
  reintroduce them believing they help here.
- **A citation's destination cannot be inspected server-side.** It is an opaque
  redirect; resolving 8 of them costs 8 HTTP round trips inside a 50s budget that
  successful searches already consume 46–48s of. Resolving them once by hand gave
  **7 of 9 real product pages** — the other two were a category page and, for
  HKTVmall, a literal search URL. Not a guarantee, but far better than a
  fabrication, which is why a citation now always wins and the model URL survives
  only when no citation names that shop. Treat those as unverified.
- **Some retailers cannot be deep-linked at all, and that is not a bug to fix.**
  HKTVmall's own grounding citation is a search URL because that is what Google
  indexed. A shop that exposes its catalogue only through search or category URLs
  gives every available link the same shape.
- **Two retailer-side behaviours that look like app bugs and are not.** HKTVmall
  serves *different HTML by user-agent* (1.45MB mobile vs 2.04MB desktop for the
  same URL), so clicking a link from a narrow desktop window shows the desktop
  site — it will render mobile on a real phone. And iOS shows an
  `Open in "HKTVmall"?` prompt because the retailer's page triggers an app
  deep-link. Neither is worth engineering around. **Test on a real phone**
  (`http://<lan-ip>:3040`); several behaviours differ from a narrow desktop window.
- **`sessionStorage` persistence in `app/page.tsx` is a STAND-IN for task 8**, not
  a parallel feature. `/api/scans` should replace it, not sit alongside it.
- **Model is `gemini-flash-latest`**, an alias. Pinned versions 404 for new keys.
- `.gitignore` uses the broad `.env*` — a narrower rule once missed a
  `.env.local.backup-*` containing live credentials.
- `.env.local` currently holds only `GEMINI_API_KEY`, copied from the Calorie
  Tracker. **The two apps share one key and therefore one quota** — Gemini limits
  are per *project*, not per key, so the two apps can also rate-limit each other.
  This was reviewed and **deliberately left as-is until deploy**; the fix and the
  reasoning live under task 10. Do not "tidy this up" earlier — splitting now
  moves the app onto a fresh free-tier project mid-testing for a benefit that
  does not exist until there is production traffic.
- Separating the key buys **attribution and rate-limit isolation, not
  protection**. Protection is `lib/rateLimit.ts`. Do not conflate them.
- Grounding is **billed per search query**, so `lib/rateLimit.ts` is a cost
  control, not just abuse protection. Caps are on by default.
- When deploying: Vercel's "Redeploy" re-runs the **same commit**. Verify the
  deployed commit SHA — a 200 from a health check proves nothing about what is live.

## Open work, roughly in order

The task list from the originating session does not survive into a new one, so
it is written out here.

1. ~~Re-test identification on a real photo~~ — **mostly done, see finding #1.**
   Two real photos passed (product box; supermarket shelf label with a dual price).
   The remedy is validated. What is still **untested** is the original failing case:
   a *multi-product electronics shelf* shot with the new spec-card framing, and a
   shelf label carrying both a model number *and* a price. Standing ask — grab one
   next time you are in a shop.
2. ~~Fix the `/api/prices` duration budget~~ — **DONE.** `maxDuration` 60, 50s
   `abortSignal`, retries capped at 2, clean `504` on timeout. Both paths verified.
3. **Decide** what to do about `/api/prices` reliability — this is a design call,
   not a coding task, and "retry when ungrounded" is the wrong framing for it.
   Read finding #6 first: there are **five** failure modes and a retry addresses
   one of them, costs a second billed search, and does not fit the budget anyway
   (successes already run 46–48s against a 50s deadline). Options: shorten the
   first attempt's deadline to leave room; accept ungrounded results and rely on
   the warning `app/page.tsx` already renders; or surface reliability honestly in
   the UI. Recommendation on record: **accept and warn**, because shortening the
   deadline would convert currently-succeeding slow searches into failures —
   trading a rare, already-warned problem for a new common one.
4. Gate the missing-model warning in `app/page.tsx` by category; it fires spuriously
   on anything without a model number (see the defect note under finding #1).
5. **Watch for `tagPrice: null` on a tag that clearly shows a price.** Seen once
   on a synthetic canvas tag reading `HK$469`, where the product name and model
   were both read correctly. Probably an artefact of the generated image, so it
   is *not* confirmed on a real photo — but if it recurs in the field it means
   the price path is failing **silently**, which is the worst way for it to fail:
   the verdict simply disappears and nothing looks broken.
6. Soften the unreadable-photo path. When `/api/identify` cannot parse a result it
   returns the user to the camera with a red error banner. Correct, but blunt —
   it reads as a fault rather than "try a clearer shot". Reproduces reliably by
   feeding an image whose text did not render.
7. Decide the district filter's fate (finding #4) — online/in-store split plus a
   manually-set home district, but keep district data where dealer listings supply it.
8. `/api/scans` CRUD + optional Blob photo, so scans survive a reload.
9. History / Watch / Settings tabs; retab or delete the inherited `TabBar.tsx`.
10. `/api/advice` buying-advice route.
11. Create the **public** GitHub repo (see the repo section above).
12. Neon database + Vercel project, then verify the deployed commit SHA.
    - **Give Price Scanner its own `GEMINI_API_KEY`, in its own Google Cloud
      project, at this step — not before and not after.** Deliberately deferred
      to here after weighing it: the benefit is attribution, which does not exist
      until there is real traffic, and creating a fresh free-tier project earlier
      risks tighter grounding allowances during the heaviest testing period. At
      deploy you are setting env vars and making a billing decision anyway, so it
      costs almost nothing.
    - **It cannot be done retroactively.** Once both apps run live against one
      project you cannot split a bill or reconstruct which app spent what. This
      is the last cheap moment.
    - A second key in the *same* project changes nothing — Gemini rate limits and
      quota are enforced **per project, not per key**
      (<https://ai.google.dev/gemini-api/docs/rate-limits>). It must be a new
      project.
    - Set the key in **Vercel's environment variables**, never in the repo — this
      repo is public. Local dev may keep sharing the Calorie Tracker's key; local
      volume is trivial and not worth attributing.
    - Note the new project starts on the **free tier**. Grounding is billed per
      search query, so check whether billing needs enabling to match current
      behaviour.

The plan file referenced at the top predates the real-photo testing. Where it and
this document disagree, **this document is newer** — in particular the plan still
assumes a district filter worth building and a repo that might be private.

## Running it

```bash
cd "/Users/admin/Desktop/Claude Code Projects/Price Scanner"
npm run dev            # http://localhost:3000
```

Note: the parent Calorie Tracker's `.claude/launch.json` has a `price-scanner`
entry (port 3040) so the preview tooling could run this app from that session.
A session started *in this directory* doesn't need it — this project has its own
`.claude/launch.json`.
