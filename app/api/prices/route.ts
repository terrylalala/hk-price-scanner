import { NextRequest, NextResponse } from "next/server";
import {
  GEMINI_MODEL,
  MissingApiKeyError,
  getGemini,
  warnIfSlow,
} from "@/lib/gemini";
import { ownerId, requireUser } from "@/lib/session";
import { consume, rateLimited } from "@/lib/rateLimit";
import { districtFromText } from "@/lib/hkDistricts";
import { hostOf, withStoreSearchFallback } from "@/lib/storeLinks";
import { Citation, PriceQuote } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Grounded search runs real web queries, so it is slow: observed successes span
 * 24–49s. This was 90, which Vercel's Hobby plan will not honour — it caps
 * maxDuration at 60s. Asking for time the platform never grants is how a slow
 * search became an opaque socket error rather than a clean timeout.
 */
export const maxDuration = 60;

/**
 * Deadline for the search, comfortably inside maxDuration so the route gets to
 * return a real response instead of being killed mid-flight.
 *
 * Applied twice, because the two settings are NOT the same mechanism:
 *
 * - `abortSignal` is client-side and is the authoritative bound. It fires on
 *   time and throws `AbortError`. The SDK retries up to 5 times by default
 *   (HttpRetryOptions.attempts), which inside a 60s budget can silently stack
 *   attempts until the platform kills the function; an AbortSignal cannot be
 *   out-waited by a retry.
 * - `httpOptions.timeout` is sent to Google as a server-side deadline, and it
 *   has a **10s minimum**. Setting this below 10_000 does not produce a fast
 *   timeout — it produces an immediate HTTP 400 `INVALID_ARGUMENT`
 *   ("Manually set deadline 2s is too short"), which looks nothing like a
 *   timeout and will send you hunting in the wrong place. Verified against
 *   the live API.
 */
const SEARCH_TIMEOUT_MS = 50_000;

/**
 * One retry, not the SDK default of five. A grounded search that already takes
 * ~40s cannot afford four more attempts inside a 50s deadline — the retries
 * would be cut off by the abort anyway, having burned the whole budget.
 */
const SEARCH_ATTEMPTS = 2;

/**
 * Budget for retrying an ungrounded SIMILAR search (see the retry block in POST).
 * Two searches must fit inside maxDuration (60s), so the pair is capped a little
 * under it. The retry only runs when at least RETRY_MIN_MS of that budget remains,
 * because a grounded search needs ~15-25s and starting one with less time left
 * would just abort mid-flight and waste the call.
 *
 * Why retry at all: measured over 46 trials on 2026-07-22/23, ~60% of no-tag
 * similar searches come back ungrounded — the model answered from memory instead
 * of searching — and grounding is partly independent across attempts, so a second
 * try recovers ~36% of those misses. Net effect: the useful-answer rate rises
 * from ~40% to ~60%. Recovery is modest and time-correlated (individual windows
 * ranged 0% to 55%; only the pooled ~36% is reliable), but the misses are the
 * FAST runs (~15-20s), which is what makes a second call affordable inside the
 * wall, and correctness is untouched — a miss that does not recover still shows
 * the honest "from memory" warning, so this only ever ADDS real answers.
 */
const RETRY_BUDGET_MS = 55_000;
const RETRY_MIN_MS = 20_000;

/**
 * Find current Hong Kong prices for a product using Grounding with Google Search.
 *
 * Deliberately NOT using responseMimeType/responseSchema. Structured output and
 * Search grounding do not combine reliably — grounding metadata comes back empty
 * in some combinations — and that metadata is not optional here: it carries both
 * the source links and Google's required Search Suggestions markup. So we ask
 * for JSON in the prose and parse it defensively instead.
 *
 * Thinking is kept ENABLED, unlike the vision route.
 *
 * It was briefly disabled as a latency win — measured at ~10s per search on one
 * product with no worse an answer. But grounding turned out to be the cost: with
 * thinking off, some searches came back weakly grounded — zero citations, so the
 * "Sources" list vanished and every store link fell back to a homepage (the
 * prompt's deliberate fallback when no real product URL was seen), and the Search
 * Suggestions markup — which Google's terms REQUIRE us to render — cannot appear
 * at all when a response is ungrounded. Reasoning appears to make the model
 * invoke and reconcile search more reliably. Ten seconds is not worth trading
 * real product links and a terms-required element for, especially since the big
 * latency win this app needed came from switching identification to Flash-Lite
 * (36s → 3s), not from here.
 */

const SYSTEM_PROMPT = `You are a Hong Kong shopping researcher. Given a product, search for what it currently sells for IN HONG KONG and report real, specific prices you found.

Rules:
- Hong Kong retailers and HK dollars only. If you can only find overseas prices, say so rather than converting them and presenting the result as an HK price.
- Only report a price you actually saw in a search result. Never estimate, average, or infer a price. Fewer real prices beats more invented ones.
- If the product name is too generic to identify one specific model — "ASUS Laptop", "Samsung TV", "Bluetooth headphones" — then STOP. Do not choose a plausible specific model and price that instead. Return {"quotes":[]} and explain in the prose that a model number is needed, naming what to look for on the shelf label. Pricing a guessed model is the single worst thing you can do here: it produces a confident verdict about a product the shopper is not looking at.
- Prefer the product's exact model. If you can only find a different variant or model, say which in the "note" field.
- "exactModel" is REQUIRED on every quote and must be honest. Set it true ONLY if the listing is the same model the shopper scanned. Set it false for a different size, capacity, generation, colour-variant-with-its-own-SKU, bundle, or a similar-but-not-identical product — and name the actual listing in "note". Do not set it true because the price is close or the product looks alike. This flag decides whether the shopper is told they are overpaying, so a wrong true is worse than a cautious false.
- Include the seller's name as shoppers know it (e.g. "Fortress", "Broadway", "HKTVmall", "Price.com.hk listing").
- "url" must be a page you ACTUALLY SAW in a search result — copy it, do not reconstruct it. Prefer the direct product page. But if you did not see the exact product URL, give the shop's home page instead: never assemble a product URL from a remembered pattern or a guessed id. Many shops route on the numeric id alone and ignore the rest of the path, so a guessed id silently serves a completely different product under a URL that still reads like this one — far worse for the shopper than a home page.
- If the seller has a known Hong Kong district or the listing names one, put it in "district"; otherwise "".

Structure your reply in this order, JSON FIRST:

\`\`\`json
{"quotes":[{"store":"...","price":1234,"currency":"HKD","url":"https://...","district":"","note":"","exactModel":true}]}
\`\`\`

Then, after the JSON block, a short plain-language summary for the shopper.

Emit the JSON block before the prose without exception. If you found no genuine HK prices, emit {"quotes":[]} first and then explain why.`;

/**
 * The prompt for "find me something like this", used when there is no model
 * number to match — a scarf seen on a rail, a jacket on someone in the street.
 *
 * A separate prompt rather than a softened version of the exact one, because the
 * two want opposite behaviour on the single most important rule. The exact
 * prompt is built to STOP when the product is generic, since pricing a guessed
 * model produces a confident verdict about the wrong item. Here generic is the
 * starting condition and stopping would return nothing every time.
 *
 * What keeps it honest instead: it must never claim to have found THE item.
 * Every result is openly a suggestion of something comparable you can buy, and
 * `note` carries what the listing actually is so nothing is passed off as the
 * thing photographed.
 *
 * Assembled from three parts so ONE thing varies — where it is allowed to shop —
 * while everything that keeps it honest stays shared and cannot drift between
 * the two scopes:
 *
 *   - SIMILAR_SCOPE_LOCAL  when the item had a PRICE TAG. A tag means the
 *     shopper is standing in a Hong Kong shop comparing this exact purchase
 *     against local alternatives, so an Amazon or ASOS price is the wrong
 *     answer — they cannot walk out with it. Hong Kong retailers, HKD only.
 *   - SIMILAR_SCOPE_GLOBAL when there was NO tag — a spotted item with no local
 *     source — where international stores that ship here are exactly the point.
 */
const SIMILAR_INTRO = `You are a personal shopper for someone in Hong Kong. Given a DESCRIPTION of something they saw and liked — often with no brand and no model number — find real items currently on sale that they can actually BUY, and that are close to what they described.`;

const SIMILAR_SCOPE_LOCAL = `Where to look — HONG KONG ONLY:
- The shopper is looking at this item on sale in a Hong Kong shop, with a price on it, and wants to compare it against what they would pay ELSEWHERE IN HONG KONG. Search Hong Kong retailers and Hong Kong online stores only. Do NOT return overseas listings or ships-to-Hong-Kong imports — they are not what this shopper is choosing between.
- Hong Kong dollars only. Report every price in HKD and set "currency" to "HKD". If you can only find an overseas price, say so in the prose rather than converting it and presenting it as a Hong Kong price.`;

const SIMILAR_SCOPE_GLOBAL = `Where to look — anywhere the shopper can buy FROM Hong Kong (local stores, Hong Kong resellers that import, or international stores that ship here):
- This search has a STRICT TIME LIMIT. Be fast and focused: pick the 2–3 stores MOST likely to carry something like this and search those. Do NOT try to cover every store below — sweeping many stores is what makes this search time out and return nothing. A few real listings from well-chosen stores beats a wide search that never finishes.
- Choose the stores by category. Good starting points (pick a couple, do not search them all):
  - Clothing, shoes, bags, accessories: ASOS, Farfetch, NET-A-PORTER, ZALORA, Uniqlo.
  - Health, supplements, beauty: iHerb, Watsons, Amazon.
  - Electronics and general goods: HKTVmall, Fortress, Amazon.
  - Food, grocery, snacks: HKTVmall, ParknShop, Amazon.
  A well-known Hong Kong boutique is often the best answer, so include one where it fits.
- Prices may be in the store's own currency. Report the price EXACTLY as shown and put its ISO code in "currency" (HKD, USD, GBP, JPY, EUR, CNY, KRW…). Do NOT convert to HK dollars or guess an HKD equivalent — a made-up conversion is a made-up price. When the store is outside Hong Kong, say "ships to HK" in "note" so the shopper knows it is an import.`;

const SIMILAR_RULES = `Rules:
- Only report an item and price you ACTUALLY SAW in a search result. Never estimate a price or invent a listing. Three real options beat ten plausible ones.
- NEVER claim a result is the exact item the shopper photographed. You are suggesting comparable products. If you happen to identify the exact product, say so in "note" — do not assume it.
- "note" is the most important field here: name what the listing ACTUALLY is (e.g. "Uniqlo pleated midi skirt, navy") and, briefly, how it compares to what was described. A result with a price but no note is useless.
- "exactModel" must be false on every result unless you genuinely identified the same product. This is a similarity search; a wrong true would tell the shopper they found the item when they found something that merely resembles it.
- Spread the options across price levels where you can — a high-street piece and a premium one is more useful than five near-identical listings from one site.
- Include the seller's name as shoppers know it (e.g. "Uniqlo", "iHerb", "Farfetch", "HKTVmall", "Lane Crawford").
- "url" must be a page you ACTUALLY SAW in a search result — copy it, do not reconstruct it. If you did not see the product page, give the shop's home or category page instead. Never assemble a product URL from a remembered pattern or a guessed id: many shops route on the numeric id alone, so a guessed id silently serves a completely different product.
- If the seller has a known Hong Kong district or the listing names one, put it in "district"; otherwise "".

Structure your reply in this order, JSON FIRST:

\`\`\`json
{"quotes":[{"store":"...","price":1234,"currency":"HKD","url":"https://...","district":"","note":"what this listing actually is and how it compares","exactModel":false}]}
\`\`\`

Then, after the JSON block, a short plain-language note for the shopper: what you searched for, and what would narrow it down (a brand, a fabric, a length) if the results are too broad.

Emit the JSON block before the prose without exception. If you found nothing genuine, emit {"quotes":[]} first and then explain why.`;

/** The full similar prompt for the given reach: global unless the item is tagged. */
function similarPrompt(scope: "local" | "global"): string {
  const where = scope === "local" ? SIMILAR_SCOPE_LOCAL : SIMILAR_SCOPE_GLOBAL;
  return `${SIMILAR_INTRO}\n\n${where}\n\n${SIMILAR_RULES}`;
}

/** "exact" prices one known model; "similar" shops for comparable items. */
export type SearchMode = "exact" | "similar";

interface Body {
  name?: string;
  brand?: string;
  model?: string;
  category?: string;
  tagPrice?: number | null;
  mode?: SearchMode;
  /**
   * A rich visual description from the vision step, used for a `similar` search
   * where the bare name is too thin to match on. Ignored in exact mode, which
   * searches on the model. See ProductIdentity.searchTerms.
   */
  searchTerms?: string;
  /**
   * The photo of the item, base64 JPEG with no data: prefix. SIMILAR MODE ONLY.
   *
   * A similar search previously threw the photo away and shopped on words alone,
   * so a distinctive jacket and a generic one searched identically. Passing the
   * frame into the same grounded call lets the pattern, cut and hardware reach
   * the search rather than only this route's sentence about them.
   *
   * Deliberately not used in exact mode: there the model number is far stronger
   * evidence than pixels, and inviting the model to weigh a blurry shelf shot
   * against a confirmed model number could only make a working path worse.
   */
  photoBase64?: string;
}

/**
 * ~3MB of base64. The client sends its 1600px version, an order of magnitude
 * under this; the bound exists so a malformed or oversized body cannot push the
 * request past the API's own limit and turn a search into an opaque 400.
 */
const MAX_IMAGE_BASE64 = 3_000_000;

/**
 * The image part for the search, or null to search on text alone.
 *
 * Every rejection here is silent and non-fatal by design: the text search is
 * fully functional on its own, so an absent, oversized or malformed photo must
 * degrade to the previous behaviour rather than fail a billed search.
 */
function imagePart(body: Body, mode: SearchMode) {
  if (mode !== "similar") return null;
  const raw = typeof body.photoBase64 === "string" ? body.photoBase64 : "";
  if (!raw) return null;
  const data = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!data || data.length > MAX_IMAGE_BASE64) return null;
  return { inlineData: { mimeType: "image/jpeg", data } };
}

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const quota = await consume(ownerId(authz.user), "prices");
  if (!quota.allowed) return rateLimited(quota.limit);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing 'name'." }, { status: 400 });
  }

  // /api/identify returns a `name` that usually already embeds the brand and
  // model ("Sony WH-1000XM5 Wireless Headphones"), so appending both blindly
  // produced "Sony Sony WH-1000XM5 Wireless Headphones WH-1000XM5". Only add a
  // part the name does not already carry.
  const brand = typeof body.brand === "string" ? body.brand.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const lowerName = name.toLowerCase();
  const descriptor = [
    brand && !lowerName.includes(brand.toLowerCase()) ? brand : "",
    name,
    model && !lowerName.includes(model.toLowerCase()) ? model : "",
  ]
    .filter(Boolean)
    .join(" ");

  const mode: SearchMode = body.mode === "similar" ? "similar" : "exact";

  // A visible price tag means the shopper is in a Hong Kong shop deciding
  // whether to buy THIS one, so the comparison must stay local — an overseas
  // listing is not something they can walk out with. It governs the similar
  // search's reach below and is what makes a tagged similar search Hong
  // Kong-only. (Exact mode is always local regardless.)
  const hasTag = typeof body.tagPrice === "number" && body.tagPrice > 0;

  // Only meaningful when pricing a known model. In similar mode there is
  // nothing to judge the price against, and asking for a verdict would invite
  // one anyway.
  const askedPrice =
    mode === "exact" && hasTag
      ? `\n\nThe shopper saw it in a shop at HK$${body.tagPrice}. Say whether that looks good, average or poor against what you found.`
      : "";

  // A similar search matches on the vision step's rich description when it has
  // one — "cream ribbed-knit oversized cardigan, horn buttons" finds real
  // products where the bare name "cardigan" cannot. Falls back to the name for
  // anything identified before searchTerms existed, or a saved scan re-run.
  const searchTerms =
    typeof body.searchTerms === "string" ? body.searchTerms.trim() : "";
  const similarQuery = searchTerms || descriptor;

  // Tagged → compare locally; untagged spotted item → let it shop internationally.
  const similarScope: "local" | "global" = hasTag ? "local" : "global";

  // Image first, then the text that refers to it — the ordering the API expects
  // when a prompt is about an accompanying image.
  const image = imagePart(body, mode);

  // Without this the photo can be treated as decoration and the model shops on
  // the words alone, which is the behaviour we are trying to improve on. It also
  // states the priority explicitly: the picture is the item, the words describe
  // it, and where they disagree the picture is right.
  const photoNote = image
    ? "\n\nThe photo above is the item they saw. Search for what is actually in it — the cut, pattern, materials and details you can see — and treat it as the truth wherever the written description is vaguer or disagrees. Do not describe the photo back; use it to choose what to search for."
    : "";

  const userText =
    mode === "similar"
      ? `The shopper saw and liked: ${similarQuery}${
          typeof body.category === "string" && body.category.trim()
            ? ` (${body.category.trim()})`
            : ""
        }${photoNote}\n\n${
          similarScope === "local"
            ? "Find items on sale in Hong Kong now that are close to this, so they can compare against it locally."
            : "Find items they can buy from Hong Kong now that are close to this — local stores, or international stores that ship here."
        }`
      : `Find current Hong Kong retail prices for: ${descriptor}${askedPrice}`;

  const parts = image ? [image, { text: userText }] : [{ text: userText }];

  try {
    const ai = getGemini();
    // One search call, parameterised by the time it is allowed to take so the
    // retry below can hand the second attempt only the budget that is left.
    const runSearch = (timeoutMs: number) =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        config: {
          systemInstruction:
            mode === "similar" ? similarPrompt(similarScope) : SYSTEM_PROMPT,
          tools: [{ googleSearch: {} }],
          // Thinking left ON deliberately — see the header comment. Disabling it
          // saved ~10s but weakened grounding (lost citations, homepage-only links,
          // and no terms-required Search Suggestions), which is not worth the time.
          // Generous: thinking tokens draw from this budget too, and a truncated
          // reply loses the JSON block while still looking plausible in prose.
          maxOutputTokens: 8192,
          temperature: 0.2,
          abortSignal: AbortSignal.timeout(timeoutMs),
          httpOptions: {
            timeout: timeoutMs,
            retryOptions: { attempts: SEARCH_ATTEMPTS },
          },
        },
      });

    const startedAt = Date.now();
    // Grounded search is legitimately slow — successes span 24-49s — so the
    // threshold sits just under the abort. Crossing it means the next such
    // search will probably time out rather than return.
    let response = await warnIfSlow("/api/prices", 45_000, () =>
      runSearch(SEARCH_TIMEOUT_MS),
    );

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "That product could not be searched. Try editing the name." },
        { status: 422 },
      );
    }

    let meta = response.candidates?.[0]?.groundingMetadata;

    // Retry ONCE when a similar search comes back ungrounded — i.e. the model
    // answered from memory instead of searching (no grounding metadata). See
    // RETRY_BUDGET_MS for the measured justification. Budget-gated so the two
    // calls together can never cross the 60s wall: only retry with the time that
    // is actually left, and only if enough of it remains to finish a search.
    // Exact mode is left alone — it grounds reliably and rarely needs this.
    if (!meta && mode === "similar") {
      const remainingMs = RETRY_BUDGET_MS - (Date.now() - startedAt);
      if (remainingMs >= RETRY_MIN_MS) {
        const retry = await runSearch(remainingMs);
        const retryMeta = retry.candidates?.[0]?.groundingMetadata;
        // Adopt the retry only if it actually grounded and was not blocked; a
        // second ungrounded answer is no better than the first, so in that case
        // keep the original response and let the honest "from memory" path run.
        if (retryMeta && !retry.promptFeedback?.blockReason) {
          response = retry;
          meta = retryMeta;
        }
        // Observability: how often the retry fires and whether it recovers is the
        // whole case for this feature, so make it visible in the logs.
        console.log(
          `[/api/prices] ungrounded ${similarScope} similar search retried — ${
            meta ? "recovered" : "still ungrounded"
          }`,
        );
      } else {
        console.warn(
          `[/api/prices] ungrounded ${similarScope} similar search, only ${remainingMs}ms left — skipped retry`,
        );
      }
    }

    const text = response.text ?? "";

    // Truncation here is silent and costly: the prose still looks fine while
    // the machine-readable block is missing, so log it loudly.
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      console.warn(
        `[/api/prices] finishReason=${finish}`,
        JSON.stringify(response.usageMetadata ?? {}),
      );
    }

    const citations = extractCitations(meta);
    // Upgrade any bare-home-page fallback to the store's own search for the item.
    // The query is what the shopper is after: the rich description in similar
    // mode, the model/name in exact mode.
    const linkQuery = mode === "similar" ? similarQuery : descriptor;
    const quotes = withStoreSearchFallback(
      withBestLinks(parseQuotes(text), citations),
      linkQuery,
    );

    return NextResponse.json({
      summary: stripJsonBlock(text),
      quotes,
      citations,
      // REQUIRED by the Gemini API terms whenever Search grounding is used.
      // The client must render this; it must not be dropped.
      searchSuggestionsHtml: meta?.searchEntryPoint?.renderedContent ?? "",
      searchQueries: meta?.webSearchQueries ?? [],
      grounded: !!meta,
      // Echoed so the client renders the right thing without having to remember
      // what it asked for — and so a saved scan can be replayed correctly.
      mode,
    });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Replace every quote link that has a grounding citation for the same shop.
 *
 * THE MODEL FABRICATES PRODUCT URLS, and the failure is silent and severe.
 * Verified against YOHO, whose routing keys on the numeric id and ignores the
 * slug entirely:
 *
 *   /product/183299-Xiaomi-D40-Ceiling-Lamp  (from a citation) → the D40. Correct.
 *   /product/114945-Xiaomi-D40-Ceiling-Lamp  (from the model)  → redirects home.
 *   /product/98144-Xiaomi-D40-Ceiling-Lamp-BHR9933GL (model)   → JBL headphones.
 *
 * Four different ids appeared for the same product across runs; only the
 * citation-derived one was real. A shopper reported tapping "YOHO" on a ceiling
 * light and landing on Yves Saint Laurent perfume.
 *
 * This is worse than a home page. The URL reads perfectly — it contains the
 * right product name — and quietly serves something else, so no heuristic on the
 * URL's shape can catch it. An earlier version of this function preferred a
 * model URL whenever it "had a real path", on the reasoning that it named its
 * destination honestly. That reasoning was untested and wrong: it names a
 * destination it does not go to.
 *
 * So: a citation always wins. Citations are pages Google actually retrieved, and
 * resolving them once by hand gave 7 of 9 real product pages — the other two a
 * category page and, for HKTVmall, a search URL, because that is what Google
 * indexed. Not a guarantee, but a far better bet than a fabrication.
 *
 * The model URL survives only as a last resort, when no citation names that
 * shop. Treat those links as unverified.
 *
 * The citation's destination cannot be checked here: it is an opaque redirect,
 * and following 8 of them would cost 8 HTTP round trips inside the 50s search
 * budget that successful searches already consume 46–48s of.
 */
function withBestLinks(
  quotes: PriceQuote[],
  citations: Citation[],
): PriceQuote[] {
  if (citations.length === 0) return quotes;

  // Key by TITLE, not by URL host. Every citation URL is a
  // vertexaisearch.cloud.google.com redirect, so hostOf() on the URL returns
  // Google for all of them and matches nothing. Google puts the real source
  // domain in the title ("yohohongkong.com"), which is the only usable key.
  const byHost = new Map<string, string>();
  for (const c of citations) {
    const host = c.title
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    if (host && host.includes(".") && !byHost.has(host))
      byHost.set(host, c.url);
  }

  // No URL-shape test here any more, deliberately. A fabricated product URL is
  // shaped exactly like a real one, so shape cannot distinguish them.
  return quotes.map((q) => {
    if (!q.url) return q;
    const cited = byHost.get(hostOf(q.url));
    return cited ? { ...q, url: cited } : q;
  });
}

/** Pull the JSON block out of the prose and normalize it. */
function parseQuotes(text: string): PriceQuote[] {
  // Prefer a fenced ```json block; fall back to the last {...} in the text.
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1]
    : (() => {
        const start = text.lastIndexOf('{"quotes"');
        if (start === -1) return "";
        const end = text.lastIndexOf("}");
        return end > start ? text.slice(start, end + 1) : "";
      })();

  if (!candidate.trim()) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(candidate.trim());
  } catch {
    return [];
  }

  const list = (raw as { quotes?: unknown })?.quotes;
  if (!Array.isArray(list)) return [];

  const out: PriceQuote[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const price =
      typeof o.price === "number" ? o.price : parseFloat(String(o.price ?? ""));
    const store = str(o.store);
    const url = str(o.url);

    // A quote with no price or no source is not evidence of anything, and
    // showing it would imply we verified something we didn't.
    if (!Number.isFinite(price) || price <= 0 || !store) continue;
    if (url && !/^https?:\/\//i.test(url)) continue;

    // Fail closed: only a literal true (or the string "true") counts as an
    // exact-model match. Anything missing, malformed or ambiguous means the
    // quote cannot drive a verdict — a missing verdict beats a wrong one.
    const exactModel = o.exactModel === true || o.exactModel === "true";

    out.push({
      exactModel,
      store,
      price,
      currency: (str(o.currency) || "HKD").toUpperCase(),
      url,
      district: districtFromText(str(o.district) || store),
      note: str(o.note),
    });
  }

  return out.sort((a, b) => a.price - b.price);
}

/** Remove the machine-readable block so the summary reads as prose. */
function stripJsonBlock(text: string): string {
  return text
    .replace(/```json[\s\S]*?```/gi, "")
    .replace(/\{"quotes"[\s\S]*$/, "")
    .trim();
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

function extractCitations(meta: unknown): Citation[] {
  const chunks = (meta as { groundingChunks?: GroundingChunk[] })
    ?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of chunks) {
    const url = c?.web?.uri ?? "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: c.web?.title ?? url, url });
  }
  return out;
}

/**
 * A search that ran out of time, or whose connection was dropped underneath us.
 *
 * Both arrive as generic transport failures, and both were previously reported
 * to the shopper as "Unexpected server error" after a 60-second wait — which
 * reads like a bug in the app rather than a search that took too long. The
 * distinction matters because the useful advice differs: retrying a slow query
 * verbatim usually fails again, whereas a narrower product name usually works.
 */
function isTimeout(err: unknown): boolean {
  const e = err as {
    name?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  };
  const name = typeof e?.name === "string" ? e.name : "";
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  const code = typeof e?.cause?.code === "string" ? e.cause.code : "";

  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("fetch failed")
  );
}

function handleError(err: unknown) {
  if (err instanceof MissingApiKeyError) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  if (isTimeout(err)) {
    console.warn("[/api/prices] search timed out or connection dropped", err);
    return NextResponse.json(
      {
        /**
         * Reworded 21 July. The old text promised "searching again often works",
         * which is true when a single search is unlucky and false when Google is
         * degraded for days — as it was. Advice that confidently fails twice is
         * worse than no advice, so this now names both possibilities instead.
         */
        error:
          "The price search took too long and was stopped. One retry is worth trying — searches normally finish close to the time limit. If it fails again, Google's search service is likely having problems, and it is worth waiting rather than retrying.",
        code: "search-timeout",
      },
      { status: 504 },
    );
  }

  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : undefined;
  if (status === 429) {
    return NextResponse.json(
      {
        error:
          "Too many searches in a short time. Wait a minute, then try again.",
      },
      { status: 429 },
    );
  }
  /**
   * 503 is Google saying its own capacity is short — "this model is currently
   * experiencing high demand". Named separately from the generic branch because
   * it is the one failure here that is definitely NOT the app's fault, and the
   * old wording ("the search service returned an error") read as if the app had
   * broken. During the 20-21 July degradation this was the message a shopper
   * actually saw, and it told them nothing useful about whether to wait or retry.
   */
  if (status === 503) {
    console.warn("[/api/prices] Google reported 503 capacity shortage", err);
    return NextResponse.json(
      {
        error:
          "Google's search service is overloaded right now. This is on their side, not the app — please try again later.",
        code: "search-unavailable",
      },
      { status: 503 },
    );
  }
  if (status && status >= 400 && status < 600) {
    return NextResponse.json(
      {
        error:
          "The price search could not be completed. Please try again in a moment.",
      },
      { status },
    );
  }
  console.error("[/api/prices] unexpected error", err);
  return NextResponse.json(
    { error: "Unexpected server error while searching for prices." },
    { status: 500 },
  );
}
