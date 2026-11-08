// ============================================================
// Rahat AI Workstation — Cloudflare Worker
// Private, single-owner AI workstation.
//   - OpenRouter: streaming chat + dedicated Image API
//   - Cloudflare D1: users, sessions, chats, agents, settings
//   - Backblaze B2 (S3 API, presigned URLs): private file storage
// Frontend is served from /public via the ASSETS binding.
// ============================================================

const SESSION_COOKIE = 'rahat_session';
const SESSION_DAYS = 30;
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // images ≤ 10 MB (as requested)
const MAX_OTHER_BYTES = 30 * 1024 * 1024;  // pdf/audio/video ≤ 30 MB
const MODEL_INLINE_CAP = 8 * 1024 * 1024;  // max bytes we inline from B2 into a model call

const DEFAULT_SYSTEM_PROMPT =
  "You are the AI of Rahat's private AI workstation. Address the user as Rahat. " +
  'Lead with the answer, then the reasoning, then next actions. Be direct, honest and concise. ' +
  'Use any attached documents, images, audio or video as context.';

const SEED_AGENTS = [
  {
    name: 'Rahat — CEO',
    emoji: '👑',
    description: 'Your executive chief of staff (default)',
    is_default: 1,
    temperature: 0.7,
    system_prompt:
      "You are Rahat's personal AI chief of staff. Rahat is the CEO and the only user of this private workstation. " +
      'Address him as Rahat. Work at an executive level: lead with the bottom line, then the supporting reasoning, ' +
      'then clear next actions. You draft emails, briefings, decisions, negotiations, plans and research on his behalf. ' +
      'Be direct and honest — flag risks, surface opportunities and push back when needed. ' +
      'Use any attached documents, images, audio or video he provides as context. ' +
      'If a task needs a file he has not attached yet, ask for it once, then proceed with stated assumptions.',
  },
  {
    name: 'Strategist',
    emoji: '📈',
    description: 'Market & business analysis',
    is_default: 0,
    temperature: 0.6,
    system_prompt:
      'You are a world-class business strategist and analyst working for Rahat, the CEO. ' +
      'Break down markets, competitors, unit economics and growth plays with concrete numbers and frameworks ' +
      '(SWOT, Porter, funnel math, cohort math). State assumptions explicitly, show quick back-of-envelope ' +
      'calculations, and end with a prioritized recommendation. Challenge weak ideas respectfully.',
  },
  {
    name: 'Engineer',
    emoji: '🧑‍💻',
    description: 'Senior software engineer',
    is_default: 0,
    temperature: 0.4,
    system_prompt:
      'You are a senior staff software engineer working for Rahat. Write production-grade code: correct, secure, ' +
      'minimal and well-structured. Prefer concrete code over prose, explain tricky parts briefly, mention edge ' +
      'cases and security pitfalls, and include how to run or test what you wrote. If requirements are ambiguous, ' +
      'state your assumption in one line and proceed.',
  },
];

const CURATED_IMAGE_MODELS = [
  'google/gemini-2.5-flash-image',
  'google/gemini-2.5-flash-image-preview',
  'bytedance-seed/seedream-4.5',
  'openai/gpt-image-1',
];

// ------------------------------------------------------------
// Small utilities
// ------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = (s) => new TextEncoder().encode(s);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', enc(str)));
}

async function hmac(keyBytes, dataStr) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc(dataStr));
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return toHex(b);
}

function sanitizeName(name) {
  const safe = String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.slice(-80);
}

function fileKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

function maxBytesFor(kind) {
  return kind === 'image' ? MAX_IMAGE_BYTES : MAX_OTHER_BYTES;
}

// ------------------------------------------------------------
// Auth (single owner)
// ------------------------------------------------------------

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc(salt), iterations: 120000, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function getSessionUser(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')`
  )
    .bind(tokenHash)
    .first();
}

async function requireUser(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user;
}

async function createSession(env, userId) {
  const token = randHex(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?1, ?2, datetime('now', '+${SESSION_DAYS} days'))`
  )
    .bind(tokenHash, userId)
    .run();
  return token;
}

async function seedDefaults(env, userId) {
  for (const a of SEED_AGENTS) {
    await env.DB.prepare(
      `INSERT INTO agents (user_id, name, emoji, description, system_prompt, temperature, is_default)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
      .bind(userId, a.name, a.emoji, a.description, a.system_prompt, a.temperature, a.is_default)
      .run();
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('default_model', ?1)`).bind(DEFAULT_MODEL).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('default_image_model', ?1)`).bind(DEFAULT_IMAGE_MODEL).run();
}

// ------------------------------------------------------------
// Backblaze B2 (S3-compatible API, AWS Signature V4 presigned URLs)
// ------------------------------------------------------------

let b2s3Cache = null; // { endpoint, region, expiresAt }

async function b2S3(env) {
  if (b2s3Cache && Date.now() < b2s3Cache.expiresAt) return b2s3Cache;
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new HttpError(500, `B2 authorize failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const host = new URL(j.s3ApiUrl).host;
  const region = (host.match(/s3\.([a-z0-9-]+)\./i) || [])[1] || 'us-west-004';
  b2s3Cache = { endpoint: j.s3ApiUrl.replace(/\/$/, ''), region, expiresAt: Date.now() + 20 * 3600 * 1000 };
  return b2s3Cache;
}

const URI_RE = /[!'()*]/g;
const encRfc3986 = (s) => encodeURIComponent(s).replace(URI_RE, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Build a presigned URL for GET / PUT / DELETE on a private object.
async function presignS3(env, method, key, { expires = 3600, contentType = null } = {}) {
  const s3 = await b2S3(env);
  const host = new URL(s3.endpoint).host;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${s3.region}/s3/aws4_request`;
  const credential = `${env.B2_KEY_ID}/${scope}`;

  const signedHeaders = contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = contentType ? `content-type:${contentType}\nhost:${host}\n` : `host:${host}\n`;

  const canonicalUri = `/${env.B2_BUCKET_NAME}/${key.split('/').map(encRfc3986).join('/')}`;
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const canonicalQuery = params.map(([k, v]) => `${encRfc3986(k)}=${encRfc3986(v)}`).join('&');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(enc('AWS4' + env.B2_APP_KEY), dateStamp);
  const kRegion = await hmac(kDate, s3.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `${s3.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Fetch a stored object into memory with a size cap (for model payloads).
async function fetchObject(env, key, cap) {
  const url = await presignS3(env, 'GET', key, { expires: 300 });
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(500, `Could not read stored file (${res.status})`);
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len && len > cap) throw new HttpError(413, 'File is too large to send to the model. Try a smaller file.');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > cap) throw new HttpError(413, 'File is too large to send to the model. Try a smaller file.');
  return buf;
}

async function deleteObject(env, key) {
  try {
    const url = await presignS3(env, 'DELETE', key, { expires: 300 });
    await fetch(url, { method: 'DELETE' });
  } catch {
    // best effort
  }
}

// ------------------------------------------------------------
// Settings / agents helpers
// ------------------------------------------------------------

async function getSettings(env) {
  const rows = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const s = { default_model: DEFAULT_MODEL, default_image_model: DEFAULT_IMAGE_MODEL };
  for (const r of rows.results) s[r.key] = r.value;
  return s;
}

async function getAgent(env, userId, agentId) {
  if (!agentId) return null;
  return env.DB.prepare(`SELECT * FROM agents WHERE id = ?1 AND user_id = ?2`).bind(agentId, userId).first() || null;
}

async function assertConversation(env, userId, id) {
  const row = await env.DB.prepare(`SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first();
  if (!row) throw new HttpError(404, 'Conversation not found');
}

// ------------------------------------------------------------
// OpenRouter
// ------------------------------------------------------------

let chatModelsCache = { at: 0, data: [] };
let imageModelsCache = { at: 0, data: [] };

async function listChatModels() {
  if (chatModelsCache.data.length && Date.now() - chatModelsCache.at < 6 * 3600 * 1000) return chatModelsCache.data;
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) return chatModelsCache.data;
  const j = await res.json();
  chatModelsCache = {
    at: Date.now(),
    data: (j.data || []).map((m) => ({ id: m.id, name: m.name, context_length: m.context_length })),
  };
  return chatModelsCache.data;
}

async function listImageModels() {
  if (imageModelsCache.data.length && Date.now() - imageModelsCache.at < 6 * 3600 * 1000) return imageModelsCache.data;
  const res = await fetch('https://openrouter.ai/api/v1/images/models');
  if (!res.ok) return CURATED_IMAGE_MODELS.map((id) => ({ id, name: id }));
  const j = await res.json();
  imageModelsCache = {
    at: Date.now(),
    data: (j.data || []).map((m) => ({ id: m.id, name: m.name || m.id })),
  };
  return imageModelsCache.data;
}

function openRouterHeaders(env, request) {
  const origin = new URL(request.url).origin;
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': origin,
    'X-Title': 'Rahat AI Workstation',
  };
}

// Turn an attachment row (plus optional client-provided resized data URL) into
// an OpenRouter multimodal content part.
async function modelPartFor(env, att) {
  if (att.kind === 'image') {
    let url = att.inline;
    if (!url) url = `data:${att.mime_type};base64,${bufToB64(await fetchObject(env, att.b2_key, MODEL_INLINE_CAP))}`;
    return { type: 'image_url', image_url: { url } };
  }
  const buf = await fetchObject(env, att.b2_key, MODEL_INLINE_CAP);
  if (att.kind === 'pdf') {
    return { type: 'file', file: { filename: att.file_name, file_data: `data:application/pdf;base64,${bufToB64(buf)}` } };
  }
  if (att.kind === 'audio') {
    const format = (att.mime_type.split('/')[1] || 'mp3').split(';')[0];
    return { type: 'input_audio', input_audio: { data: bufToB64(buf), format } };
  }
  if (att.kind === 'video') {
    return { type: 'video_url', video_url: { url: `data:${att.mime_type};base64,${bufToB64(buf)}` } };
  }
  return { type: 'text', text: `[attached file: ${att.file_name}]` };
}

// ------------------------------------------------------------
// Route handlers
// ------------------------------------------------------------

async function handleAuth(request, env, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = await getSessionUser(env, request);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return json({
      needsSetup: count.n === 0,
      requireSetupCode: !!env.SETUP_CODE,
      user: user ? { id: user.id, email: user.email, name: user.name } : null,
    });
  }

  if (method === 'POST' && pathname === '/api/auth/setup') {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    if (count.n > 0) throw new HttpError(403, 'Setup already completed. Log in instead.');
    const body = await request.json();
    if (env.SETUP_CODE && body.setupCode !== env.SETUP_CODE) throw new HttpError(403, 'Invalid setup code');
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const salt = randHex(16);
    const passwordHash = await hashPassword(password, salt);
    const r = await env.DB.prepare(`INSERT INTO users (email, name, password_hash, salt) VALUES (?1, ?2, ?3, ?4)`)
      .bind(email, String(body.name || 'Rahat').slice(0, 80), passwordHash, salt)
      .run();
    const userId = r.meta.last_row_id;
    await seedDefaults(env, userId);
    const token = await createSession(env, userId);
    return json(
      { ok: true, user: { id: userId, email, name: body.name || 'Rahat' } },
      200,
      { 'Set-Cookie': sessionCookie(token) }
    );
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first();
    if (!user) throw new HttpError(401, 'Wrong email or password');
    const hash = await hashPassword(String(body.password || ''), user.salt);
    if (hash !== user.password_hash) throw new HttpError(401, 'Wrong email or password');
    const token = await createSession(env, user.id);
    return json({ ok: true, user: { id: user.id, email: user.email, name: user.name } }, 200, {
      'Set-Cookie': sessionCookie(token),
    });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256Hex(token)).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  throw new HttpError(404, 'Not found');
}

async function handleConversations(request, env, user, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/conversations') {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.title, c.agent_id, c.model, c.updated_at,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.user_id = ?1
        ORDER BY c.updated_at DESC LIMIT 200`
    )
      .bind(user.id)
      .all();
    return json({ conversations: rows.results });
  }

  if (method === 'POST' && pathname === '/api/conversations') {
    const body = await request.json().catch(() => ({}));
    const r = await env.DB.prepare(
      `INSERT INTO conversations (user_id, title, agent_id, model) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(user.id, String(body.title || 'New chat').slice(0, 120), body.agentId || null, body.model || null)
      .run();
    return json({ id: r.meta.last_row_id });
  }

  const m = pathname.match(/^\/api\/conversations\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    await assertConversation(env, user.id, id);

    if (method === 'GET') {
      const conv = await env.DB.prepare(`SELECT * FROM conversations WHERE id = ?1`).bind(id).first();
      const msgs = await env.DB.prepare(
        `SELECT id, role, content, model, created_at FROM messages WHERE conversation_id = ?1 ORDER BY id`
      )
        .bind(id)
        .all();
      const atts = await env.DB.prepare(
        `SELECT id, message_id, file_name, mime_type, kind, size FROM attachments WHERE conversation_id = ?1`
      )
        .bind(id)
        .all();
      const byMsg = {};
      for (const a of atts.results) (byMsg[a.message_id] ||= []).push(a);
      return json({
        conversation: conv,
        messages: msgs.results.map((msg) => ({ ...msg, attachments: byMsg[msg.id] || [] })),
      });
    }

    if (method === 'PATCH') {
      const body = await request.json();
      await env.DB.prepare(`UPDATE conversations SET title = ?1 WHERE id = ?2`)
        .bind(String(body.title || 'New chat').slice(0, 120), id)
        .run();
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      const files = await env.DB.prepare(`SELECT id, b2_key FROM attachments WHERE conversation_id = ?1`).bind(id).all();
      await env.DB.prepare(`DELETE FROM attachments WHERE conversation_id = ?1`).bind(id).run();
      await env.DB.prepare(`DELETE FROM conversations WHERE id = ?1`).bind(id).run();
      for (const f of files.results) await deleteObject(env, f.b2_key);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

async function handleUpload(request, env, user, pathname) {
  const method = request.method;

  // Step 1: validate + hand back a presigned PUT URL (browser uploads directly to B2)
  if (method === 'POST' && pathname === '/api/upload/init') {
    const body = await request.json();
    const mime = String(body.mime || 'application/octet-stream').toLowerCase();
    const size = Number(body.size || 0);
    const kind = fileKind(mime);
    if (!kind) throw new HttpError(400, 'Only images, PDFs, audio and video are allowed');
    if (size <= 0) throw new HttpError(400, 'Empty file');
    if (size > maxBytesFor(kind)) {
      throw new HttpError(
        413,
        kind === 'image'
          ? 'Images are limited to 10 MB'
          : 'Files other than images are limited to 30 MB'
      );
    }
    const key = `${user.id}/${Date.now().toString(36)}-${randHex(4)}-${sanitizeName(body.fileName)}`;
    const uploadUrl = await presignS3(env, 'PUT', key, { expires: 3600, contentType: mime });
    return json({ uploadUrl, key, contentType: mime, kind });
  }

  // Step 2: confirm the upload landed, record metadata in D1
  if (method === 'POST' && pathname === '/api/upload/complete') {
    const body = await request.json();
    const key = String(body.key || '');
    if (!key.startsWith(`${user.id}/`)) throw new HttpError(400, 'Bad key');
    const mime = String(body.mime || 'application/octet-stream').toLowerCase();
    const kind = fileKind(mime);
    if (!kind) throw new HttpError(400, 'Unsupported file type');

    // verify the object really exists in the bucket
    const head = await fetch(await presignS3(env, 'GET', key, { expires: 120 }), { method: 'HEAD' });
    if (!head.ok) throw new HttpError(400, 'Upload did not reach storage — try again');

    const r = await env.DB.prepare(
      `INSERT INTO attachments (user_id, conversation_id, message_id, file_name, b2_key, mime_type, kind, size)
       VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(user.id, sanitizeName(body.fileName), key, mime, kind, Number(body.size || 0))
      .run();
    return json({
      id: r.meta.last_row_id,
      fileName: sanitizeName(body.fileName),
      mimeType: mime,
      kind,
      size: Number(body.size || 0),
      url: `/api/files/${r.meta.last_row_id}`,
    });
  }

  const fm = pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (fm && method === 'DELETE') {
    const id = Number(fm[1]);
    const row = await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).first();
    if (!row) throw new HttpError(404, 'Not found');
    await env.DB.prepare(`DELETE FROM attachments WHERE id = ?1`).bind(id).run();
    await deleteObject(env, row.b2_key);
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// Authenticated browser access to a private B2 object → 302 to a presigned URL.
// Works for <img src>, <video src>, <a download> without any CORS setup.
async function handleFileGet(request, env, user, fileId) {
  const row = await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?1 AND user_id = ?2`)
    .bind(Number(fileId), user.id)
    .first();
  if (!row) throw new HttpError(404, 'File not found');
  const url = await presignS3(env, 'GET', row.b2_key, { expires: 600 });
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
}

// ------------------------------------------------------------
// Chat (SSE streaming through OpenRouter)
// ------------------------------------------------------------

async function handleChat(request, env, user, body) {
  const content = String(body.content || '').trim();
  const atts = Array.isArray(body.attachments) ? body.attachments.slice(0, 8) : [];
  if (!content && atts.length === 0) throw new HttpError(400, 'Message is empty');

  const agent = await getAgent(env, user.id, body.agentId);
  const settings = await getSettings(env);
  const model = body.model || agent?.model || settings.default_model || DEFAULT_MODEL;

  let conversationId = body.conversationId ? Number(body.conversationId) : null;
  if (conversationId) {
    await assertConversation(env, user.id, conversationId);
  } else {
    const title = (content || atts[0]?.fileName || 'New chat').slice(0, 80);
    const r = await env.DB.prepare(
      `INSERT INTO conversations (user_id, title, agent_id, model) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(user.id, title, agent?.id || null, model)
      .run();
    conversationId = r.meta.last_row_id;
  }

  const ur = await env.DB.prepare(
    `INSERT INTO messages (conversation_id, role, content, model) VALUES (?1, 'user', ?2, ?3)`
  )
    .bind(conversationId, content, model)
    .run();
  const userMsgId = ur.meta.last_row_id;

  // Resolve attachments: rows from D1 (owner-checked) + optional inline data URL
  // the client already resized (used directly for the model call).
  const resolved = [];
  for (const a of atts) {
    const id = Number(a.id || 0);
    if (!id) continue;
    const row = await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).first();
    if (!row) continue;
    row.inline = typeof a.inline === 'string' && a.inline.startsWith('data:') ? a.inline : null;
    resolved.push(row);
    await env.DB.prepare(`UPDATE attachments SET conversation_id = ?1, message_id = ?2 WHERE id = ?3`)
      .bind(conversationId, userMsgId, row.id)
      .run();
  }

  // Build the OpenRouter message list: system + recent history + current parts
  const orMessages = [{ role: 'system', content: agent?.system_prompt || DEFAULT_SYSTEM_PROMPT }];
  const hist = await env.DB.prepare(
    `SELECT id, role, content FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 40`
  )
    .bind(conversationId)
    .all();
  hist.results.reverse();
  for (const h of hist.results) {
    if (h.id === userMsgId) continue;
    orMessages.push({ role: h.role, content: h.content || '' });
  }
  const parts = [];
  if (content) parts.push({ type: 'text', text: content });
  for (const a of resolved) parts.push(await modelPartFor(env, a));
  orMessages.push({
    role: 'user',
    content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
  });

  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = async (obj) => {
    await writer.write(enc(`data: ${JSON.stringify(obj)}\n\n`));
  };

  (async () => {
    let text = '';
    try {
      await send({ type: 'begin', conversationId, model });
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: openRouterHeaders(env, request),
        body: JSON.stringify({
          model,
          messages: orMessages,
          stream: true,
          temperature: agent?.temperature != null ? agent.temperature : undefined,
        }),
      });
      if (!orRes.ok || !orRes.body) {
        const t = await orRes.text().catch(() => '');
        let msg = `OpenRouter error ${orRes.status}`;
        try {
          msg = JSON.parse(t).error?.message || msg;
        } catch {}
        await send({ type: 'error', error: msg });
        return;
      }

      const reader = orRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta;
            if (delta?.content) {
              text += delta.content;
              await send({ type: 'delta', text: delta.content });
            }
            if (j.error?.message) await send({ type: 'error', error: j.error.message });
          } catch {}
        }
      }

      // persist the assistant reply
      let assistantId = null;
      try {
        const ar = await env.DB.prepare(
          `INSERT INTO messages (conversation_id, role, content, model) VALUES (?1, 'assistant', ?2, ?3)`
        )
          .bind(conversationId, text, model)
          .run();
        assistantId = ar.meta.last_row_id;
        await env.DB.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1`)
          .bind(conversationId)
          .run();
      } catch {}
      await send({ type: 'done', conversationId, messageId: assistantId });
    } catch (err) {
      try {
        await send({ type: 'error', error: String(err?.message || err) });
      } catch {}
    } finally {
      try {
        await writer.close();
      } catch {}
    }
  })();

  return new Response(readable, { headers: sseHeaders });
}

// ------------------------------------------------------------
// Image Studio (OpenRouter dedicated Image API: generate + edit)
// ------------------------------------------------------------

async function handleImages(request, env, user, pathname, body) {
  if (request.method === 'GET' && pathname === '/api/images/models') {
    return json({ models: await listImageModels() });
  }

  if (request.method === 'POST' && pathname === '/api/images/generate') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, 'Prompt is empty');
    const settings = await getSettings(env);
    const model = body.model || settings.default_image_model || DEFAULT_IMAGE_MODEL;
    const reqBody = {
      model,
      prompt,
      n: 1,
      output_format: 'png',
    };
    if (body.aspectRatio && body.aspectRatio !== 'auto') reqBody.aspect_ratio = body.aspectRatio;
    if (body.resolution) reqBody.resolution = body.resolution;
    if (body.refDataUrl) {
      reqBody.input_references = [{ type: 'image_url', image_url: { url: body.refDataUrl } }];
    }

    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: openRouterHeaders(env, request),
      body: JSON.stringify(reqBody),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new HttpError(res.status === 402 ? 402 : 502, j.error?.message || `Image generation failed (${res.status})`);
    }
    const images = (j.data || [])
      .map((d) => (d.b64_json ? `data:${d.media_type || 'image/png'};base64,${d.b64_json}` : null))
      .filter(Boolean);
    if (!images.length) throw new HttpError(502, 'The model returned no images');
    return json({ images, usage: j.usage || null, model });
  }

  throw new HttpError(404, 'Not found');
}

// ------------------------------------------------------------
// Agents / settings / stats / models
// ------------------------------------------------------------

async function handleAgents(request, env, user, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/agents') {
    const rows = await env.DB.prepare(`SELECT * FROM agents WHERE user_id = ?1 ORDER BY is_default DESC, id`).bind(user.id).all();
    return json({ agents: rows.results });
  }

  if (method === 'POST' && pathname === '/api/agents') {
    const b = await request.json();
    if (!String(b.name || '').trim()) throw new HttpError(400, 'Name is required');
    if (!String(b.system_prompt || '').trim()) throw new HttpError(400, 'System prompt is required');
    const r = await env.DB.prepare(
      `INSERT INTO agents (user_id, name, emoji, description, system_prompt, model, temperature, is_default)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(
        user.id,
        String(b.name).slice(0, 80),
        String(b.emoji || '🤖').slice(0, 8),
        String(b.description || '').slice(0, 200),
        String(b.system_prompt),
        b.model || null,
        Math.min(Math.max(Number(b.temperature ?? 0.7), 0), 2),
        b.is_default ? 1 : 0
      )
      .run();
    return json({ id: r.meta.last_row_id });
  }

  const m = pathname.match(/^\/api\/agents\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const row = await env.DB.prepare(`SELECT id FROM agents WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).first();
    if (!row) throw new HttpError(404, 'Agent not found');

    if (method === 'PATCH') {
      const b = await request.json();
      await env.DB.prepare(
        `UPDATE agents SET name = COALESCE(?1, name), emoji = COALESCE(?2, emoji), description = COALESCE(?3, description),
                system_prompt = COALESCE(?4, system_prompt), model = ?5, temperature = COALESCE(?6, temperature),
                is_default = COALESCE(?7, is_default)
          WHERE id = ?8`
      )
        .bind(
          b.name != null ? String(b.name).slice(0, 80) : null,
          b.emoji != null ? String(b.emoji).slice(0, 8) : null,
          b.description != null ? String(b.description).slice(0, 200) : null,
          b.system_prompt != null ? String(b.system_prompt) : null,
          b.model !== undefined ? b.model || null : null,
          b.temperature != null ? Math.min(Math.max(Number(b.temperature), 0), 2) : null,
          b.is_default != null ? (b.is_default ? 1 : 0) : null,
          id
        )
        .run();
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      await env.DB.prepare(`DELETE FROM agents WHERE id = ?1`).bind(id).run();
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

async function handleSettings(request, env, user, pathname) {
  if (request.method === 'GET' && pathname === '/api/settings') {
    return json({ settings: await getSettings(env) });
  }
  if (request.method === 'PUT' && pathname === '/api/settings') {
    const b = await request.json();
    for (const key of ['default_model', 'default_image_model']) {
      if (typeof b[key] === 'string' && b[key].trim()) {
        await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)`)
          .bind(key, b[key].trim())
          .run();
      }
    }
    return json({ settings: await getSettings(env) });
  }
  throw new HttpError(404, 'Not found');
}

async function handleStats(env, user) {
  const files = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM attachments WHERE user_id = ?1`)
    .bind(user.id)
    .first();
  const convs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?1`).bind(user.id).first();
  const msgs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?1)`
  )
    .bind(user.id)
    .first();
  return json({
    stats: { files: files.n, bytes: files.bytes, conversations: convs.n, messages: msgs.n },
  });
}

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------

async function handleApi(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // Public: auth + bootstrap info
  if (pathname.startsWith('/api/auth/')) return handleAuth(request, env, pathname);

  // Everything below requires the owner's session
  if (pathname === '/api/models' && method === 'GET') {
    return json({ models: await listChatModels() });
  }
  if (pathname === '/api/images/models' && method === 'GET') {
    return json({ models: await listImageModels() });
  }

  const user = await requireUser(env, request);

  if (pathname.startsWith('/api/conversations')) return handleConversations(request, env, user, pathname);
  if (pathname.startsWith('/api/upload') || pathname.startsWith('/api/attachments')) {
    return handleUpload(request, env, user, pathname);
  }
  if (pathname.startsWith('/api/files/')) {
    return handleFileGet(request, env, user, pathname.split('/')[3]);
  }
  if (pathname === '/api/chat' && method === 'POST') {
    return handleChat(request, env, user, await request.json());
  }
  if (pathname.startsWith('/api/images/') && (method === 'POST' || method === 'GET')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    return handleImages(request, env, user, pathname, body);
  }
  if (pathname.startsWith('/api/agents')) return handleAgents(request, env, user, pathname);
  if (pathname.startsWith('/api/settings')) return handleSettings(request, env, user, pathname);
  if (pathname === '/api/stats' && method === 'GET') return handleStats(env, user);

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }
      return await handleApi(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || 'Server error' }, status);
    }
  },
};
