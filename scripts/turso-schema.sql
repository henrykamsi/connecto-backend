PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    mobile TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,

    first_name TEXT NOT NULL,
    surname TEXT NOT NULL,

    country TEXT,
    state TEXT,
    gender TEXT,

    bio TEXT,
    category TEXT,

    profile_photo_media_id TEXT,
    cover_photo_media_id TEXT,

    email_verified INTEGER NOT NULL DEFAULT 0,
    phone_verified INTEGER NOT NULL DEFAULT 0,

    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    biometric_enabled INTEGER NOT NULL DEFAULT 0,

    account_status TEXT NOT NULL DEFAULT 'active',

    name_last_changed_at TEXT,
    category_last_changed_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email
ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_username
ON users(username);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,

    theme TEXT NOT NULL DEFAULT 'system',

    profile_visibility TEXT NOT NULL DEFAULT 'everyone',
    friend_visibility TEXT NOT NULL DEFAULT 'everyone',
    follower_visibility TEXT NOT NULL DEFAULT 'everyone',

    message_privacy TEXT NOT NULL DEFAULT 'everyone',

    notification_push INTEGER NOT NULL DEFAULT 1,
    notification_email INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,

    channel TEXT NOT NULL,
    destination TEXT NOT NULL,

    code_hash TEXT NOT NULL,

    purpose TEXT NOT NULL,

    expires_at TEXT NOT NULL,
    used_at TEXT,

    attempts INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_verification_user
ON verification_codes(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,

    refresh_token_hash TEXT,

    device_type TEXT,
    device_model TEXT,
    os_version TEXT,
    app_version TEXT,

    ip_address TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
ON sessions(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,

    token_hash TEXT NOT NULL UNIQUE,

    device_id TEXT,
    device_name TEXT,
    device_type TEXT,
    os_version TEXT,
    app_version TEXT,

    ip_address TEXT,
    user_agent TEXT,

    expires_at TEXT NOT NULL,
    revoked_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL,
    following_id TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(follower_id, following_id),

    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follows_following
ON follows(following_id);

CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(sender_id, receiver_id),

    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user_a_id TEXT NOT NULL,
    user_b_id TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_a_id, user_b_id),

    FOREIGN KEY(user_a_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(user_b_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(blocker_id, blocked_id),

    FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,

    text TEXT,

    audience TEXT NOT NULL DEFAULT 'everyone',

    comments_enabled INTEGER NOT NULL DEFAULT 1,
    like_count_visible INTEGER NOT NULL DEFAULT 1,

    share_enabled INTEGER NOT NULL DEFAULT 1,

    original_post_id TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,

    FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_author
ON posts(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,

    owner_id TEXT NOT NULL,
    post_id TEXT,

    type TEXT NOT NULL,
    mime_type TEXT NOT NULL,

    size INTEGER,
    width INTEGER,
    height INTEGER,
    duration REAL,

    storage_key TEXT NOT NULL,
    thumbnail_key TEXT,

    processing_status TEXT NOT NULL DEFAULT 'pending',

    visibility TEXT NOT NULL DEFAULT 'private',

    ai_status TEXT,
    ai_detection_confidence REAL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,

    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_media_owner
ON media(owner_id);

CREATE INDEX IF NOT EXISTS idx_media_post
ON media(post_id);

CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,

    type TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, post_id),

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,

    post_id TEXT NOT NULL,
    author_id TEXT NOT NULL,

    parent_comment_id TEXT,

    body TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,

    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_comment_id) REFERENCES comments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post
ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,

    type TEXT NOT NULL DEFAULT 'private',

    created_by TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
    id TEXT PRIMARY KEY,

    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    role TEXT NOT NULL DEFAULT 'member',

    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at TEXT,

    UNIQUE(conversation_id, user_id),

    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS message_requests (
    id TEXT PRIMARY KEY,

    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(sender_id, receiver_id),

    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,

    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,

    body TEXT,

    message_type TEXT NOT NULL DEFAULT 'text',

    reply_to_message_id TEXT,

    client_message_id TEXT,

    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at TEXT,
    deleted_at TEXT,

    expires_at TEXT,

    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(conversation_id, sent_at);

CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,

    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    type TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(message_id, user_id),

    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,

    conversation_id TEXT NOT NULL,

    caller_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,

    call_type TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'ringing',

    started_at TEXT,
    accepted_at TEXT,
    ended_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_signals (
    id TEXT PRIMARY KEY,

    call_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,

    signal_type TEXT NOT NULL,
    payload TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(call_id) REFERENCES calls(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,

    recipient_id TEXT NOT NULL,
    actor_id TEXT,

    type TEXT NOT NULL,

    title TEXT,
    body TEXT,

    target_type TEXT,
    target_id TEXT,

    data TEXT NOT NULL DEFAULT '{}',

    read_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
ON notifications(recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id TEXT PRIMARY KEY,

    push_enabled INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 1,

    follows_enabled INTEGER NOT NULL DEFAULT 1,
    friend_requests_enabled INTEGER NOT NULL DEFAULT 1,
    messages_enabled INTEGER NOT NULL DEFAULT 1,
    comments_enabled INTEGER NOT NULL DEFAULT 1,
    reactions_enabled INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    token TEXT NOT NULL UNIQUE,

    device_type TEXT,
    device_model TEXT,
    os_version TEXT,
    app_version TEXT,

    active INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,

    user_id TEXT,

    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',

    ip_address TEXT,

    metadata TEXT NOT NULL DEFAULT '{}',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_user
ON security_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,

    reporter_id TEXT NOT NULL,
    reported_user_id TEXT,
    reported_post_id TEXT,
    reported_comment_id TEXT,
    reported_message_id TEXT,

    category TEXT NOT NULL,

    description TEXT,

    status TEXT NOT NULL DEFAULT 'open',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,

    FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moderation_events (
    id TEXT PRIMARY KEY,

    user_id TEXT,

    target_type TEXT,
    target_id TEXT,

    category TEXT NOT NULL,

    action TEXT NOT NULL,

    reason TEXT,

    metadata TEXT NOT NULL DEFAULT '{}',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    name TEXT NOT NULL,

    key_prefix TEXT NOT NULL,
    secret_hash TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'active',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    revoked_at TEXT,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user
ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,

    api_key_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    token_hash TEXT NOT NULL UNIQUE,

    name TEXT,

    scopes TEXT NOT NULL DEFAULT '[]',

    status TEXT NOT NULL DEFAULT 'active',

    expires_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,

    FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    url TEXT NOT NULL,

    secret_hash TEXT,

    events TEXT NOT NULL DEFAULT '[]',

    status TEXT NOT NULL DEFAULT 'active',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS
api_usage (
    id TEXT PRIMARY KEY,

    user_id TEXT,
    api_key_id TEXT,
    token_id TEXT,

    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,

    status_code INTEGER,

    ip_address TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_usage_created
ON api_usage(created_at);

CREATE TABLE IF NOT EXISTS api_logs (
    id TEXT PRIMARY KEY,

    user_id TEXT,
    api_key_id TEXT,
    token_id TEXT,

    method TEXT NOT NULL,
    endpoint TEXT NOT NULL,

    status_code INTEGER,

    request_id TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
    id TEXT PRIMARY KEY,

    user_id TEXT,
    api_key_id TEXT,
    token_id TEXT,

    endpoint TEXT,

    ip_address TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_key_exposure_events (
    id TEXT PRIMARY KEY,

    user_id TEXT,

    key_id TEXT,

    location_type TEXT,
    location_reference TEXT,

    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    status TEXT NOT NULL DEFAULT 'open',

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
