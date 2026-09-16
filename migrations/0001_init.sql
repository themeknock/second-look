-- Second Look, initial schema.
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  raw           TEXT NOT NULL,                     -- the full validated AgentRun JSON
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | reviewing | reviewed | needs_human | human_done
  verdict       TEXT,                              -- PASS | FAIL | NEEDS_HUMAN
  reviewed_at   TEXT,
  last_error    TEXT,                              -- why the last review attempt failed; retried by cron
  lease_until   TEXT,                              -- 5-minute lease so cron and a manual review cannot collide
  is_seed       INTEGER NOT NULL DEFAULT 0,        -- only seed runs are readable without the key
  ingested_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent);

CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  turn_index    INTEGER NOT NULL,
  kind          TEXT NOT NULL,        -- booking | price | transfer | kb_fact | promise | other
  text          TEXT NOT NULL,        -- the claim as the agent said it
  normalized    TEXT NOT NULL,        -- JSON
  verdict       TEXT NOT NULL,        -- SUPPORTED | CONTRADICTED | UNVERIFIABLE
  evidence      TEXT NOT NULL,        -- JSON: which event or catalogue key was checked, or why none
  checker       TEXT NOT NULL,
  risk          TEXT                  -- for UNVERIFIABLE: low | med | high
);
CREATE INDEX IF NOT EXISTS claims_run ON claims(run_id);

CREATE TABLE IF NOT EXISTS human_reviews (
  run_id        TEXT PRIMARY KEY REFERENCES runs(run_id),
  decision      TEXT NOT NULL,        -- agree | override_pass | override_fail
  note          TEXT,
  reviewed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day           TEXT NOT NULL,
  agent         TEXT NOT NULL,
  runs          INTEGER NOT NULL,
  fail          INTEGER NOT NULL,
  needs_human   INTEGER NOT NULL,
  contradicted_by_kind TEXT NOT NULL, -- JSON {booking:3, price:1, ...}
  PRIMARY KEY (day, agent)
);
