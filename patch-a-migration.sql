ALTER TABLE users ADD COLUMN verification_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_prompt_dismissals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_grace_started_at TEXT;
ALTER TABLE users ADD COLUMN biometric_device_id TEXT;
ALTER TABLE users ADD COLUMN google_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_verification_pending ON users(verification_pending);
