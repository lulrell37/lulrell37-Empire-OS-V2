-- Empire OS backend schema. Idempotent — runs on every boot.

-- Generic last-write-wins row store. The server never needs to know the shape
-- of any app table: the whole row is a JSON blob keyed by (table_name, sync_id),
-- where sync_id is a uuid the client generates. `deleted` rows are tombstones.
CREATE TABLE IF NOT EXISTS sync_rows (
  table_name text   NOT NULL,
  sync_id    text   NOT NULL,
  data       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  updated_at bigint NOT NULL DEFAULT 0,
  deleted    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_name, sync_id)
);
CREATE INDEX IF NOT EXISTS sync_rows_updated_idx ON sync_rows (updated_at);

-- Registered Expo push tokens (one row per device).
CREATE TABLE IF NOT EXISTS devices (
  push_token    text PRIMARY KEY,
  platform      text,
  registered_at bigint NOT NULL
);

-- De-dupe guard for the scheduled nudge sender.
CREATE TABLE IF NOT EXISTS push_log (
  nudge_key text PRIMARY KEY,
  sent_at   bigint NOT NULL
);

-- Google OAuth refresh token, stored so the server can make Gmail/Calendar
-- calls on a schedule later. Single owner -> single row.
CREATE TABLE IF NOT EXISTS google_tokens (
  id            int PRIMARY KEY DEFAULT 1,
  refresh_token text,
  updated_at    bigint
);
