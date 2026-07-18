import { neon, NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Server-only Neon Postgres access.
 *
 * The app works with or without a database: when no connection string is
 * configured the client falls back to localStorage (see lib/dataStore.ts).
 */

export function dbUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

export function hasDb(): boolean {
  return !!dbUrl();
}

/**
 * Whether Blob storage is usable.
 *
 * On Vercel the project authenticates to Blob with OIDC (workload identity),
 * where only BLOB_STORE_ID is present and no static token exists. Locally we
 * fall back to a read-write token. Requiring the token alone would silently
 * disable photo uploads in production once the token is revoked — which is
 * exactly what happened on the app this was derived from.
 */
export function hasBlob(): boolean {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export class NoDatabaseError extends Error {
  constructor() {
    super("No database configured (DATABASE_URL / POSTGRES_URL is unset).");
    this.name = "NoDatabaseError";
  }
}

let client: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  const url = dbUrl();
  if (!url) throw new NoDatabaseError();
  if (!client) client = neon(url);
  return client;
}

// Create tables on first use per server instance. `if not exists` makes this
// safe to run repeatedly, so no separate migration step is needed on deploy.
let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = initSchema();
  return schemaPromise;
}

async function initSchema(): Promise<void> {
  const sql = getSql();

  // `user_id` is present from day one, defaulted to the single local owner.
  // Adding real accounts later is then a config change, not a migration with a
  // nullable-column backfill.
  //
  // `double precision` (not numeric) so the driver returns JS numbers, not strings.
  await sql`
    create table if not exists scans (
      id           text primary key,
      user_id      text             not null default 'local',
      ts           timestamptz      not null,
      day          text             not null,
      product_name text             not null,
      brand        text             not null default '',
      model        text             not null default '',
      category     text             not null default '',
      tag_price    double precision,
      currency     text             not null default 'HKD',
      store_name   text             not null default '',
      district     text             not null default '',
      confidence   double precision not null default 0,
      assumptions  text             not null default '',
      best_price   double precision,
      best_source  text             not null default '',
      quotes       jsonb,
      citations    jsonb,
      notes        text,
      watching     boolean          not null default false,
      -- Server-side only. This is never included in any client response;
      -- images are served through /api/photo/[id], which checks ownership.
      photo_url    text
    )
  `;
  await sql`create index if not exists scans_user_ts_idx on scans (user_id, ts desc)`;
  await sql`create index if not exists scans_day_idx on scans (user_id, day)`;
  await sql`create index if not exists scans_watch_idx on scans (user_id, watching)`;

  // One row per observed price, so a watched product builds a history from
  // on-demand re-checks. No cron needed.
  await sql`
    create table if not exists price_points (
      id         bigserial primary key,
      scan_id    text not null references scans(id) on delete cascade,
      user_id    text not null default 'local',
      checked_at timestamptz not null default now(),
      price      double precision not null,
      source     text not null default ''
    )
  `;
  await sql`
    create index if not exists price_points_scan_idx
      on price_points (scan_id, checked_at)
  `;

  // Daily AI usage counters. Grounded search is billed per search query, so
  // this is a cost control, not just abuse protection.
  await sql`
    create table if not exists usage (
      user_id text not null,
      day     text not null,
      kind    text not null,
      count   int  not null default 0,
      primary key (user_id, day, kind)
    )
  `;

  // Per-user settings (home district, currency).
  await sql`
    create table if not exists user_settings (
      user_id  text primary key,
      settings jsonb
    )
  `;
}
