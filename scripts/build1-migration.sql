PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_hides (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_hides_user ON post_hides(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_settings_ext (
  user_id TEXT PRIMARY KEY,
  bookmark_privacy TEXT NOT NULL DEFAULT 'private',
  monetization_enabled INTEGER NOT NULL DEFAULT 0,
  monetization_tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
