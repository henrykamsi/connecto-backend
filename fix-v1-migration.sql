DROP INDEX IF EXISTS posts_user_idx;
DROP INDEX IF EXISTS notifications_user_idx;

CREATE INDEX IF NOT EXISTS posts_author_created_idx
ON posts(author_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
ON notifications(recipient_id, created_at DESC);
