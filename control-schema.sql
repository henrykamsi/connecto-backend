PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS control_admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    password_changed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_control_admins_email
ON control_admins(email);

CREATE TABLE IF NOT EXISTS control_setup_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    setup_done INTEGER NOT NULL DEFAULT 0,
    setup_done_at TEXT,
    setup_done_by TEXT
);

INSERT OR IGNORE INTO control_setup_lock (id, setup_done)
VALUES (1, 0);

CREATE TABLE IF NOT EXISTS control_sessions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(admin_id) REFERENCES control_admins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_sessions_admin
ON control_sessions(admin_id);

CREATE INDEX IF NOT EXISTS idx_control_sessions_token
ON control_sessions(token_hash);

CREATE TABLE IF NOT EXISTS provider_credentials (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    credentials_enc TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 0,
    daily_limit INTEGER,
    used_today INTEGER NOT NULL DEFAULT 0,
    used_total INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_message TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    cooldown_until TEXT,
    last_error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES control_admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_category
ON provider_credentials(category, provider);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_active
ON provider_credentials(is_active, is_primary);

CREATE TABLE IF NOT EXISTS provider_quotas (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    limit_count INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    reset_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(credential_id) REFERENCES provider_credentials(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_quotas_credential
ON provider_quotas(credential_id);

CREATE TABLE IF NOT EXISTS provider_events (
    id TEXT PRIMARY KEY,
    credential_id TEXT,
    category TEXT,
    provider TEXT,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'info',
    message TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(credential_id) REFERENCES provider_credentials(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_events_credential
ON provider_events(credential_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_events_created
ON provider_events(created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    source TEXT NOT NULL,
    event_type TEXT,
    url TEXT,
    status_code INTEGER,
    request_body TEXT,
    response_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
ON webhook_events(status, next_retry_at);

CREATE TABLE IF NOT EXISTS control_audit_log (
    id TEXT PRIMARY KEY,
    admin_id TEXT,
    admin_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    target_label TEXT,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(admin_id) REFERENCES control_admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_control_audit_created
ON control_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_control_audit_admin
ON control_audit_log(admin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_verification_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    verification_code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'email_verify',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    scheduled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status
ON email_verification_queue(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_email_queue_user
ON email_verification_queue(user_id);

CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(updated_by) REFERENCES control_admins(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO feature_flags (key, value, description, category) VALUES
('signup_enabled',              'true',  'Allow new user registration',                'auth'),
('email_verification_required', 'true',  'Require email verification before full access','auth'),
('signup_allowed_when_email_down','true','Allow signup even if email provider is down','auth'),
('image_upload_enabled',        'true',  'Allow image uploads on posts',               'media'),
('video_upload_enabled',        'true',  'Allow video uploads on posts',               'media'),
('profile_photo_enabled',       'true',  'Allow profile photo uploads',                'media'),
('cover_photo_enabled',         'true',  'Allow cover photo uploads',                  'media'),
('chat_enabled',                'true',  'Enable chat',                                'features'),
('calls_enabled',               'true',  'Enable audio and video calls',               'features'),
('feed_enabled',                'true',  'Enable the feed',                            'features'),
('feed_visible_when_unverified','false', 'Allow unverified users to see the feed',     'auth'),
('calls_when_unverified',       'false', 'Allow unverified users to make calls',       'auth'),
('maintenance_mode',            'false', 'Show maintenance screen to all users',       'general');
