/** Applied only to an explicitly created simulation database, never live state. */
export const SIMULATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS v1_control (
  id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode='simulation'),
  status TEXT NOT NULL CHECK(status IN ('stopped','running','paused','emergency')),
  settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v1_cases (
  id TEXT PRIMARY KEY REFERENCES revenue_opportunities(id), stage TEXT NOT NULL,
  sector TEXT NOT NULL, source TEXT NOT NULL, scenario TEXT NOT NULL,
  max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents >= 0),
  min_leads INTEGER NOT NULL, min_customers INTEGER NOT NULL, min_net_cents INTEGER NOT NULL,
  forecast_net_cents INTEGER NOT NULL, lesson TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS v1_jobs (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES v1_cases(id),
  experiment_id TEXT NOT NULL REFERENCES revenue_experiments(id), stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','uncertain','done','failed')),
  worker TEXT, token TEXT, reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK(reserved_cents >= 0),
  receipt TEXT, created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(case_id,stage)
);
CREATE TABLE IF NOT EXISTS v1_audit (
  id INTEGER PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS v1_paper (
  id TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS v1_policy_versions (
  id INTEGER PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
  validation TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS v1_single_policy ON v1_policy_versions(active) WHERE active=1;
`;
