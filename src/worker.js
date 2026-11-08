// ============================================================
// Rahat AI Workstation v2 — Cloudflare Worker
// Private, single-owner AI workstation with an autonomous agent:
//   - Agent loop with tools: web search, web fetch, JS sandbox,
//     image generation, artifacts, memory, custom API connections
//   - Auto model routing: 'openrouter/auto' picks the best model
//     per task; provider fallbacks dodge rate limits
//   - OpenRouter: streaming chat + dedicated Image API
//   - Cloudflare D1: users, sessions, chats, agents, artifacts,
//     memories, connections, settings
//   - Backblaze B2 (S3 API, presigned URLs): private file storage
// Frontend is served from /public via the ASSETS binding.
// ============================================================

const SESSION_COOKIE = 'rahat_session';
const SESSION_DAYS = 30;
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';

// Auto mode: the UI never asks Rahat to pick a model. Chat requests route to
// 'openrouter/auto' (OpenRouter inspects the whole conversation and picks the
// best available model, spreading load across providers — so one model's rate
// limit never blocks the workstation). When files are attached we pin a known
// multimodal model instead, because the auto router may pick a text-only one.
// FALLBACK_MODELS ride along on every call: if the primary is down or
// rate-limited, OpenRouter transparently retries the next one.
const AUTO_ROUTE_MODEL = 'openrouter/auto';
const FALLBACK_MODELS = ['google/gemini-2.5-flash', 'openai/gpt-5-mini', 'deepseek/deepseek-chat-v3.1'];

function routeModel(hasFiles = false) {
  return hasFiles ? DEFAULT_MODEL : AUTO_ROUTE_MODEL;
}
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // images ≤ 10 MB (as requested)
const MAX_OTHER_BYTES = 30 * 1024 * 1024;  // pdf/audio/video ≤ 30 MB
const MODEL_INLINE_CAP = 8 * 1024 * 1024;  // max bytes we inline from B2 into a model call
const MAX_AGENT_STEPS = 6;                 // tool-loop rounds per message
const RESEARCH_MAX_STEPS = 12;             // tool-loop rounds in Deep Research mode

// Deep Research mode (Claude "Research" / Z.ai "Deep Think" equivalent):
// more tool rounds + instructions to compare multiple sources and cite them.
const RESEARCH_PROMPT =
  'You are in DEEP RESEARCH mode. Use web_search and web_fetch extensively: cover at least 3-5 independent ' +
  'sources before answering, cross-check conflicting claims, note where sources disagree or are unreliable, ' +
  'and finish with a structured answer that cites every key claim inline as markdown links to the source URLs. ' +
  'If the answer needs exact math, verify it with run_js. Keep going until you have genuinely covered the question.';

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
    { name: 'PBKDF2', salt: enc(salt), iterations: 100000, hash: 'SHA-256' },
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
  const missing = ['B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET_NAME'].filter((k) => !env[k]);
  if (missing.length) {
    throw new HttpError(
      500,
      `File storage is not configured — missing ${missing.join(', ')}. ` +
      'Fix: Cloudflare dashboard → Workers & Pages → this Worker → Settings → Variables and Secrets → add the missing variables, then redeploy.'
    );
  }
  if (b2s3Cache && Date.now() < b2s3Cache.expiresAt) return b2s3Cache;
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`) },
  });
  if (!res.ok) {
    const t = await res.text();
    const hint = res.status === 401
      ? ' — B2 rejected the key pair. B2_KEY_ID must be the keyID of the SAME Application Key whose applicationKey is in B2_APP_KEY (no spaces or quotes around the values). Keys are shown only once when created — if unsure, create a new Application Key in Backblaze → Application Keys and update both variables.'
      : '';
    throw new HttpError(500, `B2 authorize failed (${res.status})${hint}: ${t.slice(0, 200)}`);
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
// v2 schema (created lazily so existing v1 installs upgrade in place)
// ------------------------------------------------------------

let v2SchemaReady = false;

async function ensureV2Schema(env) {
  if (v2SchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS artifacts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         conversation_id INTEGER,
         title TEXT NOT NULL,
         type TEXT NOT NULL CHECK (type IN ('html','markdown','code','text','image','video-program')),
         content TEXT,
         b2_key TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')))`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, id DESC)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS memories (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         content TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now')))`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id DESC)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS connections (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         base_url TEXT NOT NULL,
         auth_header TEXT NOT NULL DEFAULT '',
         notes TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT (datetime('now')))`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id, id DESC)`),
  ]);
  try {
    await env.DB.prepare(`ALTER TABLE messages ADD COLUMN tool_log TEXT`).run();
  } catch {
    // column already exists — fine
  }
  // v2.1: widen the artifact type CHECK to include 'video-program'.
  // SQLite cannot ALTER a CHECK, so rebuild the table in one atomic batch.
  const artTable = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`).first();
  if (artTable?.sql && !artTable.sql.includes("'video-program'")) {
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE artifacts_new (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           conversation_id INTEGER,
           title TEXT NOT NULL,
           type TEXT NOT NULL CHECK (type IN ('html','markdown','code','text','image','video-program')),
           content TEXT,
           b2_key TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now')))`
      ),
      env.DB.prepare(
        `INSERT INTO artifacts_new (id, user_id, conversation_id, title, type, content, b2_key, created_at)
         SELECT id, user_id, conversation_id, title, type, content, b2_key, created_at FROM artifacts`
      ),
      env.DB.prepare(`DROP TABLE artifacts`),
      env.DB.prepare(`ALTER TABLE artifacts_new RENAME TO artifacts`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, id DESC)`),
    ]);
  }
  v2SchemaReady = true;
}

// ------------------------------------------------------------
// Agent tool belt
// ------------------------------------------------------------

const TOOL_GUIDANCE = `You are an autonomous agent with real tools. Use them whenever they make the answer better:
- web_search: fresh facts, news, prices, anything you are not sure about. Never guess current information.
- web_fetch: read a specific page found via search or given by Rahat before commenting on it.
- run_js: exact math, data crunching, parsing, quick logic checks. Sync JS only (no fetch/async).
- image_generate: create or edit images when asked.
- make_video_program: motion graphics & 2D animations — write a JSON animation program Rahat renders into a real video file in the Video Studio (intros, lower thirds, logo reveals, promos, countdowns, animated explainers).
- Python: the server cannot execute Python. When Rahat asks for Python, deliver complete runnable code (use print() for output) as a code artifact and tell him to paste it into the Python Lab view — it runs real Python (Pyodide) in his browser.
- make_artifact: deliver long-form work — full runnable websites (single self-contained HTML), reports, essays, substantial code. Long output belongs in an artifact, not the chat.
- save_memory: permanently remember durable facts about Rahat (preferences, projects, decisions). Do not save trivial chat.
- list_connections / api_request: call external services Rahat connected (Netlify, Vercel, any REST API). Use api_request to act on his behalf.
Rahat sees which tools you used — keep tool calls purposeful. After tools finish, give the final answer yourself.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web and return a concise answer with sources. Use for anything current or uncertain.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text content.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full http(s) URL' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'Evaluate synchronous JavaScript (expressions/statements) and return the result plus console output. No async, no network.',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript source to run' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description: 'Generate or edit an image from a text prompt. The image is shown to Rahat and saved as an artifact.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image description (or edit instruction)' },
          aspect_ratio: { type: 'string', description: 'Optional: 1:1, 16:9, 9:16, 4:3, 3:4' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_artifact',
      description: 'Save a viewable, downloadable artifact: full HTML websites, markdown reports, code files or plain text. Use for anything long or runnable.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human title' },
          type: { type: 'string', enum: ['html', 'markdown', 'code', 'text'], description: 'Artifact kind' },
          content: { type: 'string', description: 'Full content (complete HTML document for websites)' },
        },
        required: ['title', 'type', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_video_program',
      description: 'Create a motion-graphics / 2D-animation "video program" (JSON) that Rahat renders to a real video file in the Video Studio. Use for intros, lower thirds, logo reveals, promos, countdowns and animated explainers.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human title' },
          program: {
            type: 'string',
            description:
              'JSON string: {"width":1280,"height":720,"fps":30,"duration":5,"background":"#0b0f1a" or {"type":"linear","from":"#101627","to":"#7c5cff"},"scenes":[{"start":0,"end":3,"elements":[...]}]}. Element: {"type":"text|rect|circle|ring","x":640,"y":360,"text":"..","size":120,"w":..,"h":..,"r":..,"color":"#fff","align":"center","radius":12,"opacity":1,"scale":1,"rotate":0,"anim":[{"prop":"x|y|scale|opacity|rotate|w","from":0,"to":1,"start":0,"end":0.9,"easing":"linear|in|out|inout"}]}. x/y are CENTER coordinates in canvas pixels. Chain several anims on one prop for in→hold→out. Keep duration ≤ 30s.',
          },
        },
        required: ['title', 'program'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Permanently remember a durable fact about Rahat (preferences, ongoing projects, decisions).',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'One concise fact' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_connections',
      description: 'List the external services Rahat connected (name, base URL, notes).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'api_request',
      description: 'Call a REST API on one of Rahat’s saved connections (e.g. deploy a site to Netlify/Vercel, create a doc). The connection’s auth header is applied automatically.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'Connection name' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
          path: { type: 'string', description: 'API path, e.g. /api/v1/sites' },
          body: { type: 'object', description: 'Optional JSON request body' },
        },
        required: ['connection', 'method', 'path'],
      },
    },
  },
];

function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…[truncated]' : str;
}

function toolSummary(name, args) {
  try {
    switch (name) {
      case 'web_search': return clip(args.query, 80);
      case 'web_fetch': return clip(args.url, 80);
      case 'run_js': return clip(String(args.code || '').split('\n')[0], 80);
      case 'image_generate': return clip(args.prompt, 80);
      case 'make_video_program': return clip(args.title, 80);
      case 'make_artifact': return `${args.type}: ${clip(args.title, 70)}`;
      case 'save_memory': return clip(args.text, 80);
      case 'api_request': return `${args.method} ${args.connection}${args.path || ''}`;
      case 'list_connections': return 'saved services';
      default: return '';
    }
  } catch { return ''; }
}

// --- individual tools ---

async function toolWebSearch(env, request, query) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(env, request),
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: `Search the web and answer concisely. Include the source URLs.\n\n${query}` }],
      plugins: [{ id: 'web', max_results: 8 }],
      max_tokens: 1500,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Web search failed: ${j.error?.message || res.status}`);
  return clip(j.choices?.[0]?.message?.content || 'No results', 6000);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function toolWebFetch(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, 'Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Only http(s) URLs');
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RahatAI/2.0; +personal workstation)' },
    signal: AbortSignal.timeout(25000),
  });
  const type = res.headers.get('Content-Type') || '';
  const raw = await res.text();
  const text = type.includes('html') || raw.trimStart().startsWith('<') ? htmlToText(raw) : raw;
  return `HTTP ${res.status} ${type}\n\n${clip(text, 12000)}`;
}

async function toolRunJs(code) {
  if (String(code).length > 8000) throw new HttpError(400, 'Code too long (max 8000 chars)');
  const logs = [];
  const fmt = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  const sandboxConsole = {
    log: (...a) => logs.push(a.map(fmt).join(' ')),
    warn: (...a) => logs.push('⚠ ' + a.map(fmt).join(' ')),
    error: (...a) => logs.push('✖ ' + a.map(fmt).join(' ')),
  };
  let result;
  try {
    const fn = new Function('console', '"use strict"; return (function(){\n' + code + '\n})()');
    result = fn(sandboxConsole);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e), logs: logs.slice(0, 30) });
  }
  let out;
  try { out = result === undefined ? 'undefined' : JSON.stringify(result); } catch { out = String(result); }
  return JSON.stringify({ ok: true, result: clip(out, 4000), logs: logs.slice(0, 30) });
}

function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || 'image/png' };
}

async function toolImageGenerate(env, request, user, conversationId, args, emit) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new HttpError(400, 'image_generate: prompt is required');
  const reqBody = { model: DEFAULT_IMAGE_MODEL, prompt, n: 1, output_format: 'png' };
  if (args.aspect_ratio && args.aspect_ratio !== 'auto') reqBody.aspect_ratio = args.aspect_ratio;
  const res = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: openRouterHeaders(env, request),
    body: JSON.stringify(reqBody),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 402 ? 402 : 502, `Image generation failed: ${j.error?.message || res.status}`);
  const dataUrl = (j.data || []).map((d) => (d.b64_json ? `data:${d.media_type || 'image/png'};base64,${d.b64_json}` : null)).filter(Boolean)[0];
  if (!dataUrl) throw new HttpError(502, 'The image model returned nothing');

  emit({ type: 'image', dataUrl });

  // Persist: B2 if available, else inline in D1 when small enough, else live-only.
  const title = clip(prompt, 80);
  let content = null, b2Key = null;
  try {
    const { bytes, mime } = dataUrlBytes(dataUrl);
    const key = `artifacts/${user.id}/${Date.now().toString(36)}-${randHex(4)}.png`;
    const putUrl = await presignS3(env, 'PUT', key, { expires: 600, contentType: mime });
    const put = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
    if (put.ok) b2Key = key;
  } catch {}
  if (!b2Key && dataUrl.length < 1_400_000) content = dataUrl;
  const r = await env.DB.prepare(
    `INSERT INTO artifacts (user_id, conversation_id, title, type, content, b2_key) VALUES (?1, ?2, ?3, 'image', ?4, ?5)`
  ).bind(user.id, conversationId, title, content, b2Key).run();
  const id = r.meta.last_row_id;
  emit({ type: 'artifact', artifact: { id, title, type: 'image' } });
  return b2Key || content
    ? `Image generated and saved as artifact #${id} ("${title}"). Rahat can view it in the chat and in the Artifacts gallery.`
    : `Image generated and shown in chat (not persisted — storage unavailable).`;
}

async function toolMakeArtifact(env, user, conversationId, args, emit) {
  const title = String(args.title || 'Untitled').slice(0, 120);
  const type = ['html', 'markdown', 'code', 'text'].includes(args.type) ? args.type : 'text';
  const content = clip(String(args.content ?? ''), 300_000);
  if (!content.trim()) throw new HttpError(400, 'make_artifact: content is empty');
  const r = await env.DB.prepare(
    `INSERT INTO artifacts (user_id, conversation_id, title, type, content) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(user.id, conversationId, title, type, content).run();
  const id = r.meta.last_row_id;
  emit({ type: 'artifact', artifact: { id, title, type } });
  return `Artifact #${id} "${title}" (${type}) saved. It is viewable and downloadable by Rahat.`;
}

async function toolMakeVideoProgram(env, user, conversationId, args, emit) {
  let prog;
  try { prog = JSON.parse(String(args.program || '')); } catch { throw new HttpError(400, 'make_video_program: program is not valid JSON'); }
  if (!prog || !Array.isArray(prog.scenes) || !prog.scenes.length) {
    throw new HttpError(400, 'make_video_program: program needs a non-empty scenes[] array');
  }
  prog.width = Number(prog.width) || 1280;
  prog.height = Number(prog.height) || 720;
  prog.fps = Number(prog.fps) || 30;
  prog.duration = Number(prog.duration) || 5;
  const title = String(args.title || 'Video program').slice(0, 120);
  const content = JSON.stringify(prog);
  if (content.length > 200_000) throw new HttpError(400, 'Video program too large (max 200 KB)');
  const r = await env.DB.prepare(
    `INSERT INTO artifacts (user_id, conversation_id, title, type, content) VALUES (?1, ?2, ?3, 'video-program', ?4)`
  ).bind(user.id, conversationId, title, content).run();
  const id = r.meta.last_row_id;
  emit({ type: 'artifact', artifact: { id, title, type: 'video-program' } });
  return `Video program #${id} "${title}" saved (${prog.width}x${prog.height}, ${prog.duration}s, ${prog.scenes.length} scenes). Tell Rahat to open it in the Video Studio (Artifact → Open → 🎬 Open in Video Studio → ⏺ Render) to produce the actual video file.`;
}

async function toolSaveMemory(env, user, args) {
  const text = String(args.text || '').trim().slice(0, 500);
  if (!text) throw new HttpError(400, 'save_memory: text is required');
  await env.DB.prepare(`INSERT INTO memories (user_id, content) VALUES (?1, ?2)`).bind(user.id, text).run();
  return 'Memory saved permanently.';
}

async function toolListConnections(env, user) {
  const rows = await env.DB.prepare(`SELECT name, base_url, notes FROM connections WHERE user_id = ?1 ORDER BY name`).bind(user.id).all();
  if (!rows.results.length) return 'No connections saved yet. Rahat can add services (Netlify, Vercel, any REST API) in Connections.';
  return JSON.stringify(rows.results.map((r) => ({ name: r.name, baseUrl: r.base_url, notes: r.notes })));
}

async function toolApiRequest(env, user, args) {
  const name = String(args.connection || '').trim();
  const conn = await env.DB.prepare(`SELECT * FROM connections WHERE user_id = ?1 AND LOWER(name) = LOWER(?2)`)
    .bind(user.id, name).first();
  if (!conn) throw new HttpError(404, `Connection "${name}" not found — use list_connections first`);
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method) ? args.method : 'GET';
  const path = String(args.path || '/').replace(/^\//, '');
  const url = `${conn.base_url.replace(/\/$/, '')}/${path}`;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'RahatAI/2.0' };
  if (conn.auth_header) headers['Authorization'] = conn.auth_header;
  const res = await fetch(url, {
    method,
    headers,
    body: args.body != null ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  return clip(`HTTP ${res.status}\n${text}`, 8000);
}

async function executeTool(env, request, user, conversationId, name, rawArgs, emit) {
  let args = {};
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {}); } catch { args = {}; }
  switch (name) {
    case 'web_search': return toolWebSearch(env, request, String(args.query || ''));
    case 'web_fetch': return toolWebFetch(String(args.url || ''));
    case 'run_js': return toolRunJs(String(args.code || ''));
    case 'image_generate': return toolImageGenerate(env, request, user, conversationId, args, emit);
    case 'make_video_program': return toolMakeVideoProgram(env, user, conversationId, args, emit);
    case 'make_artifact': return toolMakeArtifact(env, user, conversationId, args, emit);
    case 'save_memory': return toolSaveMemory(env, user, args);
    case 'list_connections': return toolListConnections(env, user);
    case 'api_request': return toolApiRequest(env, user, args);
    default: return `Unknown tool: ${name}`;
  }
}

const TOOL_ICON = {
  web_search: '🔍', web_fetch: '🌐', run_js: '⚙️', image_generate: '🎨',
  make_video_program: '🎬', make_artifact: '🧩', save_memory: '🧠', list_connections: '📋', api_request: '🔌',
};

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
        `SELECT id, role, content, model, tool_log, created_at FROM messages WHERE conversation_id = ?1 ORDER BY id`
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
// Chat — autonomous agent loop (SSE streaming through OpenRouter)
// ------------------------------------------------------------

async function handleChat(request, env, user, body) {
  const content = String(body.content || '').trim();
  const atts = Array.isArray(body.attachments) ? body.attachments.slice(0, 8) : [];
  const research = body.research === true;
  if (!content && atts.length === 0) throw new HttpError(400, 'Message is empty');

  const agent = await getAgent(env, user.id, body.agentId);
  const model = routeModel(atts.length > 0);

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

  // System prompt: persona + date + permanent memory + tool guidance
  const memRows = await env.DB.prepare(`SELECT content FROM memories WHERE user_id = ?1 ORDER BY id DESC LIMIT 30`)
    .bind(user.id)
    .all();
  const memBlock = memRows.results.length
    ? 'Permanent memory about Rahat (from previous sessions):\n' +
      memRows.results.map((m) => `- ${m.content}`).join('\n')
    : '';
  const sys = [
    agent?.system_prompt || DEFAULT_SYSTEM_PROMPT,
    `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    memBlock,
    research ? RESEARCH_PROMPT : '',
    TOOL_GUIDANCE,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Build the OpenRouter message list: system + recent history + current parts
  const orMessages = [{ role: 'system', content: sys }];
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
    let fullText = '';
    const toolLog = [];
    try {
      await send({ type: 'begin', conversationId, model });

      let toolsOn = true;
      let final = false;
      for (let step = 0; step < (research ? RESEARCH_MAX_STEPS : MAX_AGENT_STEPS) && !final; step++) {
        const orBody = {
          model,
          models: FALLBACK_MODELS,
          messages: orMessages,
          stream: true,
          temperature: agent?.temperature != null ? agent.temperature : undefined,
        };
        if (toolsOn) {
          orBody.tools = TOOLS;
          orBody.tool_choice = 'auto';
        }

        const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: openRouterHeaders(env, request),
          body: JSON.stringify(orBody),
        });
        if (!orRes.ok || !orRes.body) {
          const t = await orRes.text().catch(() => '');
          let msg = `OpenRouter error ${orRes.status}`;
          try { msg = JSON.parse(t).error?.message || msg; } catch {}
          // A routed model may reject tool schemas — retry this step as plain chat once.
          if (toolsOn && (orRes.status === 400 || orRes.status === 404 || orRes.status === 502)) {
            toolsOn = false;
            continue;
          }
          await send({ type: 'error', error: msg });
          return;
        }

        // Stream parse: content deltas, tool-call deltas, finish reason
        let stepText = '';
        const calls = new Map();
        let finish = '';
        const reader = orRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.error?.message) {
                await send({ type: 'error', error: j.error.message });
                return;
              }
              const ch = j.choices?.[0];
              const delta = ch?.delta;
              if (delta?.content) {
                stepText += delta.content;
                fullText += delta.content;
                await send({ type: 'delta', text: delta.content });
              }
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const cur = calls.get(idx) || { id: '', name: '', args: '' };
                  if (tc.id) cur.id = tc.id;
                  if (tc.function?.name) cur.name += tc.function.name;
                  if (tc.function?.arguments) cur.args += tc.function.arguments;
                  calls.set(idx, cur);
                }
              }
              if (ch?.finish_reason) finish = ch.finish_reason;
            } catch {}
          }
        }

        const toolCalls = [...calls.values()].filter((c) => c.name);
        for (const c of toolCalls) if (!c.id) c.id = 'call_' + randHex(6);

        if (finish === 'tool_calls' && toolCalls.length && toolsOn) {
          orMessages.push({
            role: 'assistant',
            content: stepText || null,
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args || '{}' },
            })),
          });
          for (const c of toolCalls) {
            let args = {};
            try { args = JSON.parse(c.args || '{}'); } catch {}
            const summary = toolSummary(c.name, args);
            const icon = TOOL_ICON[c.name] || '🔧';
            await send({ type: 'tool', phase: 'start', name: c.name, icon, summary });
            let resultText;
            let ok = true;
            try {
              resultText = await executeTool(env, request, user, conversationId, c.name, c.args, (ev) => send(ev));
            } catch (err) {
              resultText = `Tool error: ${err?.message || err}`;
              ok = false;
            }
            await send({ type: 'tool', phase: 'end', name: c.name, icon, summary, ok });
            toolLog.push({ name: c.name, summary, ok });
            orMessages.push({ role: 'tool', tool_call_id: c.id, content: clip(resultText, 8000) });
          }
          continue; // feed results back and let the model continue
        }
        final = true;
      }

      // persist the assistant reply (+ what it did, so history shows the timeline)
      let assistantId = null;
      try {
        const ar = await env.DB.prepare(
          `INSERT INTO messages (conversation_id, role, content, model, tool_log) VALUES (?1, 'assistant', ?2, ?3, ?4)`
        )
          .bind(conversationId, fullText, model, toolLog.length ? JSON.stringify(toolLog) : null)
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
  if (request.method === 'POST' && pathname === '/api/images/generate') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, 'Prompt is empty');
    const model = DEFAULT_IMAGE_MODEL;
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
// Artifacts / connections / memories (v2)
// ------------------------------------------------------------

async function handleArtifacts(request, env, user, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/artifacts') {
    const rows = await env.DB.prepare(
      `SELECT id, conversation_id, title, type, b2_key, created_at FROM artifacts WHERE user_id = ?1 ORDER BY id DESC LIMIT 200`
    )
      .bind(user.id)
      .all();
    const out = [];
    for (const r of rows.results) {
      let url = null;
      if (r.type === 'image' && r.b2_key) {
        try { url = await presignS3(env, 'GET', r.b2_key, { expires: 3600 }); } catch { url = null; }
      }
      out.push({ id: r.id, conversationId: r.conversation_id, title: r.title, type: r.type, createdAt: r.created_at, url });
    }
    return json({ artifacts: out });
  }

  const m = pathname.match(/^\/api\/artifacts\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const row = await env.DB.prepare(`SELECT * FROM artifacts WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).first();
    if (!row) throw new HttpError(404, 'Artifact not found');

    if (method === 'GET') {
      let url = null;
      if (row.type === 'image' && row.b2_key) {
        try { url = await presignS3(env, 'GET', row.b2_key, { expires: 3600 }); } catch {}
      }
      if (url) return json({ artifact: { id: row.id, title: row.title, type: row.type, url, content: null, createdAt: row.created_at } });
      return json({ artifact: { id: row.id, title: row.title, type: row.type, content: row.content, createdAt: row.created_at } });
    }

    if (method === 'DELETE') {
      if (row.b2_key) await deleteObject(env, row.b2_key);
      await env.DB.prepare(`DELETE FROM artifacts WHERE id = ?1`).bind(id).run();
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

async function handleConnections(request, env, user, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/connections') {
    const rows = await env.DB.prepare(
      `SELECT id, name, base_url, notes, created_at FROM connections WHERE user_id = ?1 ORDER BY name`
    )
      .bind(user.id)
      .all();
    return json({ connections: rows.results });
  }

  if (method === 'POST' && pathname === '/api/connections') {
    const b = await request.json();
    const name = String(b.name || '').trim().slice(0, 60);
    const baseUrl = String(b.baseUrl || '').trim().slice(0, 300);
    if (!name) throw new HttpError(400, 'Name is required');
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'Base URL must start with http(s)://');
    const r = await env.DB.prepare(
      `INSERT INTO connections (user_id, name, base_url, auth_header, notes) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(user.id, name, baseUrl, String(b.authHeader || '').slice(0, 500), String(b.notes || '').slice(0, 300))
      .run();
    return json({ id: r.meta.last_row_id });
  }

  const m = pathname.match(/^\/api\/connections\/(\d+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    const row = await env.DB.prepare(`SELECT id FROM connections WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).first();
    if (!row) throw new HttpError(404, 'Connection not found');
    await env.DB.prepare(`DELETE FROM connections WHERE id = ?1`).bind(id).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

async function handleMemories(request, env, user, pathname) {
  const method = request.method;

  if (method === 'GET' && pathname === '/api/memories') {
    const rows = await env.DB.prepare(`SELECT id, content, created_at FROM memories WHERE user_id = ?1 ORDER BY id DESC LIMIT 200`)
      .bind(user.id)
      .all();
    return json({ memories: rows.results });
  }

  if (method === 'POST' && pathname === '/api/memories') {
    const b = await request.json();
    const text = String(b.content || '').trim().slice(0, 500);
    if (!text) throw new HttpError(400, 'Memory text is empty');
    const r = await env.DB.prepare(`INSERT INTO memories (user_id, content) VALUES (?1, ?2)`).bind(user.id, text).run();
    return json({ id: r.meta.last_row_id });
  }

  const m = pathname.match(/^\/api\/memories\/(\d+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    await env.DB.prepare(`DELETE FROM memories WHERE id = ?1 AND user_id = ?2`).bind(id, user.id).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
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
  const user = await requireUser(env, request);
  await ensureV2Schema(env);

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
  if (pathname.startsWith('/api/artifacts')) return handleArtifacts(request, env, user, pathname);
  if (pathname.startsWith('/api/connections')) return handleConnections(request, env, user, pathname);
  if (pathname.startsWith('/api/memories')) return handleMemories(request, env, user, pathname);
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
