import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, MissingApiKeyError, getGemini } from "@/lib/gemini";
import { ownerId, requireUser } from "@/lib/session";
import { consume, rateLimited } from "@/lib/rateLimit";
import { districtFromText } from "@/lib/hkDistricts";
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
 * Find current Hong Kong prices for a product using Grounding with Google Search.
 *
 * Deliberately NOT using responseMimeType/responseSchema. Structured output and
 * Search grounding do not combine reliably — grounding metadata comes back empty
 * in some combinations — and that metadata is not optional here: it carries both
 * the source links and Google's required Search Suggestions markup. So we ask
 * for JSON in the prose and parse it defensively instead.
 *
 * Thinking is left ENABLED, unlike the vision route. There, `thinkingBudget: 0`
 * stops thinking tokens eating the output budget on a pure extraction task.
 * Here the model has to reconcile several sources, and that is exactly what
 * thinking is for.
 */

const SYSTEM_PROMPT = `You are a Hong Kong shopping researcher. Given a product, search for what it currently sells for IN HONG KONG and report real, specific prices you found.

Rules:
- Hong Kong retailers and HK dollars only. If you can only find overseas prices, say so rather than converting them and presenting the result as an HK price.
- Only report a price you actually saw in a search result. Never estimate, average, or infer a price. Fewer real prices beats more invented ones.
- If the product name is too generic to identify one specific model — "ASUS Laptop", "Samsung TV", "Bluetooth headphones" — then STOP. Do not choose a plausible specific model and price that instead. Return {"quotes":[]} and explain in the prose that a model number is needed, naming what to look for on the shelf label. Pricing a guessed model is the single worst thing you can do here: it produces a confident verdict about a product the shopper is not looking at.
- Prefer the product's exact model. If you can only find a different variant or model, say which in the "note" field.
- Include the seller's name as shoppers know it (e.g. "Fortress", "Broadway", "HKTVmall", "Price.com.hk listing").
- "url" must be the DIRECT PRODUCT PAGE you saw the price on, not the shop's home page. A shopper who taps it expects to land on this exact item. If you only have the home page, still give it, but never invent a product path that you did not see.
- If the seller has a known Hong Kong district or the listing names one, put it in "district"; otherwise "".

Structure your reply in this order, JSON FIRST:

\`\`\`json
{"quotes":[{"store":"...","price":1234,"currency":"HKD","url":"https://...","district":"","note":""}]}
\`\`\`

Then, after the JSON block, a short plain-language summary for the shopper.

Emit the JSON block before the prose without exception. If you found no genuine HK prices, emit {"quotes":[]} first and then explain why.`;

interface Body {
  name?: string;
  brand?: string;
  model?: string;
  category?: string;
  tagPrice?: number | null;
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

  const askedPrice =
    typeof body.tagPrice === "number" && body.tagPrice > 0
      ? `\n\nThe shopper saw it in a shop at HK$${body.tagPrice}. Say whether that looks good, average or poor against what you found.`
      : "";

  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Find current Hong Kong retail prices for: ${descriptor}${askedPrice}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
        // Generous: thinking tokens draw from this budget too, and a truncated
        // reply loses the JSON block while still looking plausible in prose.
        maxOutputTokens: 8192,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        httpOptions: {
          timeout: SEARCH_TIMEOUT_MS,
          retryOptions: { attempts: SEARCH_ATTEMPTS },
        },
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "That product could not be searched. Try editing the name." },
        { status: 422 },
      );
    }

    const text = response.text ?? "";
    const meta = response.candidates?.[0]?.groundingMetadata;

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
    const quotes = withBestLinks(parseQuotes(text), citations);

    return NextResponse.json({
      summary: stripJsonBlock(text),
      quotes,
      citations,
      // REQUIRED by the Gemini API terms whenever Search grounding is used.
      // The client must render this; it must not be dropped.
      searchSuggestionsHtml: meta?.searchEntryPoint?.renderedContent ?? "",
      searchQueries: meta?.webSearchQueries ?? [],
      grounded: !!meta,
    });
  } catch (err) {
    return handleError(err);
  }
}

/** Registrable-ish host, lowercased and stripped of "www.". "" when unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True when a URL points at a domain root rather than a specific page. */
function isBareHomepage(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === "" || u.pathname === "/") && !u.search;
  } catch {
    return false;
  }
}

/**
 * Upgrade quote links that point at a shop's front door.
 *
 * The model writes `url` from memory and overwhelmingly returns the home page —
 * measured 4 of 5 on one run. Tapping "YOHO · HK$480" then dumps the shopper on
 * yohohongkong.com to hunt for the item themselves, which defeats the point of
 * the quote.
 *
 * Grounding citations do not have this problem: they are the pages Google
 * actually retrieved, so they land on the product. Where a bare home page has a
 * citation for the same host, swap in the citation.
 *
 * Only bare home pages are replaced. A model URL with a real path is left alone
 * — it names the destination honestly, whereas a citation is an opaque Google
 * redirect, so it is only worth trading down to when the alternative is useless.
 */
function withBestLinks(quotes: PriceQuote[], citations: Citation[]): PriceQuote[] {
  if (citations.length === 0) return quotes;

  // Key by TITLE, not by URL host. Every citation URL is a
  // vertexaisearch.cloud.google.com redirect, so hostOf() on the URL returns
  // Google for all of them and matches nothing. Google puts the real source
  // domain in the title ("yohohongkong.com"), which is the only usable key.
  const byHost = new Map<string, string>();
  for (const c of citations) {
    const host = c.title.trim().toLowerCase().replace(/^www\./, "");
    if (host && host.includes(".") && !byHost.has(host)) byHost.set(host, c.url);
  }

  return quotes.map((q) => {
    if (!q.url || !isBareHomepage(q.url)) return q;
    const deep = byHost.get(hostOf(q.url));
    return deep ? { ...q, url: deep } : q;
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

    out.push({
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
  const chunks = (meta as { groundingChunks?: GroundingChunk[] })?.groundingChunks;
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
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
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
        error:
          "The price search took too long and was stopped. Try a more specific product name — broad searches take the longest.",
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
      { error: "Rate limited by the AI service. Please wait a moment and retry." },
      { status: 429 },
    );
  }
  if (status && status >= 400 && status < 600) {
    return NextResponse.json(
      { error: "The search service returned an error. Please try again." },
      { status },
    );
  }
  console.error("[/api/prices] unexpected error", err);
  return NextResponse.json(
    { error: "Unexpected server error while searching for prices." },
    { status: 500 },
  );
}
