import { NextRequest, NextResponse } from "next/server";

/**
 * Authorization for API routes.
 *
 * v1 is deliberately SINGLE-USER: there is no sign-in, and everything belongs
 * to one fixed owner. Accounts are a later upgrade.
 *
 * Note the difference from the Calorie Tracker this was derived from. There,
 * "single user" meant "no database", which coupled two unrelated things. Here
 * the switch is `accountsEnabled()` — whether Google OAuth is configured — so
 * you can run single-user WITH a Neon database and still get cross-device sync.
 *
 * Because every row already carries `user_id` (defaulted to LOCAL_USER.id),
 * turning accounts on later needs no migration and no backfill: add the
 * Auth.js branch below, and new rows simply carry a real user id instead.
 */

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export type AuthResult =
  | { ok: true; user: SessionUser | null }
  | { ok: false; response: NextResponse };

/** The single owner used while the app runs without accounts. */
export const LOCAL_USER: SessionUser = {
  id: "local",
  email: "local@localhost",
  name: "Me",
};

/**
 * Whether real accounts are switched on. False in v1.
 *
 * When this becomes true, add `next-auth`, an `auth.ts`, and the signed-in
 * branch in requireUser() — the rest of the app needs no changes.
 */
export function accountsEnabled(): boolean {
  return !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export async function requireUser(_req: NextRequest): Promise<AuthResult> {
  if (!accountsEnabled()) {
    return { ok: true, user: null };
  }

  // Accounts are configured but the sign-in layer hasn't been built yet.
  // Fail closed rather than silently handing everyone the shared local data.
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "Accounts are configured but sign-in is not implemented yet.",
        code: "accounts-not-ready",
      },
      { status: 501 },
    ),
  };
}

/**
 * The owner id to scope queries by. `null` (single-user mode) maps to the fixed
 * LOCAL_USER id, so the same SQL works in both modes.
 */
export function ownerId(user: SessionUser | null): string {
  return user ? user.id : LOCAL_USER.id;
}
