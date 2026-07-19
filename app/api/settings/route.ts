import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "@/lib/db";
import { ownerId, requireUser } from "@/lib/session";
import { HK_DISTRICTS } from "@/lib/hkDistricts";
import { UserSettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-user settings, stored as one jsonb row in `user_settings`.
 *
 * GET /api/settings
 * PUT /api/settings   { homeDistrict? }
 *
 * jsonb rather than columns because settings are a small, unstable set: adding
 * one later should not need a migration on a table with a single row per user.
 */

const DEFAULTS: UserSettings = { homeDistrict: "" };

function noDb() {
  return NextResponse.json(
    { error: "No database configured.", code: "no-database" },
    { status: 501 },
  );
}

/** Only known district ids are accepted; anything else is stored as "" (unknown). */
function normalizeDistrict(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!id) return "";
  return HK_DISTRICTS.some((d) => d.id === id) ? id : "";
}

export async function GET(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  // Settings are not essential to the app working, so a missing database
  // returns defaults rather than an error. The Settings tab then renders in a
  // usable state and simply cannot persist, which is easier to understand than
  // an error page.
  if (!hasDb()) return NextResponse.json({ settings: DEFAULTS, persisted: false });

  const uid = ownerId(authz.user);
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      select settings from user_settings where user_id = ${uid}
    `) as unknown as { settings: Partial<UserSettings> | null }[];

    const stored = rows[0]?.settings ?? {};
    return NextResponse.json({
      settings: { ...DEFAULTS, ...stored } as UserSettings,
      persisted: true,
    });
  } catch (err) {
    console.error("[/api/settings GET] failed", err);
    return NextResponse.json({ error: "Could not load settings." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;
  if (!hasDb()) return noDb();

  let body: Partial<UserSettings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const uid = ownerId(authz.user);

  try {
    await ensureSchema();
    const sql = getSql();

    const rows = (await sql`
      select settings from user_settings where user_id = ${uid}
    `) as unknown as { settings: Partial<UserSettings> | null }[];
    const current = rows[0]?.settings ?? {};

    // Merge rather than replace: a client that knows about one setting must not
    // wipe settings it has never heard of.
    const next: UserSettings = { ...DEFAULTS, ...current };
    if ("homeDistrict" in body) next.homeDistrict = normalizeDistrict(body.homeDistrict);

    await sql`
      insert into user_settings (user_id, settings)
      values (${uid}, ${JSON.stringify(next)})
      on conflict (user_id) do update set settings = ${JSON.stringify(next)}
    `;

    return NextResponse.json({ settings: next, persisted: true });
  } catch (err) {
    console.error("[/api/settings PUT] failed", err);
    return NextResponse.json({ error: "Could not save settings." }, { status: 500 });
  }
}
