const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');

const auth = require('../middleware/auth');
const { query } = require('../db');
const env = require('../config/env');
const { hashSecret, randomSecret } = require('../utils/security');
const { notify } = require('../services/notifications');
const { moderateMessage } = require('../services/moderation');
const b2 = require('../providers/b2');

const router = express.Router();

function accessToken(userId,sessionId) {
  return jwt.sign(
    {sub:userId,sessionId,type:'access'},
    env.jwt.secret,
    {expiresIn:env.jwt.expiresIn}
  );
}

function refreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function expiryDate(days) {
  const d = new Date();
  d.setDate(d.getDate()+days);
  return d;
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g,'');
}

async function createSession(userId,req,body={}) {
  const sessionId = uuidv4();

  await query(
    `INSERT INTO sessions
     (id,user_id,device_type,device_model,os_version,app_version,ip_address)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      sessionId,
      userId,
      body.deviceType || null,
      body.deviceName || body.deviceId || null,
      body.osVersion || null,
      body.appVersion || null,
      req.ip
    ]
  );

  const refresh = refreshToken();

  await query(
    `INSERT INTO refresh_tokens
     (id,user_id,session_id,token_hash,device_id,device_name,device_type,
      os_version,app_version,ip_address,user_agent,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      uuidv4(),
      userId,
      sessionId,
      hashSecret(refresh),
      body.deviceId || null,
      body.deviceName || null,
      body.deviceType || null,
      body.osVersion || null,
      body.appVersion || null,
      req.ip,
      req.headers['user-agent'] || null,
      expiryDate(env.jwt.refreshTokenExpiresDays).toISOString()
    ]
  );

  return {
    accessToken:accessToken(userId,sessionId),
    refreshToken:refresh,
    sessionId
  };
}

/* MENTION EXTRACTION HELPER */

function extractMentionUsernames(text) {
  if (!text) return [];
  const matches = String(text).match(/@([a-zA-Z0-9_]{3,32})/g) || [];
  const seen = {};
  const out = [];
  for (const m of matches) {
    const u = m.slice(1).toLowerCase();
    if (!seen[u]) {
      seen[u] = true;
      out.push(u);
    }
  }
  return out;
}

async function attachMentions(rows) {
  const all = {};
  for (const row of rows) {
    const names = extractMentionUsernames(row.text);
    for (const n of names) all[n] = true;
  }
  const list = Object.keys(all);
  if (!list.length) {
    return rows.map(r => ({ ...r, mentions: [] }));
  }
  const placeholders = list.map((_, i) => `${i + 1}`).join(",");
  let found = { rows: [] };
  try {
    found = await query(
      `SELECT id, username, first_name, surname, profile_photo_media_id FROM users WHERE lower(username) IN (${placeholders})`,
      list
    );
  } catch (e) {
    console.error("[MENTIONS-LOOKUP]", e.message);
  }
  const map = {};
  for (const u of found.rows) {
    map[String(u.username).toLowerCase()] = u;
  }
  return rows.map(r => {
    const names = extractMentionUsernames(r.text);
    const mentions = [];
    for (const n of names) {
      const u = map[n];
      if (u) {
        mentions.push({
          username: n,
          user_id: u.id,
          first_name: u.first_name || null,
          surname: u.surname || null,
          profile_photo_media_id: u.profile_photo_media_id || null
        });
      }
    }
    return { ...r, mentions };
  });
}

/* HEALTH */

router.get('/health',(req,res)=>{
  res.json({
    success:true,
    service:'Connecto API',
    version:'v1',
    status:'online',
    timestamp:new Date().toISOString()
  });
});

router.get('/health/db',async(req,res)=>{
  const r = await query('SELECT CURRENT_TIMESTAMP AS server_time');
  res.json({
    success:true,
    database:'connected',
    server_time:r.rows[0].server_time
  });
});

router.get('/providers/status',async(req,res)=>{
  res.json({
    success:true,
    providers:{
      turso:true,
      fcm:!!(
        env.fcm.projectId &&
        env.fcm.clientEmail &&
        env.fcm.privateKey
      ),
      b2:await b2.configured(),
      websocket:true,
      webrtc_signaling:true
    }
  });
});

/* REGISTRATION */

router.post('/auth/register',async(req,res,next)=>{
  try {
    const schema = z.object({
      name:z.string().min(1).max(80),
      surname:z.string().min(1).max(80),
      email:z.string().email(),
      password:z.string().min(8),
      mobile:z.string().max(40).optional().or(z.literal(""))
    });

    const data = schema.parse(req.body);

    const exists = await query(
      `SELECT id FROM users
       WHERE lower(email)=lower($1)
          OR ($2 IS NOT NULL AND mobile=$2)
       LIMIT 1`,
      [data.email,data.mobile || null]
    );

    if (exists.rows.length) {
      return res.status(409).json({
        success:false,
        error:'EMAIL_ALREADY_EXISTS',
        message:'An account with this email already exists. Please log in instead.'
      });
    }

    const passwordHash = await bcrypt.hash(data.password,12);
    const userId = uuidv4();

    const baseUsername = cleanUsername(
      `${data.name}_${data.surname}`
    ).slice(0,40) || "user";

    let username = baseUsername;
    let suffix = 1;

    while (true) {
      const usernameCheck = await query(
        `SELECT id FROM users
         WHERE lower(username)=lower($1)
         LIMIT 1`,
        [username]
      );

      if (!usernameCheck.rows.length) break;

      username = `${baseUsername}_${suffix++}`;
    }

    const user = await query(
      `INSERT INTO users
       (id,first_name,surname,email,username,password_hash,mobile,account_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'active')
       RETURNING id,first_name,surname,email,username,mobile,created_at`,
      [
        userId,
        data.name,
        data.surname,
        data.email.toLowerCase(),
        username,
        passwordHash,
        data.mobile || null
      ]
    );

    await query(
      `INSERT INTO user_settings(user_id)
       VALUES($1)
       ON CONFLICT DO NOTHING`,
      [user.rows[0].id]
    );

    const session = await createSession(
      user.rows[0].id,
      req,
      req.body
    );

    res.status(201).json({
      success:true,
      user:user.rows[0],
      ...session,
      nextStep:'complete-profile'
    });

  } catch(err) {
    next(err);
  }
});

router.post('/auth/login',async(req,res,next)=>{
  try {
    const identifier = String(
      req.body.identifier ||
      req.body.email ||
      req.body.username ||
      req.body.mobile ||
      ''
    ).trim();

    const result = await query(
      `SELECT * FROM users
       WHERE lower(email)=lower($1)
          OR lower(username)=lower($1)
          OR mobile=$1
       LIMIT 1`,
      [identifier]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      req.body.password || '',
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Invalid credentials'
      });
    }

    const session = await createSession(user.id,req,req.body);

    await query(
      `INSERT INTO security_events
       (user_id,event_type,ip_address,metadata)
       VALUES($1,'SECURITY_LOGIN',$2,$3)`,
      [
        user.id,
        req.ip,
        JSON.stringify({
          deviceId:req.body.deviceId || null,
          deviceType:req.body.deviceType || null,
          deviceName:req.body.deviceName || null,
          osVersion:req.body.osVersion || null,
          appVersion:req.body.appVersion || null
        })
      ]
    );

    res.json({
      success:true,
      user:{
        id:user.id,
        name:user.first_name,
        surname:user.surname,
        email:user.email,
        username:user.username
      },
      ...session
    });

  } catch(err) {
    next(err);
  }
});

router.post('/auth/refresh',async(req,res)=>{
  const raw = req.body.refreshToken;

  if (!raw) {
    return res.status(400).json({
      success:false,
      error:'refreshToken required'
    });
  }

  const result = await query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash=$1
       AND revoked_at IS NULL
       AND expires_at>CURRENT_TIMESTAMP
     LIMIT 1`,
    [hashSecret(raw)]
  );

  if (!result.rows.length) {
    return res.status(401).json({
      success:false,
      error:'Invalid refresh token'
    });
  }

  const row = result.rows[0];

  await query(
    `UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [row.id]
  );

  const session = await createSession(row.user_id,req,{
    deviceId:row.device_id,
    deviceName:row.device_name,
    deviceType:row.device_type,
    osVersion:row.os_version,
    appVersion:row.app_version
  });

  res.json({success:true,...session});
});

router.post('/auth/logout',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [req.user.id]
    );

    await query(
      `UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [req.user.id]
    );

    res.json({success:true});
  } catch (err) {
    next(err);
  }
});

router.get('/auth/me',auth,(req,res)=>{
  res.json({
    success:true,
    user:req.user
  });
});

/* PROFILE */

router.post('/profile/complete',auth,async(req,res,next)=>{
  try {
    let username = cleanUsername(req.body.username);

    if (!username) {
      const current = await query(
        `SELECT username FROM users WHERE id=$1 LIMIT 1`,
        [req.user.id]
      );
      username = (current.rows[0] && current.rows[0].username) || "";
    }

    if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({
        success:false,
        error:'Username must be 3-32 characters using lowercase letters, numbers and underscores'
      });
    }

    const reserved = [
      'connecto','official','admin','administrator','support',
      'security','help','moderator','team','ceo','root'
    ];

    if (reserved.includes(username)) {
      return res.status(409).json({
        success:false,
        error:'Username is reserved'
      });
    }

    const taken = await query(
      `SELECT id FROM users
       WHERE lower(username)=lower($1)
         AND id<>$2`,
      [username,req.user.id]
    );

    if (taken.rows.length) {
      return res.status(409).json({
        success:false,
        error:'Username is already taken'
      });
    }

    const gender =
      ['Male','Female','Rather not say'].includes(req.body.gender)
        ? req.body.gender
        : null;

    const result = await query(
      `UPDATE users
       SET username=$1,
           bio=$2,
           category=$3,
           country=$4,
           state=$5,
           gender=$6,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$7
       RETURNING id,first_name,surname,email,username,bio,category,country,state,gender,
                 profile_photo_media_id,cover_photo_media_id`,
      [
        username,
        req.body.bio || null,
        req.body.category || null,
        req.body.country || null,
        req.body.state || null,
        gender,
        req.user.id
      ]
    );

    res.json({
      success:true,
      user:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

router.patch('/profile',auth,async(req,res,next)=>{
  try {
    const allowed = [
      'bio',
      'category',
      'country',
      'state',
      'gender',
      'profile_photo_media_id',
      'cover_photo_media_id'
    ];

    const fields=[];
    const values=[];
    let n=1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        fields.push(`${field}=$${n++}`);
        values.push(req.body[field]);
      }
    }

    if (!fields.length) {
      return res.status(400).json({
        success:false,
        error:'No editable profile fields supplied'
      });
    }

    values.push(req.user.id);

    const result = await query(
      `UPDATE users SET ${fields.join(',')},updated_at=CURRENT_TIMESTAMP
       WHERE id=$${n}
       RETURNING id,first_name,surname,email,username,bio,category,country,state,gender,
                 profile_photo_media_id,cover_photo_media_id`,
      values
    );

    res.json({
      success:true,
      user:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

/* USERS / SOCIAL */

router.get('/users/search',auth,async(req,res,next)=>{
  try {
    const q = String(req.query.q || '').trim();
    const country = req.query.country || null;
    const gender = req.query.gender || null;
    const limit = Math.min(Number(req.query.limit || 20),50);

    const result = await query(
      `SELECT id,first_name,surname,username,bio,category,country,state,gender,
              profile_photo_media_id
       FROM users
       WHERE account_status='active'
         AND id<>$1
         AND ($2='' OR first_name LIKE '%'||$2||'%' OR surname LIKE '%'||$2||'%' OR username LIKE '%'||$2||'%')
         AND ($3 IS NULL OR country=$3)
         AND ($4 IS NULL OR gender=$4)
       ORDER BY created_at DESC
       LIMIT $5`,
      [req.user.id,q,country,gender,limit]
    );

    res.json({success:true,users:result.rows});
  } catch(err) {
    next(err);
  }
});

router.post('/social/follow/:userId',auth,async(req,res,next)=>{
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({
        success:false,
        error:'Cannot follow yourself'
      });
    }

    await query(
      `INSERT INTO follows(follower_id,following_id)
       VALUES($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id,req.params.userId]
    );

    await notify({
      userId: req.params.userId,
      actorId:req.user.id,
      type:'USER_FOLLOWED',
      title:'New follower',
      body:`${req.user.first_name} started following you`,
      targetType:'user',
      targetId:req.user.id
    });

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/social/follow/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM follows
       WHERE follower_id=$1 AND following_id=$2`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/social/friend-request/:userId',auth,async(req,res,next)=>{
  try {
    const existing = await query(
      `SELECT id FROM friend_requests
       WHERE sender_id=$1 AND receiver_id=$2
       LIMIT 1`,
      [req.user.id,req.params.userId]
    );

    if (!existing.rows.length) {
      await query(
        `INSERT INTO friend_requests (id,sender_id,receiver_id)
         VALUES($1,$2,$3)`,
        [uuidv4(),req.user.id,req.params.userId]
      );

      await notify({
        userId: req.params.userId,
        actorId:req.user.id,
        type:'FRIEND_REQUESTED',
        title:'Friend request',
        body:`${req.user.first_name} sent you a friend request`,
        targetType:'user',
        targetId:req.user.id
      });
    }

    res.status(201).json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/social/friend-request/:id/accept',auth,async(req,res,next)=>{
  try {
    const request = await query(
      `SELECT * FROM friend_requests
       WHERE id=$1 AND receiver_id=$2 AND status='pending'`,
      [req.params.id,req.user.id]
    );

    if (!request.rows.length) {
      return res.status(404).json({
        success:false,
        error:'Friend request not found'
      });
    }

    const r = request.rows[0];

    await query(
      `UPDATE friend_requests SET status='accepted',updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [r.id]
    );

    await query(
      `INSERT INTO friendships(user_a_id,user_b_id)
       VALUES($1,$2),($2,$1)
       ON CONFLICT DO NOTHING`,
      [r.sender_id,r.receiver_id]
    );

    await notify({
      userId:r.sender_id,
      actorId:req.user.id,
      type:'FRIEND_ACCEPTED',
      title:'Friend request accepted',
      body:`${req.user.first_name} accepted your friend request`,
      targetType:'user',
      targetId:req.user.id
    });

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* POSTS / FEED */

router.post('/posts',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO posts(id,author_id,text,audience,comments_enabled,share_enabled)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        uuidv4(),
        req.user.id,
        req.body.body || null,
        req.body.visibility || 'public',
        req.body.commentsEnabled !== false,
        req.body.shareEnabled !== false
      ]
    );

    res.status(201).json({
      success:true,
      post:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.get('/users/:id/posts',auth,async(req,res,next)=>{
  try {
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const type = String(req.query.type || '').toLowerCase();

    let extra = '';
    if (type === 'image') {
      extra = " AND EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.type='image' AND m.deleted_at IS NULL)";
    } else if (type === 'comic') {
      extra = " AND NOT EXISTS (SELECT 1 FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL)";
    }

    const r = await query(
      `SELECT p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.like_count_visible, p.share_enabled, p.original_post_id, p.created_at, p.updated_at, p.deleted_at,
              u.first_name, u.surname, u.username, u.profile_photo_media_id,
              COALESCE(p.view_count, 0) AS view_count,
              (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,
              (SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.author_id=$1 AND p.deleted_at IS NULL
         AND p.audience='public'
         ${extra}
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    const posts = await Promise.all(r.rows.map(async row => {
      let mediaUrl = null;
      if (row.media_key) {
        try {
          if (String(row.media_key).indexOf("http") === 0) {
            mediaUrl = row.media_key;
          } else {
            mediaUrl = await b2.signedDownload(row.media_key, 3600);
          }
        } catch (e) {
          console.error("[USER-POSTS-MEDIA]", e.message);
        }
      }
      return { ...row, media_url: mediaUrl, media_key: undefined };
    }));

    res.json({ success: true, posts, pagination: { limit, offset } });
  } catch(err) {
    next(err);
  }
});

router.post('/link-preview',auth,async(req,res,next)=>{
  try {
    const rawUrl = String(req.body.url || '').trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).json({ success:false, error:'INVALID_URL' });
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return res.status(400).json({ success:false, error:'INVALID_URL' });
    }

    if (!['http:','https:'].includes(parsed.protocol)) {
      return res.status(400).json({ success:false, error:'INVALID_PROTOCOL' });
    }

    const host = parsed.hostname.toLowerCase();

    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return res.status(400).json({ success:false, error:'BLOCKED_HOST' });
    }

    const cacheKey = rawUrl;

    try {
      const cached = await query(
        `SELECT url, title, description, image_url, favicon_url, site_name FROM link_previews WHERE url=$1 LIMIT 1`,
        [cacheKey]
      );
      if (cached.rows.length) {
        return res.json({ success:true, preview:cached.rows[0], cached:true });
      }
    } catch (_) { }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let html = '';
    let contentType = '';
    let statusCode = 0;

    try {
      const resp = await fetch(rawUrl, {
        method:'GET',
        redirect:'follow',
        signal:controller.signal,
        headers:{ 'User-Agent':'ConnectoBot/1.0 (+https://connecto.app)' }
      });
      statusCode = resp.status;
      contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        clearTimeout(timeout);
        return res.status(400).json({ success:false, error:'NOT_HTML', status:statusCode });
      }
      const buf = await resp.arrayBuffer();
      const max = 500 * 1024;
      const slice = buf.byteLength > max ? buf.slice(0, max) : buf;
      html = Buffer.from(slice).toString('utf8');
    } catch (e) {
      clearTimeout(timeout);
      return res.status(502).json({ success:false, error:'FETCH_FAILED', details:String(e.message) });
    }
    clearTimeout(timeout);

    function extractMeta(name) {
      const patterns = [
        new RegExp('<meta[^>]+property=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'),
        new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']' + name + '["\']', 'i'),
        new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'),
        new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']' + name + '["\']', 'i')
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1]) return m[1].trim();
      }
      return null;
    }

    function decodeEntities(s) {
      if (!s) return s;
      return s
        .replace(/&amp;/g,'&')
        .replace(/&lt;/g,'<')
        .replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"')
        .replace(/&#39;/g,"'")
        .replace(/&nbsp;/g,' ');
    }

    let title = extractMeta('og:title') || extractMeta('twitter:title');
    if (!title) {
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m && m[1]) title = m[1].trim();
    }

    const description = extractMeta('og:description') || extractMeta('twitter:description') || extractMeta('description');
    const imageRaw = extractMeta('og:image') || extractMeta('twitter:image') || extractMeta('twitter:image:src');
    const siteName = extractMeta('og:site_name') || extractMeta('application-name') || host;

    let favicon = null;
    const iconMatches = html.match(/<link[^>]+rel=["\'](?:shortcut icon|icon|apple-touch-icon)["\'][^>]*>/gi);
    if (iconMatches) {
      for (const tag of iconMatches) {
        const href = tag.match(/href=["\']([^"\']+)["\']/i);
        if (href && href[1]) {
          favicon = href[1];
          break;
        }
      }
    }

    if (imageRaw && !/^https?:\/\//i.test(imageRaw)) {
      try { imageRaw = new URL(imageRaw, parsed).href; } catch (_) { imageRaw = null; }
    }
    if (favicon && !/^https?:\/\//i.test(favicon)) {
      try { favicon = new URL(favicon, parsed).href; } catch (_) { favicon = null; }
    }
    if (!favicon) {
      favicon = parsed.origin + '/favicon.ico';
    }

    const preview = {
      url: rawUrl,
      title: decodeEntities(title) || host,
      description: decodeEntities(description) || null,
      image_url: imageRaw || null,
      favicon_url: favicon,
      site_name: decodeEntities(siteName) || host
    };

    try {
      await query(
        `INSERT INTO link_previews (url,title,description,image_url,favicon_url,site_name)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(url) DO UPDATE SET
           title=excluded.title,
           description=excluded.description,
           image_url=excluded.image_url,
           favicon_url=excluded.favicon_url,
           site_name=excluded.site_name,
           updated_at=CURRENT_TIMESTAMP`,
        [preview.url, preview.title, preview.description, preview.image_url, preview.favicon_url, preview.site_name]
      );
    } catch (e) {
      console.error('[LINK-PREVIEW-CACHE]', e.message);
    }

    res.json({ success:true, preview, cached:false });
  } catch(err) {
    next(err);
  }
});

router.get('/feed',auth,async(req,res,next)=>{
  try {
    const limit = Math.min(Number(req.query.limit || 20),50);
    const offset = Math.max(Number(req.query.offset || 0),0);

    const result = await query(
      `SELECT
         p.id, p.author_id, p.text, p.audience, p.comments_enabled, p.like_count_visible, p.share_enabled, p.original_post_id, p.created_at, p.updated_at, p.deleted_at,
         u.first_name,u.surname,u.username,u.profile_photo_media_id,
         COALESCE(rc.reaction_count,0) reaction_count,
         COALESCE(cc.comment_count,0) comment_count,
         (SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=$1 LIMIT 1) AS viewer_reacted_int,
         (SELECT m.storage_key FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_key,
         (SELECT m.type FROM media m WHERE m.post_id=p.id AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 1) AS media_type
       FROM posts p
       JOIN users u ON u.id=p.author_id
       LEFT JOIN (
         SELECT post_id,COUNT(*) reaction_count
         FROM reactions GROUP BY post_id
       ) rc ON rc.post_id=p.id
       LEFT JOIN (
         SELECT post_id,COUNT(*) comment_count
         FROM comments WHERE deleted_at IS NULL
         GROUP BY post_id
       ) cc ON cc.post_id=p.id
       WHERE p.deleted_at IS NULL
         AND u.account_status='active'
         AND (
           p.audience='public'
           OR p.author_id=$1
           OR EXISTS(
             SELECT 1 FROM friendships f
             WHERE (f.user_a_id=$1 AND f.user_b_id=p.author_id) OR (f.user_b_id=$1 AND f.user_a_id=p.author_id)
           )
         )
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id,limit,offset]
    );

    const b2Provider = require("../providers/b2");

    const withMedia = await Promise.all(result.rows.map(async r => {
      let mediaUrl = null;
      if (r.media_key) {
        try {
          if (String(r.media_key).indexOf("http") === 0) {
            mediaUrl = r.media_key;
          } else {
            mediaUrl = await b2Provider.signedDownload(r.media_key, 3600);
          }
        } catch (e) {
          console.error("[FEED-MEDIA-SIGN]", e.message);
          mediaUrl = null;
        }
      }
      return {
        ...r,
        viewer_has_reacted: Number(r.viewer_reacted_int) === 1,
        viewer_reacted_int: undefined,
        media_url: mediaUrl
      };
    }));

    const withMentions = await attachMentions(withMedia);

    res.json({
      success:true,
      posts:withMentions,
      pagination:{limit,offset}
    });
  } catch(err) {
    next(err);
  }
});

router.post('/posts/:postId/reactions',auth,async(req,res,next)=>{
  try {
    const reaction = req.body.reaction || 'like';

    const existing = await query(
      `SELECT id FROM reactions
       WHERE post_id=$1 AND user_id=$2 LIMIT 1`,
      [req.params.postId,req.user.id]
    );

    const wasNew = !existing.rows.length;

    if (existing.rows.length) {
      await query(
        `UPDATE reactions SET type=$1 WHERE id=$2`,
        [reaction,existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO reactions(id,post_id,user_id,type)
         VALUES($1,$2,$3,$4)`,
        [uuidv4(),req.params.postId,req.user.id,reaction]
      );
    }

    if (wasNew) {
      try {
        const postOwner = await query(
          `SELECT author_id FROM posts WHERE id=$1 LIMIT 1`,
          [req.params.postId]
        );
        if (postOwner.rows.length && postOwner.rows[0].author_id !== req.user.id) {
          await notify({
            userId: postOwner.rows[0].author_id,
            actorId: req.user.id,
            type: 'POST_REACTED',
            title: 'New reaction',
            body: `${req.user.first_name} reacted to your post`,
            targetType: 'post',
            targetId: req.params.postId
          });
        }
      } catch (e) {
        console.error('[REACTION-NOTIFY]', e.message);
      }
    }

    res.json({success:true,reaction});
  } catch(err) {
    next(err);
  }
});

router.delete('/posts/:postId/reactions',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM reactions
       WHERE post_id=$1 AND user_id=$2`,
      [req.params.postId,req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/posts/:id/view',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

router.post('/posts/:postId/comments',auth,async(req,res,next)=>{
  try {
    if (!req.body.body || !String(req.body.body).trim()) {
      return res.status(400).json({
        success:false,
        error:'Comment body required'
      });
    }

    const result = await query(
      `INSERT INTO comments(id,post_id,author_id,parent_comment_id,body)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        uuidv4(),
        req.params.postId,
        req.user.id,
        req.body.parentId || null,
        String(req.body.body).trim()
      ]
    );

    try {
      const postOwner = await query(
        `SELECT author_id FROM posts WHERE id=$1 LIMIT 1`,
        [req.params.postId]
      );
      if (postOwner.rows.length && postOwner.rows[0].author_id !== req.user.id) {
        await notify({
          userId: postOwner.rows[0].author_id,
          actorId: req.user.id,
          type: 'POST_COMMENTED',
          title: 'New comment',
          body: `${req.user.first_name} commented on your post`,
          targetType: 'post',
          targetId: req.params.postId
        });
      }
    } catch (e) {
      console.error('[COMMENT-NOTIFY]', e.message);
    }

    res.status(201).json({
      success:true,
      comment:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* CHAT */

router.post('/chat/conversations',auth,async(req,res,next)=>{
  try {
    const otherUserId = req.body.userId;

    if (!otherUserId) {
      return res.status(400).json({
        success:false,
        error:'userId required'
      });
    }

    const existing = await query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id=c.id
       JOIN conversation_members b ON b.conversation_id=c.id
       WHERE c.type='direct'
         AND a.user_id=$1
         AND b.user_id=$2
       LIMIT 1`,
      [req.user.id,otherUserId]
    );

    if (existing.rows.length) {
      return res.json({
        success:true,
        conversationId:existing.rows[0].id
      });
    }

    const conversation = await query(
      `INSERT INTO conversations(id,type,created_by)
       VALUES($1,'direct',$2) RETURNING id`,
      [uuidv4(),req.user.id]
    );

    const id = conversation.rows[0].id;

    await query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [id,req.user.id,otherUserId]
    );

    res.status(201).json({
      success:true,
      conversationId:id
    });

  } catch(err) {
    next(err);
  }
});

router.get('/chat/conversations',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT c.id,c.type,c.created_at,c.updated_at
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id=c.id
       WHERE cm.user_id=$1
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );

    res.json({
      success:true,
      conversations:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.get('/chat/conversations/:id/messages',auth,async(req,res,next)=>{
  try {
    const member = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    if (!member.rows.length) {
      return res.status(403).json({
        success:false,
        error:'Not a conversation member'
      });
    }

    const result = await query(
      `SELECT m.*,u.first_name,u.surname,u.username,u.profile_photo_media_id
       FROM messages m
       JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=$1
       ORDER BY m.sent_at ASC
       LIMIT 100`,
      [req.params.id]
    );

    res.json({
      success:true,
      messages:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/chat/conversations/:id/messages',auth,async(req,res,next)=>{
  try {
    const member = await query(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    if (!member.rows.length) {
      return res.status(403).json({
        success:false,
        error:'Not a conversation member'
      });
    }

    const text = String(req.body.body || '').trim();

    if (!text) {
      return res.status(400).json({
        success:false,
        error:'Message body required'
      });
    }

    const inserted = await query(
      `INSERT INTO messages
       (id,conversation_id,sender_id,body,message_type,reply_to_message_id)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        uuidv4(),
        req.params.id,
        req.user.id,
        text,
        req.body.messageType || 'text',
        req.body.replyToId || null
      ]
    );

    const message = inserted.rows[0];

    const moderation = await moderateMessage({
      userId:req.user.id,
      messageId:message.id,
      text
    });

    if (!moderation.allowed) {
      await query(
        `UPDATE messages
         SET deleted_at=CURRENT_TIMESTAMP,body=$1
         WHERE id=$2`,
        [moderation.replacement,message.id]
      );

      return res.status(422).json({
        success:false,
        error:moderation.replacement,
        moderated:true
      });
    }

    await query(
      `UPDATE conversations SET updated_at=CURRENT_TIMESTAMP
       WHERE id=$1`,
      [req.params.id]
    );

    res.status(201).json({
      success:true,
      message
    });

  } catch(err) {
    next(err);
  }
});

/* CALLS / WEBRTC SIGNALING */

router.post('/calls',auth,async(req,res,next)=>{
  try {
    if (!req.body.receiverId) {
      return res.status(400).json({
        success:false,
        error:'receiverId required'
      });
    }

    const result = await query(
      `INSERT INTO calls
       (id,conversation_id,caller_id,receiver_id,call_type)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        uuidv4(),
        req.body.conversationId || null,
        req.user.id,
        req.body.receiverId,
        req.body.type || 'video'
      ]
    );

    await notify({
      userId:req.body.receiverId,
      actorId:req.user.id,
      type:'CALL_RECEIVED',
      title:'Incoming call',
      body:`${req.user.first_name} is calling you`,
      targetType:'call',
      targetId:result.rows[0].id
    });

    res.status(201).json({
      success:true,
      call:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

router.get('/calls/:id',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM calls
       WHERE id=$1
       AND (caller_id=$2 OR receiver_id=$2)`,
      [req.params.id,req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success:false,
        error:'Call not found'
      });
    }

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/accept',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='accepted',accepted_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND receiver_id=$2
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/reject',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='rejected',ended_at=CURRENT_TIMESTAMP
       WHERE id=$1
       AND (receiver_id=$2 OR caller_id=$2)
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/end',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `UPDATE calls
       SET status='ended',ended_at=CURRENT_TIMESTAMP
       WHERE id=$1
       AND (receiver_id=$2 OR caller_id=$2)
       RETURNING *`,
      [req.params.id,req.user.id]
    );

    res.json({
      success:true,
      call:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

router.post('/calls/:id/signal',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO call_signals
       (id,call_id,sender_id,signal_type,payload)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        uuidv4(),
        req.params.id,
        req.user.id,
        req.body.signalType,
        JSON.stringify(req.body.payload || {})
      ]
    );

    res.status(201).json({
      success:true,
      signal:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* BLOCKING / REPORTING */

router.post('/blocks/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `INSERT INTO blocks(id,blocker_id,blocked_id)
       VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [uuidv4(),req.user.id,req.params.userId]
    );

    await query(
      `DELETE FROM follows
       WHERE (follower_id=$1 AND following_id=$2)
          OR (follower_id=$2 AND following_id=$1)`,
      [req.user.id,req.params.userId]
    );

    await query(
      `DELETE FROM friendships
       WHERE (user_a_id=$1 AND user_b_id=$2)
          OR (user_a_id=$2 AND user_b_id=$1)`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/blocks/:userId',auth,async(req,res,next)=>{
  try {
    await query(
      `DELETE FROM blocks
       WHERE blocker_id=$1 AND blocked_id=$2`,
      [req.user.id,req.params.userId]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.post('/reports',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `INSERT INTO reports
       (id,reporter_id,reported_user_id,post_id,message_id,category,description)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,status,created_at`,
      [
        uuidv4(),
        req.user.id,
        req.body.reportedUserId || null,
        req.body.postId || null,
        req.body.messageId || null,
        req.body.category,
        req.body.description || null
      ]
    );

    res.status(201).json({
      success:true,
      report:result.rows[0]
    });
  } catch(err) {
    next(err);
  }
});

/* DEVICES / PUSH */

router.post('/devices',auth,async(req,res,next)=>{
  try {
    if (!req.body.fcmToken) {
      return res.status(400).json({
        success:false,
        error:'fcmToken required'
      });
    }

    const existing = await query(
      `SELECT id FROM device_tokens WHERE token=$1 LIMIT 1`,
      [req.body.fcmToken]
    );

    if (existing.rows.length) {
      await query(
        `UPDATE device_tokens
         SET user_id=$1,active=1,updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [req.user.id,existing.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO device_tokens
         (id,user_id,token,device_type,device_model,os_version,app_version,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,1)`,
        [
          uuidv4(),
          req.user.id,
          req.body.fcmToken,
          req.body.deviceType || 'android',
          req.body.deviceName || null,
          req.body.osVersion || null,
          req.body.appVersion || null
        ]
      );
    }

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

router.delete('/devices/:token',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE device_tokens
       SET active=0,updated_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND token=$2`,
      [req.user.id,req.params.token]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* NOTIFICATIONS */

router.get('/notifications',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM notifications
       WHERE recipient_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      success:true,
      notifications:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/notifications/read-all',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE notifications
       SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP)
       WHERE recipient_id=$1`,
      [req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* API KEYS */

router.post('/developer/api-keys',auth,async(req,res,next)=>{
  try {
    const secret = `cx_${randomSecret(32)}`;
    const prefix = secret.slice(0,11);

    const result = await query(
      `INSERT INTO api_keys
       (id,user_id,name,key_prefix,secret_hash)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,name,key_prefix,created_at`,
      [
        uuidv4(),
        req.user.id,
        req.body.name || 'Connecto API Key',
        prefix,
        hashSecret(secret)
      ]
    );

    res.status(201).json({
      success:true,
      apiKey:result.rows[0],
      secret,
      warning:'Store this secret securely. It will not be shown again.'
    });

  } catch(err) {
    next(err);
  }
});

router.get('/developer/api-keys',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT id,name,key_prefix,last_used_at,created_at,revoked_at
       FROM api_keys
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success:true,
      apiKeys:result.rows
    });
  } catch(err) {
    next(err);
  }
});

router.post('/developer/api-keys/:id/revoke',auth,async(req,res,next)=>{
  try {
    await query(
      `UPDATE api_keys
       SET revoked_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND user_id=$2`,
      [req.params.id,req.user.id]
    );

    res.json({success:true});
  } catch(err) {
    next(err);
  }
});

/* SETTINGS */

router.get('/settings',auth,async(req,res,next)=>{
  try {
    const result = await query(
      `SELECT * FROM user_settings WHERE user_id=$1`,
      [req.user.id]
    );

    res.json({
      success:true,
      settings:result.rows[0] || null
    });
  } catch(err) {
    next(err);
  }
});

router.patch('/settings',auth,async(req,res,next)=>{
  try {
    const fields = [
      'profile_visibility',
      'friend_visibility',
      'follower_visibility',
      'message_privacy',
      'typing_enabled',
      'disappearing_messages',
      'two_factor_enabled',
      'biometric_enabled'
    ];

    const assignments=[];
    const values=[];
    let n=1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        assignments.push(`${field}=$${n++}`);
        values.push(req.body[field]);
      }
    }

    if (!assignments.length) {
      return res.status(400).json({
        success:false,
        error:'No settings supplied'
      });
    }

    values.push(req.user.id);

    await query(
      `INSERT INTO user_settings(user_id)
       VALUES($1)
       ON CONFLICT DO NOTHING`,
      [req.user.id]
    );

    const result = await query(
      `UPDATE user_settings
       SET ${assignments.join(',')},updated_at=CURRENT_TIMESTAMP
       WHERE user_id=$${n}
       RETURNING *`,
      values
    );

    res.json({
      success:true,
      settings:result.rows[0]
    });

  } catch(err) {
    next(err);
  }
});

/* PASSWORD */

router.post('/auth/change-password',auth,async(req,res,next)=>{
  try {
    if (!req.body.currentPassword || !req.body.newPassword) {
      return res.status(400).json({
        success:false,
        error:'Current and new password are required'
      });
    }

    const result = await query(
      `SELECT password_hash FROM users WHERE id=$1`,
      [req.user.id]
    );

    const valid = await bcrypt.compare(
      req.body.currentPassword,
      result.rows[0].password_hash
    );

    if (!valid) {
      return res.status(401).json({
        success:false,
        error:'Current password is incorrect'
      });
    }

    if (String(req.body.newPassword).length < 8) {
      return res.status(400).json({
        success:false,
        error:'New password must contain at least 8 characters'
      });
    }

    const hash = await bcrypt.hash(req.body.newPassword,12);

    await query(
      `UPDATE users SET password_hash=$1,updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [hash,req.user.id]
    );

    await query(
      `UPDATE refresh_tokens
       SET revoked_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [req.user.id]
    );

    await query(
      `INSERT INTO security_events(user_id,event_type,metadata)
       VALUES($1,'PASSWORD_CHANGED',$2)`,
      [req.user.id,JSON.stringify({time:new Date().toISOString()})]
    );

    res.json({
      success:true,
      message:'Password changed. Existing sessions were revoked.'
    });

  } catch(err) {
    next(err);
  }
});

module.exports = router;
