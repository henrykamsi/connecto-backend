ALTER TABLE messages ADD COLUMN seen_at TEXT;
ALTER TABLE notifications ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_seen ON messages(conversation_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
