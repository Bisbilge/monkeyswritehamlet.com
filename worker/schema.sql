-- Sonsuz Maymun Teoremi — D1 şeması
-- Bunu bir kez, elle çalıştırmanız gerekiyor (bkz. DEPLOY.md):
--   wrangler d1 execute monkey-db --remote --file=./worker/schema.sql
--
-- backend/main.py'deki SQLModel tanımlarının (GameSession, LeaderboardEntry)
-- birebir SQL karşılığıdır; ayrıca IP rate limiter için ip_hit tablosu
-- eklenmiştir (FastAPI sürümünde bu bellek-içi bir dict'ti — D1'de kalıcı
-- ve Worker'ın tüm edge lokasyonlarında tutarlı olması için tabloya taşındı).

CREATE TABLE IF NOT EXISTS game_session (
  id TEXT PRIMARY KEY,
  current_index INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  total_rolls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_roll_at TEXT,
  ip_hash TEXT,
  flagged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leaderboard_entry (
  session_id TEXT PRIMARY KEY REFERENCES game_session(id),
  nickname TEXT NOT NULL,
  score INTEGER NOT NULL,
  achieved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_score ON leaderboard_entry(score DESC, achieved_at ASC);

CREATE TABLE IF NOT EXISTS ip_hit (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_hit_ip_ts ON ip_hit(ip, ts);
