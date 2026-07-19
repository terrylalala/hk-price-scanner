/**
 * Shared-password gate.
 *
 * Not accounts. This is the step before accounts: one password, shared with
 * whoever you trust, so a public URL is not an open API key. `lib/session.ts`
 * still treats everyone as LOCAL_USER, so passing the gate does not create an
 * identity — every visitor shares one history and one daily quota.
 *
 * That shared quota is a feature at this stage. Per-user rate limits stop one
 * person hammering the app but do not bound the bill; with five real accounts
 * the same caps would allow five times the spend. Until accounts exist, the
 * global cap is the ceiling.
 *
 * DISABLED unless APP_PASSWORD is set, so local development and any deployment
 * that has not opted in behave exactly as before.
 */

export const GATE_COOKIE = "ps_gate";

export function gateEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

/**
 * The cookie value for the configured password.
 *
 * A hash, never the password itself: the cookie is readable by anything with
 * access to the browser, and a cookie that IS the password hands it over.
 *
 * Salted with AUTH_SECRET when present so the token is not a bare sha256 of a
 * possibly-weak password, which would be trivially reversible from a rainbow
 * table if the cookie ever leaked.
 *
 * Uses Web Crypto rather than node:crypto because middleware runs on the Edge
 * runtime, where node:crypto is unavailable.
 */
export async function expectedToken(): Promise<string> {
  const secret = process.env.AUTH_SECRET ?? "hk-price-scanner";
  const data = new TextEncoder().encode(`${process.env.APP_PASSWORD}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison.
 *
 * `===` on a secret leaks its prefix through timing. The window is small over a
 * network and this is a family-scale app, but the correct version is three lines
 * and there is no reason to write the incorrect one.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
