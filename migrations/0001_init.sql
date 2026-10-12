-- chain-sync D1 schema.
--
-- D1 holds sync logs and idempotency bookkeeping ONLY. It must never hold secret values,
-- tokens, or request bodies (see README "Threat model"). GitHub remains the source of truth for
-- chain state (branches, PRs, PR-body markers); anything here can be dropped without data loss.

-- One row per hop evaluation / config validation / admin action.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  trigger      TEXT NOT NULL,   -- 'cron' | 'webhook:<event>' | 'admin'
  delivery_id  TEXT,
  chain        TEXT NOT NULL,   -- midstream "owner/name" (the repo that owns chain.yml)
  hop          TEXT NOT NULL,   -- 'upstream_to_midstream' | 'midstream_to_downstream' | 'config' | ...
  outcome      TEXT NOT NULL,   -- 'up_to_date' | 'pr_opened' | 'pr_updated' | 'conflict' | 'error' | ...
  source_sha   TEXT,
  target_sha   TEXT,
  pr_number    INTEGER,
  detail       TEXT             -- JSON; never contains secret material
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_chain ON sync_runs (chain, id DESC);

-- Webhook delivery de-duplication (GitHub redelivers with the same delivery GUID).
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id  TEXT PRIMARY KEY,
  event        TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  status       TEXT NOT NULL    -- 'processing' | 'done' | 'failed'
);

-- Per-hop bookkeeping used to honour poll_interval_minutes.
CREATE TABLE IF NOT EXISTS hop_state (
  chain            TEXT NOT NULL,
  hop              TEXT NOT NULL,
  last_polled_at   TEXT,
  last_source_sha  TEXT,
  PRIMARY KEY (chain, hop)
);
