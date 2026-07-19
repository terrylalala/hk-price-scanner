import { GoogleGenAI, ApiError } from "@google/genai";

/**
 * Server-only Google Gen AI (Gemini) client. Reads the API key from the
 * environment. Must never be imported from client components — it exists purely
 * for the /api routes.
 */

// `gemini-flash-latest` is an alias that always resolves to the current Flash
// model, so pinned versions being retired won't break the app. Override with the
// GEMINI_MODEL env var to pin a specific version (e.g. gemini-3.5-flash).
//
// Used for the grounded PRICE search, which reasons over web results and is
// worth the stronger model.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

// Identification is a pure extraction task — read the label, read the tag — and
// does not need the reasoning of full Flash. Measured on a crowded shelf photo,
// `gemini-flash-latest` took 36s while `gemini-flash-lite-latest` took 3.4s for
// an identical result (same model, same price, same multi-product flag): a 10x
// speedup and the single largest lever on the app's end-to-end latency. Kept
// separate from GEMINI_MODEL so the price search still uses the stronger model,
// and overridable if Lite ever proves less accurate on real products.
export const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || "gemini-flash-lite-latest";

// Accept either GEMINI_API_KEY (preferred) or GOOGLE_API_KEY as a fallback.
function apiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

let client: GoogleGenAI | null = null;

/** Returns a singleton client, or throws a clear error if the key is missing. */
export function getGemini(): GoogleGenAI {
  const key = apiKey();
  if (!key) {
    throw new MissingApiKeyError();
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: key });
  }
  return client;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not set. Copy .env.local.example to .env.local and add your key, then restart the dev server.",
    );
    this.name = "MissingApiKeyError";
  }
}

export { GoogleGenAI, ApiError };
