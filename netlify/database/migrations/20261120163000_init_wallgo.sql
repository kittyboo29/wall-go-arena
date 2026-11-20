-- WALL GO II — Initial Postgres Schema for Netlify Database (@netlify/database)
-- Automatically applied by Netlify during deploy.

CREATE TABLE IF NOT EXISTS wallgo_meta (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wallgo_accounts (
  norm_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NOT NULL,
  recent_matches JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS wallgo_entries (
  id TEXT PRIMARY KEY,
  norm_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  rp INTEGER NOT NULL DEFAULT 1200,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  ai_level TEXT,
  skill DOUBLE PRECISION,
  last_delta INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE INDEX IF NOT EXISTS idx_wallgo_entries_is_ai ON wallgo_entries (is_ai);

CREATE TABLE IF NOT EXISTS wallgo_presence (
  norm_key TEXT PRIMARY KEY,
  client_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen BIGINT NOT NULL,
  queued_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wallgo_presence_status ON wallgo_presence (status);

CREATE TABLE IF NOT EXISTS wallgo_pending_matches (
  norm_key TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  match_code TEXT NOT NULL,
  opponent_name TEXT NOT NULL,
  opponent_rp INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallgo_active_matches (
  code TEXT PRIMARY KEY,
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  key_a TEXT NOT NULL,
  key_b TEXT NOT NULL,
  started_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallgo_forfeit_notices (
  norm_key TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  left_name TEXT NOT NULL,
  rp_delta INTEGER NOT NULL,
  new_rp INTEGER NOT NULL,
  at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallgo_events (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallgo_processed_matches (
  match_id TEXT PRIMARY KEY,
  processed_at BIGINT NOT NULL
);

INSERT INTO wallgo_meta (id, version, updated_at)
VALUES (1, 1, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallgo_entries (id, norm_key, name, is_ai, rp, wins, losses, draws, ai_level, skill, last_delta, sort_order)
VALUES
  ('r_kyu',   'kyumaster',      'KyuMaster',      TRUE, 1790, 48, 11, 2, 'hard',   0.96, 0, 1),
  ('r_orbit', '軌道計算師',      '軌道計算師',      TRUE, 1645, 39, 14, 3, 'hard',   0.89, 0, 2),
  ('r_seok',  '河錫辰・圍牆流',  '河錫辰・圍牆流',  TRUE, 1530, 34, 16, 2, 'hard',   0.80, 0, 3),
  ('r_hyun',  'hyungyu_pro',    'HyunGyu_Pro',    TRUE, 1445, 29, 16, 1, 'hard',   0.74, 0, 4),
  ('r_nova',  '赤藍策士',        '赤藍策士',        TRUE, 1350, 25, 17, 2, 'medium', 0.64, 0, 5),
  ('r_tin',   'tinno_99',       'Tinno_99',       TRUE, 1270, 21, 16, 1, 'medium', 0.56, 0, 6),
  ('r_zen',   '深藍封鎖線',      '深藍封鎖線',      TRUE, 1165, 16, 15, 2, 'medium', 0.48, 0, 7),
  ('r_kuro',  '黑曜棋手',        '黑曜棋手',        TRUE, 1085, 12, 14, 1, 'easy',   0.40, 0, 8),
  ('r_rook',  '新手試煉者',      '新手試煉者',      TRUE, 980,   7, 13, 0, 'easy',   0.32, 0, 9)
ON CONFLICT (id) DO NOTHING;
