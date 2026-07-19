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
| ✅ `/api/scans` CRUD | list/create/get/patch/delete, tested against Neon |
| ✅ `/api/advice` | buying advice, on demand, ungrounded |
| ✅ History / Watch / Settings tabs | `TabBar` retabbed and wired; scans list, track, delete, home district |
| ✅ GitHub repo | **public**, pushed: <https://github.com/terrylalala/hk-price-scanner> |
| ✅ Neon DB + Vercel project | **deployed & verified** — <https://hk-price-scanner.vercel.app> |
| ✅ Spend cap | **HK$150/month, AI Studio → Gemini API Spend, project `hk-price-scanner`** — see finding #11 |

Pushed to <https://github.com/terrylalala/hk-price-scanner> (public, `main`).
Verified on push: no secrets in history, `.env.local` absent from the remote,
only `.env.local.example` tracked.

**The repo IS public — keep it that way.** It was created public deliberately.
The user initially chose private; that was reversed after it broke deployments on
the sibling project, and the same trap would return if it is ever flipped back:

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

`components/TabBar.tsx` was inherited from the Calorie Tracker with its tabs
(`today | history | coach | settings`) and is now retabbed to
`scan | history | watch | settings` and wired up.

## Full chain verified on real products (19 Jul)

Every layer run end to end on three real HK shop photos, not synthetic tags:

| product | shop | best exact-model | verdict |
|---|---|---|---|
| Panasonic ES3833 | $248 | $157 Fortress | You can do better |
| TP-Link M8550 | $2298 | $2289 Price.com.hk | **Good price** |
| Oral-B PRO 1 1000 | $369 | $250 Price.com.hk | You can do better |

All grounded, **every quote exactModel true**, real retailers (Fortress, HKTVmall,
Mannings, Watsons, CityLink). Saved to the database and visible in History.

The advice layer produced local knowledge a price table cannot: Shun Hing (信興)
as Panasonic's HK warranty agent, Everbest/Sunder as TP-Link distributors,
parallel-import 5G routers possibly lacking HK band support, and the company-chop
receipt stamp that validates a shop warranty. It took opposite positions
correctly — walk away from the shaver, buy the router on the spot.

The TP-Link case is the one that justifies the app: $2298 against a $2289 market
is a fair price you would never confirm without checking.

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

**Update 2 — four real supermarket shelf photos, disambiguation PASSED.** A
Diverxu market stall with **13 products, 13 labels, and two prices on every
label** (unit price plus a `$xx/2PCS` bundle) returned the right product paired
with the right price: `Diverxu Bloc de Foie Gras 95g · $138`, correctly taking
the unit price over the `$220/2PCS` promo. Three more shelves likewise. So the
multi-product problem that broke on the ASUS counter is largely a *specificity*
problem, not a *disambiguation* one — food is identified by brand, name and
size, and that is enough.

`storeName` also came back right this time (`Diverxu`, `New Basic`, read off
signage and staff shirts) rather than fixture branding, and confidence of
0.9–0.95 was deserved, unlike the 0.8 on "ASUS Laptop".

Still untested: a *multi-product electronics* shelf, where specificity bites.

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

**7. Bundle pricing is a fourth decoy class, and the only one the model got
wrong.** Found by real shelf photos. A sign reading 蝴蝶脆餅 **$20/3包** is twenty
dollars for THREE packs; it was recorded as `tagPrice: 20`, which the verdict
would then compare against single-pack market prices.

The shape of it is precise, and worth knowing before touching the prompt:

| the label shows | behaviour |
|---|---|
| unit price **and** a bundle promo (`$138` + `$220/2PCS`) | ✅ takes the unit price |
| **only** a bundle price (`$20/3包`) | ❌ recorded the bundle as a unit price |

So it was never confused about which price to *prefer* — it had no way to say
"this price covers three". Fixed with `ProductIdentity.packQuantity`, and
`unitPrice()` in `app/page.tsx` is now the only number the verdict, the price
search and the saved scan may use. The field is shown beside the price and is
**always editable**, because hiding it when the model says 1 would make its one
dangerous mistake the one thing a shopper could not correct.

Saved scans store the price ALREADY normalised to per-unit, so history holds
comparable numbers and a stored scan is always `packQuantity: 1`.

**8. Do not gate UI on a hand-written category list — ask the model.** The
missing-model warning was originally gated by a keyword deny-list in
`app/page.tsx`. It was written against categories I invented, tested against the
same invented categories, and passed. Real photos then produced `Ham`,
`Cured Meat` and `Instant Pasta`, none of which were on the list, so the app told
a shopper holding cured ham to "add the model number from the label".

`ProductIdentity.modelExpected` replaces it: the model answers whether the
CATEGORY normally carries a SKU. Verified in both directions — food and cured
meat return false, and the original ASUS shelf still returns
`modelExpected: true`, so the warning that exists to prevent finding #1 is
intact. The keyword list is deleted; do not reintroduce it.

**9. A FABRICATED model number is worse than a missing one, and real electronics
shelves produce them.** This closes the electronics half of finding #1, and it
failed in a new way.

A Xiaomi shelf showed three e-ink cards — **D20 $229, D50 $359, D40 $469** —
against one display unit. `/api/identify` returned:

```
name: "Xiaomi 吸頂燈 D45"   model: "D45"   tagPrice: 469   confidence: 0.9
```

**There is no D45.** It invented a SKU sitting between two real ones and attached
a third card's price. This is the origin of the D45 scan in finding #5 — that
product never existed.

The severity is the inversion: vagueness ("ASUS Laptop") leaves `model` empty and
**fires** the missing-model warning; invention fills `model` in and **suppresses**
it. The most confident-looking output is the least trustworthy one. The prompt
already said "Do NOT guess a model number from appearance alone" and was ignored —
three labels facing one product is a situation the instruction did not resolve.

Fixed with `ProductIdentity.modelVerbatim`: was the SKU read character-for-
character off a label, or inferred? Telling the model it may **admit** guessing
works where forbidding guessing did not — the same shape as `PriceQuote.exactModel`.
False is treated exactly as no model at all, and the warning text adapts.

Verified both directions, which was essential — the fix could otherwise "work" by
warning on everything. Same shelf, three runs: `model: ""`, `verbatim: false`,
`tagPrice: null`, warning shown, assumptions naming the competing labels. Controls
(Plaud box, AULA T650 box): `verbatim: true`, warning hidden.

Also observed, unfixed: at **516×387** the AULA sign 【超值2件】**$550** was read as
`tagPrice: 50` at confidence 0.95 — a 10× error stated confidently. That image is
far below what a phone produces, so it is probably a resolution artefact rather
than a model failure, but it shows price reading degrades silently, not loudly.
Worth re-testing at full resolution before drawing conclusions.

**10. Eleven real HK shop photos, no detected failures — but read the caveat.**
A deliberately varied batch (printed tags, orange promo stickers, glass display
cases, and **handwritten** tags, which remain common in Hong Kong):

```
3509  Casio DQ-747 Thermometer Clock   $86    HANDWRITTEN tag
3511  Panasonic ES3833 Shaver          $248
3517  Dove Go Fresh Body Wash          $35    no warning (toiletry) ✓
3522  WholeLove MED NeuroCure 60s      $219   no warning (supplement) ✓
3523  Mizuno Wave Rider 27             $840
3524  Salomon Pulsar Trail             $960
3525  TP-Link 5G Router M8550          $2298
3526  UGREEN Nexode 55910B             $249
3528  Unitek USB-C→DisplayPort cable   $179   WARNED (no model read) ✓
3532  Seiko QHE204S                    $135
3534  Oral-B PRO 1 1000                $369
```

**Handwriting is not a problem.** `CASIO DQ-747-8DF` was read correctly off a
handwritten tag, including the Chinese spec lines around it. That question is
settled; do not treat handwritten tags as a known risk.

The `modelExpected` gate held on categories nobody listed — toiletries and
supplements silent, the cable warned — which is the payoff for asking the model
instead of maintaining a keyword list (finding #8).

**CAVEAT, and it matters: only 2 of the 11 were actually verified against the
photos.** The other nine were accepted from their own `assumptions` text. After
finding #9 — a confident, specific, entirely invented "D45" — an unverified pass
is weak evidence. Treat this batch as "nothing checked was wrong", not "all
correct".

Of the two checked: IMG_3532 correctly paired **$135** with the green Seiko among
six clocks tagged $130/$135/$145/$168/$168/$145 — genuine disambiguation. But
IMG_3509's **$86** could NOT be confirmed: glare obscures the digits at full zoom.

**New gap this batch exposed, unfixed:** `modelVerbatim` proves a SKU was READ off
a label — not that the label belongs to the product the PRICE came from. On
IMG_3532 a background box carries a barcode reading `QHE2045` while the priced
item is a foreground green clock, so `QHE204S` may have come from a different box.
Same class as finding #9 (price and identity drawn from different labels), one
level subtler, and the current fix does not catch it.

**11. The public URL is unauthenticated, and per-user rate limits will NOT bound
the bill once accounts exist.** Raised while planning to share the app with
family. Two separate things, and the second is the one that surprises people.

**Today:** <https://hk-price-scanner.vercel.app> has no password and no sign-in.
Anyone with the link can spend the Gemini quota, on a Tier 1 project with billing
enabled. What limits the damage is accidental — `ownerId()` returns `'local'` for
*everyone*, so all visitors share ONE 40/day counter.

**That accident reverses the moment accounts are added**, because the caps become
per-person:

| | today (shared identity) | 5 real accounts |
|---|---|---|
| price searches/day | 40 | 200 |
| grounding queries/month | ~6,000 | ~30,000 |
| cost against 5,000 free | ~US$14 | **~US$350** |

So per-user rate limits stop one person hammering the app; they do not bound
spend. **Adding accounts requires adding a GLOBAL cap alongside the per-user
one**, or a $14 worst case becomes $350.

**Mitigation shipped:** a shared-password gate (`lib/gate.ts`, `middleware.ts`,
`/login`). Not accounts — everyone who enters the password still shares one
history and one quota, and the login screen says so rather than implying
otherwise. **Disabled unless `APP_PASSWORD` is set**, so local dev and any
deployment that has not opted in are unchanged. Set it in Vercel to close the
public URL.

The schema was already ready for real accounts: every table carries `user_id`
defaulted to `'local'`, `accountsEnabled()` is the switch, and `requireUser()`
fails closed with 501 if the `AUTH_*` vars appear before sign-in is built. So
accounts remain a config change plus an Auth.js branch — **plus that global cap.**

**Backstop shipped (19 Jul): a HK$150/month spend cap on the `hk-price-scanner`
Google project.** Set in **AI Studio → Gemini API Spend**, not Cloud Console.
The distinction matters and cost a wrong answer once:

- **AI Studio "Monthly spend cap"** is a real cutoff — it stops serving requests.
  Marked *Experimental*. This is the one that is set.
- **Cloud Console "Budgets & alerts"** only emails you. It does **not** stop
  spend without a Pub/Sub function wired to disable billing. Do not reach for
  this one believing it is a brake.

Two documented edges: overage is possible inside a **~10 minute latency** window,
and the cap resets on the 1st **PST**, which is mid-afternoon HK time — so the
month boundary is not the one a HK user would assume.

This bounds the bill even if every other control fails, but it bounds it by
**breaking the app** when hit. It is a backstop, not the plan. The global cap
above is still a prerequisite for accounts.

**12. Multi-photo identify works, but does NOT solve the multi-label shelf —
and the reason it doesn't is sound.** `/api/identify` now accepts up to three
views of one product (`images: [{imageBase64, mediaType}]`, single form still
accepted). The client keeps the one-photo fast path and offers "add another"
from the confirm step, which is where you can already see identification went
wrong.

**The hoped-for win did not materialise.** Re-running the D45 shelf with a second
photo cropped to the single `Xiaomi 吸頂燈 D40 · HK$469` card, it still returned
an empty model with the warning shown:

> *"The specific model size (D20, D30, or D40) of the displayed ceiling light is
> not definitively identifiable from the physical unit alone."*

It is **right**. A close-up proves that card exists and says $469; it does not
prove the unit on display is a D40. The shopper knows which card they pointed at,
the model only sees two images.

I tried instructing it that a deliberate close-up of one label should be treated
as authoritative. It refused twice, reasoning about what it could see rather than
about intent — so that instruction was **reverted rather than left in**, since an
unproven prompt rule that changes nothing is just future confusion.

So the honest position: multi-photo should help where a model number is legible
in a close-up but not a wide shot **and no competing labels exist**. That case is
untested. It does not rescue an ambiguous shelf, and the correct fix there remains
the confirm step — the warning fires and the shopper types the model.

**13. Turning on accounts: what is genuinely ready, and the two steps the
"no migration" claim glosses over.** Reviewed while deciding whether to add
OAuth like the Calorie Tracker. Answer: **deferred, not blocked** — see the
reasoning at the end.

*Genuinely done, and it is the expensive part:*
- **Every** owner-scoped query goes through `ownerId(authz.user)` — 11 call sites
  across all six routes, no exceptions.
- `requireUser()` is a **single branch point**. Add the signed-in branch there and
  every route inherits it untouched. It already fails closed with 501 if
  `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` appear before sign-in exists.

*What is actually left:* install `next-auth`, an `auth.ts` with the Google
provider, the signed-in branch, a sign-in button, Google Cloud consent-screen
paperwork. Roughly half a day, most of it Google's forms.

*And two steps nothing else records:*

1. **Existing data goes invisible.** The schema needs no migration; the DATA
   does. Rows are owned by `'local'` (at time of writing: scans 6, usage 3,
   user_settings 1). A newly signed-in account gets a different id, so that
   history simply disappears. Fix is one statement, but it must be remembered:
   `update scans set user_id = '<new-id>' where user_id = 'local'` — and the same
   for `usage` and `user_settings`.
2. **A global rate cap is a PREREQUISITE, not a follow-up.** `lib/rateLimit.ts`
   counts per user, so caps multiply by user count: five accounts turn a ~US$14
   worst case into ~US$350 (finding #11). Ship the global cap first or the bill
   scales with people. The HK$150 AI Studio spend cap (finding #11) caps the
   damage but does not remove this step — it stops the bill by making the app
   return errors for the rest of the month, which is not a rate limit.

*Why deferred:* the shared-password gate already solved the real problem
(strangers spending the API key). Accounts solve a different one — separating
histories between people you trust — and it is not clear that is wanted. Price
scans are about products and shops, not about a person, unlike a calorie log;
a shared history may be a feature ("we already priced this at HK$469"). Wait for
someone to actually ask for separation. Revisit sooner if the app is shared
beyond family, since a shared password cannot be revoked from one person.

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
- **`GET /api/photo/<any-bogus-id>` is a free, exact health check for the
  database.** It touches Postgres and calls no AI, so it costs nothing:
  - `501` → `DATABASE_URL` never reached the runtime
  - `404` → connected **and** `ensureSchema()` built the tables (a successful
    query against `scans` that found no row)
  - `500` → connected but the connection or schema failed

  Use it after every deploy. It is the only cheap way to tell those three apart,
  and the dashboard shows the same green tick for all of them.
- **Environment variables only reach a deployment built AFTER they existed.**
  This cost a wasted cycle here: the database was connected six minutes *after* a
  redeploy, so production kept returning 501 while the dashboard looked perfect.
  Worse, the Redeploy dialog is byte-identical either way — the code is the same
  commit, and nothing in that dialog reflects the env vars that changed. Always
  compare the variable's "Added" timestamp against the deployment's, then probe.
- **Marking a variable "Sensitive" means you can never read it back**, and
  `vercel env pull` cannot retrieve it either. `GEMINI_API_KEY` was set sensitive,
  which made "is this the new key or the old one?" unanswerable from Vercel — it
  took checking Google Cloud API metrics for a timed burst of requests to settle.
  Do not set it on anything you may need to audit or copy. `DATABASE_URL` was
  deliberately left non-sensitive so it could be copied to `.env.local`.
- **Neon integration settings that matter:** leave **Auth off** (this app is
  single-user; `session.ts` expects Auth.js if accounts ever arrive), leave
  **Custom Prefix empty** (a prefix yields `STORAGE_URL`, which `db.ts` does not
  read — you would get a silently database-less app), and tick **Development**
  alongside Production/Preview so the value can be copied locally.
- A newly created Google Cloud project may not appear under the project picker's
  **Recent** tab — check **All**, and check the organisation selector. Ten minutes
  went into believing a project had not been created when it had.

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
3. ~~Decide what to do about `/api/prices` reliability~~ — **DECIDED: accept and
   warn.** No automatic retry. Rejected because a retry addresses one of five
   failure modes (finding #6), doubles a request that already consumes 46–48s of
   a 50s budget, and silently spends a second billed search. Shortening the first
   attempt's deadline to make room was rejected too: it would convert
   currently-succeeding slow searches into failures, trading a rare warned
   problem for a common one.

   Implemented as honesty plus a user-initiated retry:
   - The empty-result copy no longer blames the user. It said "try a more
     specific product name"; six consecutive empty runs were measured on a query
     that worked before and after, so that advice was actively wrong. It now says
     the search is unreliable and that retrying beats editing the name.
   - A **Search again** button on the empty result. User-initiated, so it costs
     no budget and hides no billed search. Verified live: an empty result
     retried into six prices and a verdict.
   - The 504 copy leads with "searching again often works" for the same reason.
   - The ungrounded warning and suppressed verdict were already in place.

4. ~~Gate the missing-model warning by category~~ — **DONE.** `hasModelNumbers()`
   in `app/page.tsx` is a deny-list, so it warns by default: a spurious warning is
   mild, a missed one lets the search price a different product. Verified against
   every category seen in testing, plus the control that "Laptop" still warns.
5. **Watch for `tagPrice: null` on a tag that clearly shows a price.** Seen once
   on a synthetic canvas tag reading `HK$469`, where the product name and model
   were both read correctly. Probably an artefact of the generated image, so it
   is *not* confirmed on a real photo — but if it recurs in the field it means
   the price path is failing **silently**, which is the worst way for it to fail:
   the verdict simply disappears and nothing looks broken.
6. ~~Soften the unreadable-photo path~~ — **DONE.** HTTP 422/502 from
   `/api/identify` now render as amber guidance ("closer to the printed label…
   tilt away from overhead lights") instead of a red error, since an unreadable
   photo is a normal outcome in a shop, not an app fault. Note a featureless
   image does NOT reproduce it — the model returned "Plain grey background" at
   low confidence, a 200. Stub the fetch to exercise the branch.
7. Decide the district filter's fate (finding #4) — online/in-store split plus a
   manually-set home district, but keep district data where dealer listings supply it.
8. ~~`/api/scans` CRUD~~ — **DONE.** `GET`/`POST` on `/api/scans`, `GET`/`PATCH`/
   `DELETE` on `/api/scans/[id]`, plus `lib/scans.ts` for row⇄Scan mapping. The
   client saves automatically after a successful price search. Full cycle tested
   against Neon, and a real UI scan verified to land as a row.

   Three decisions worth not reversing:
   - **`bestPrice` comes from the cheapest EXACT-model quote, never the cheapest
     overall** (`bestQuote()`). Storing the cheapest would bake finding #5 into
     permanent history: a recorded best price for a different product, stripped
     of the note that said so. Storage is where that mistake stops being fixable.
   - **`day` is computed in Asia/Hong_Kong, not from the server clock.** Vercel
     runs UTC and HK is UTC+8, so anything scanned before 08:00 local would
     otherwise be filed under the previous day.
   - **Ownership is enforced in the WHERE clause**, never as a separate check —
     following `/api/photo/[id]`. Another user's row simply does not match.

   Still open: **Blob photo upload.** `photo_url` stays null, so `hasPhoto` is
   always false and `/api/photo/[id]` has nothing to serve. Blob is not
   provisioned; `hasBlob()` already degrades cleanly.

   Note `sessionStorage` was NOT removed. It holds the *in-progress* scan (photo
   and draft before a search), which has no row yet; the database holds completed
   scans. They do different jobs — the earlier "stand-in" framing was too simple.
9. ~~History / Watch / Settings tabs~~ — **DONE.** `TabBar` retabbed to
   `scan | history | watch | settings`; `components/ScanList.tsx` (History and
   Watch), `components/SettingsTab.tsx`, and `app/api/settings/route.ts` backed
   by the existing `user_settings` jsonb row.

   - **Watch is History filtered by `?watching=true`, not a separate component.**
     Nothing writes to `price_points` yet, so a distinct view would be a copy of
     the same list with no behavioural difference.
   - **The scan flow is hidden, not unmounted, when another tab is active.**
     Unmounting would discard an in-progress scan the moment someone glanced at
     History — the same class of loss the sessionStorage work fixed for reloads.
   - **Settings stores the home district but nothing reads it.** Deliberate:
     storing a preference is reversible, changing which price the app calls
     "best" is not. See task 7.

   Known rough edge: toggling Track takes ~4s (a PATCH then a reload, each a
   round trip to Neon in Singapore) and the button only greys out meanwhile.
   An optimistic update would fix it.
10. ~~`/api/advice` buying-advice route~~ — **DONE.** On-demand from the results
    view via `components/BuyingAdvice.tsx`.

    - **Deliberately NOT grounded.** The prices arrive in the request. Searching
      again would double the cost of a scan, spend a second billed search, and
      inherit all five failure modes in finding #6 for information the caller
      already has. This route reasons; it does not research.
    - **It must not restate the price comparison** — `/api/prices` already
      returns that summary. What a price table cannot express is what actually
      decides a HK electronics purchase: 水貨 versus 行貨, whose warranty is
      honoured, what to check before paying. Those signals were sitting unread in
      the quote `note` fields.
    - **On demand, not automatic.** It is billed and capped at 20/day, and most
      scans do not need it.
    - Refuses with 422 when no exact-model quote exists; the button is hidden in
      that case rather than offered and failing.

    Two things worth keeping: `maxOutputTokens` is **4096** because thinking
    tokens draw from the same budget — at 1024 the advice truncated mid-sentence
    ("Parallel imports (水貨) are"), the exact trap recorded for `/api/identify`.
    A `finishReason` warning now logs it. And the prompt raises parallel imports
    on **relevance, not on a listing mentioning it**: an early draft gated on the
    latter, and the model correctly overrode it to warn that Xiaomi smart devices
    have HK/Mainland versions that will not pair in the Mi Home app. Verified it
    still stays silent where it would be padding (a bottle of wine).
11. ~~Create the public GitHub repo~~ — **DONE.**
    <https://github.com/terrylalala/hk-price-scanner>, public, 15 commits on `main`.
    Note the first commit `6e9415b` is authored `noreply@localhost`, the address
    Vercel rejects — harmless while deploying from `HEAD`, a problem only if you
    ever deploy or roll back to that specific commit.
12. ~~Vercel project + Neon database~~ — **DONE, all verified.** Kept for the
    order and the traps, which apply to any future redeploy.

    Live: <https://hk-price-scanner.vercel.app> · deployed SHA `39d422b`,
    matching local HEAD · Neon `hk-price-scanner-db` (Singapore, Auth off),
    shared by local and production · Gemini key in its own Google Cloud project
    `gen-lang-client-0746637773`, traffic confirmed landing there · rate limits
    **live** (the `usage` table now counts).

    Original order:
    import the repo to Vercel, then **Vercel → Storage → Neon → Connect Project**
    (tick Development *and* Production), then `vercel env pull .env.local` so local
    dev gets `DATABASE_URL` too — the integration sets it on Vercel only, and
    without pulling it down task 8 stays untestable. `lib/db.ts` accepts either
    `DATABASE_URL` or `POSTGRES_URL`, both of which the integration sets.
    **Do not leave the deployment publicly reachable before the database is
    connected:** `consume()` in `lib/rateLimit.ts` returns `allowed: true` when
    `hasDb()` is false, so caps are inert and grounded search is billed per query.
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


13. ~~History detail view~~ — **DONE**, and it forced the project's first schema
    migration. `components/ScanDetail.tsx`, opened by tapping a scan's title.

    **The compliance dependency is the point, not an aside.** A saved scan's
    price list is still grounded output, so redisplaying it requires Search
    Suggestions — and the table never stored them. `lib/db.ts` now adds
    `search_suggestions_html` via `alter table ... add column if not exists`,
    which keeps `ensureSchema()` idempotent without migration tooling.

    Rows written before that column **degrade rather than render bare**: the
    detail shows "Prices not available" instead of a price list without
    suggestions. Verified both paths — an old row degrades, a re-saved row shows
    6 quotes, 6 outbound links, rendered Suggestions and the disclaimer.

    The disclaimer is deliberately reworded here: these prices were true *when
    the scan was taken*, which may be weeks ago. Staleness matters more in
    history than in live results.

    Observation for task 7: district data shows up well in this view —
    `sham-shui-po` on a Price.com.hk dealer, "Capital Computer (正都電腦) ·
    Located in Golden Computer Arcade". Local dealers do carry locations even
    though chains do not.

14. **Persist advice** (candidate, evidence-gated). `/api/advice` output is a
    billed call and is currently thrown away — there is no column, so reopening a
    saved scan regenerates it from scratch. The advice is genuinely worth keeping:
    on a real run it named Shun Hing (信興) as Panasonic's HK warranty agent and
    warned that parallel-import 5G routers may lack Hong Kong band support.
    Needs an `advice text` column, so it costs a migration — `ensureSchema()` only
    does `create table if not exists`. **Do not build it until the regeneration is
    actually annoying**; one wasted call is cheaper than a migration nobody needed.

15. ~~Attach photos to saved scans~~ — **DONE.** Blob store
    `hk-price-scanner-photos` (private, HKG1), upload on save, served through the
    existing ownership-checked `/api/photo/[id]`.

    - **The photo URL still never reaches the client.** `hasPhoto` is a boolean;
      the URL stays server-side. A private blob URL is unguessable but permanent,
      so a leaked one would be readable forever.
    - **Upload failure never loses the scan.** `storePhoto()` returns null rather
      than throwing — a decorative photo must not destroy a result that cost a
      billed search.
    - **DELETE now removes the blob too.** Verified as a real leak first: deleting
      a scan left a 714 KB photo in the store permanently, unreachable because
      `/api/photo/[id]` needs the row, but still billed. `price_points` cascades
      via foreign key; Blob is a separate service with no referential integrity
      to Postgres, so it must be deleted explicitly.

    **EXIF is stripped, and that is deliberate — do not "optimise" it away.**
    `CameraCapture` re-encodes through a canvas, which discards all metadata.
    Verified: a source JPEG carrying `Apple / iPhone 17 Pro Max / GPS-Data` came
    out the other side with no Exif and no GPS. Uploading the original file
    instead would be faster to write and would silently start storing the user's
    exact coordinates in every saved photo, forever.

    Two Vercel traps found here: the Blob integration marks
    `BLOB_READ_WRITE_TOKEN` **Sensitive automatically**, so Settings will not
    reveal it — get it from **Storage → the store → Quickstart → `.env.local`
    tab** instead. And that tab formats values as `KEY="value"`; the quotes were
    stripped for consistency with the rest of the file.

    **Never accept Vercel's "Revoke Token" prompt.** It is correct only if the
    token is unused outside Vercel — local dev has no OIDC and depends on it.
    `lib/db.ts` records that revoking is what broke photo uploads on the app this
    was derived from. `photo_url` is always null
    so `hasPhoto` is false and `/api/photo/[id]` has nothing to serve. History
    shows product names with no pictures. `hasBlob()` already degrades cleanly, so
    this is provisioning plus an upload path, not a fix.

16. **Watch is a list, not a watch.** Nothing writes to `price_points`, so tracked
    products never re-check and the table stays empty. Needs a re-check action or
    a scheduled job before "Watch" means anything beyond a filter.

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
