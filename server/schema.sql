-- Empire OS backend schema. Idempotent — runs on every boot.

-- Generic last-write-wins row store. The server never needs to know the shape
-- of any app table: the whole row is a JSON blob keyed by (table_name, sync_id),
-- where sync_id is a uuid the client generates. `deleted` rows are tombstones.
--
-- `updated_at` is the client's clock (used for LWW conflict resolution).
-- `server_seq` is a server-authoritative monotonic counter bumped on every
-- write — clients pull by server_seq so cross-device clock skew can't hide rows.
CREATE SEQUENCE IF NOT EXISTS sync_seq;
CREATE TABLE IF NOT EXISTS sync_rows (
  table_name text   NOT NULL,
  sync_id    text   NOT NULL,
  data       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  updated_at bigint NOT NULL DEFAULT 0,
  deleted    boolean NOT NULL DEFAULT false,
  server_seq bigint NOT NULL DEFAULT nextval('sync_seq'),
  PRIMARY KEY (table_name, sync_id)
);
-- Migration for databases created before server_seq existed (phase 1).
ALTER TABLE sync_rows ADD COLUMN IF NOT EXISTS server_seq bigint NOT NULL DEFAULT nextval('sync_seq');
DROP INDEX IF EXISTS sync_rows_updated_idx;
CREATE INDEX IF NOT EXISTS sync_rows_seq_idx ON sync_rows (server_seq);

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

-- Telegram <-> A.R.A. conversation. The bot is a headless front door to the
-- A.R.A. persona (server/araRuntime.js); this is her chat history with the owner
-- there, independent of the in-app persona chat. One row per message.
CREATE TABLE IF NOT EXISTS tg_messages (
  id      bigserial PRIMARY KEY,
  role    text   NOT NULL,          -- 'user' | 'assistant'
  content text   NOT NULL,
  ts      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS tg_messages_ts_idx ON tg_messages (id DESC);

-- De-dupe for Telegram webhook retries — Telegram re-delivers an update until it
-- gets a 200, and a slow A.R.A. turn can outlast that. One row per handled update.
CREATE TABLE IF NOT EXISTS tg_seen (
  update_id bigint PRIMARY KEY,
  seen_at   bigint NOT NULL
);
