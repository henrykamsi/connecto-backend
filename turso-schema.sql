
-- [NEW UPDATES]
ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'published';
ALTER TABLE posts ADD COLUMN scheduled_at TEXT;
ALTER TABLE posts ADD COLUMN is_boosted INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN boost_expires_at TEXT;

CREATE TABLE IF NOT EXISTS shop_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    duration TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profile_views (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    is_verified INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
