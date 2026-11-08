// ============================================================
// Rahat AI Workstation — frontend (vanilla JS, no build step)
// ============================================================

const state = {
  user: null,
  agents: [],
  conversations: [],
  currentConvId: null,
  attachments: [],     // pending uploads for the next message
  refDataUrl: null,    // image-studio reference image
  settings: {},
  chatModels: [],
  imageModels: [],
  sending: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_OTHER = 30 * 1024 * 1024;

// ---------------- utilities ----------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function timeAgo(sqliteUtc) {
  if (!sqliteUtc) return '';
  const then = new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(1, (Date.now() - then) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showAuth(); throw new Error('Please log in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- markdown (minimal, safe) ----------------

function inlineMd(t) {
  return t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMarkdown(src) {
  const out = [];
  let para = [], list = null, code = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<ul>' + list.map((l) => `<li>${inlineMd(l)}</li>`).join('') + '</ul>'); list = null; } };
  const flushCode = () => { if (code) { out.push('<pre><code>' + code.join('\n') + '</code></pre>'); code = null; } };

  for (const raw of src.split('\n')) {
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) { flushCode(); flushPara(); flushList(); code = code ? null : []; continue; }
    if (code) { code.push(escapeHtml(raw)); continue; }

    const img = raw.match(/^\s*!\[([^\]]*)\]\((data:image\/[^)\s]+|https?:\/\/[^)\s]+)\)\s*$/);
    if (img) { flushPara(); flushList(); out.push(`<img src="${img[2]}" alt="${escapeHtml(img[1])}" />`); continue; }

    const li = raw.match(/^\s*(?:[-*•]|\d+[.)]) (.*)$/);
    if (li) { flushPara(); (list ||= []).push(escapeHtml(li[1])); continue; }

    const h = raw.match(/^(#{1,3}) (.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h3>${inlineMd(escapeHtml(h[2]))}</h3>`); continue; }

    const q = raw.match(/^&gt; ?(.*)$|^> ?(.*)$/);
    if (q) { flushPara(); flushList(); out.push(`<blockquote>${inlineMd(escapeHtml(q[1] || q[2]))}</blockquote>`); continue; }

    if (!raw.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(escapeHtml(raw));
  }
  flushCode(); flushPara(); flushList();
  return out.join('');
}

// ---------------- auth flow ----------------

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showAuth() {
  hide($('#app-view'));
  show($('#auth-view'));
  fetch('/api/auth/me').then((r) => r.json()).then((me) => {
    if (me.needsSetup) { show($('#setup-form')); hide($('#login-form')); if (me.requireSetupCode) show($('#su-code-row')); }
    else { show($('#login-form')); hide($('#setup-form')); }
  }).catch(() => show($('#login-form')));
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#su-error').textContent = '';
  try {
    const r = await api('/api/auth/setup', {
      body: {
        name: $('#su-name').value.trim() || 'Rahat',
        email: $('#su-email').value.trim(),
        password: $('#su-pass').value,
        setupCode: $('#su-code').value,
      },
    });
    await enterApp(r.user);
  } catch (err) { $('#su-error').textContent = err.message; }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#li-error').textContent = '';
  try {
    const r = await api('/api/auth/login', { body: { email: $('#li-email').value.trim(), password: $('#li-pass').value } });
    await enterApp(r.user);
  } catch (err) { $('#li-error').textContent = err.message; }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  location.reload();
});

async function enterApp(user) {
  state.user = user;
  hide($('#auth-view'));
  show($('#app-view'));
  $('#whoami-name').textContent = user.name || user.email;
  $('.avatar').textContent = (user.name || 'R').charAt(0).toUpperCase();
  await Promise.all([loadChatModels(), loadImageModels(), loadAgents(), loadSettings()]);
  applyDefaultsToSelects();
  await loadConversations();
  showView('chat');
}

// ---------------- views / navigation ----------------

function showView(name) {
  $$('.view').forEach((v) => hide(v));
  show($(`#view-${name}`));
  $$('.side-link').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  closeSidebar();
  if (name === 'agents') renderAgentCards();
  if (name === 'settings') refreshStats();
}

$$('.side-link').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

$('#btn-menu').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
$('#scrim').addEventListener('click', closeSidebar);
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

// ---------------- models & agents selects ----------------

async function loadChatModels() {
  try {
    const r = await api('/api/models');
    state.chatModels = r.models || [];
  } catch { state.chatModels = []; }
}

async function loadImageModels() {
  try {
    const r = await api('/api/images/models');
    state.imageModels = r.models || [];
  } catch { state.imageModels = []; }
  const sel = $('#img-model');
  sel.innerHTML = '';
  for (const m of state.imageModels.slice(0, 40)) {
    sel.add(new Option(m.name || m.id, m.id));
  }
  sel.value = state.settings.default_image_model || sel.options[0]?.value || '';
}

const FALLBACK_CHAT_MODELS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5-mini',
  'openai/gpt-5',
  'x-ai/grok-4-fast',
  'x-ai/grok-4',
  'deepseek/deepseek-chat-v3.1',
  'meta-llama/llama-3.3-70b-instruct',
];

function fillModelSelect(sel, extraIds = []) {
  sel.innerHTML = '';
  const ids = new Set(extraIds.filter(Boolean));
  for (const id of FALLBACK_CHAT_MODELS) if (state.chatModels.some((m) => m.id === id)) ids.add(id);
  const preferred = [...ids];
  for (const m of state.chatModels) if (preferred.length < 120) preferred.push(m.id);
  if (!preferred.length) preferred.push(...FALLBACK_CHAT_MODELS);
  for (const id of preferred.slice(0, 120)) sel.add(new Option(id, id));
}

async function loadAgents() {
  try {
    const r = await api('/api/agents');
    state.agents = r.agents || [];
  } catch { state.agents = []; }
  const sel = $('#agent-select');
  sel.innerHTML = '';
  const sorted = [...state.agents].sort((a, b) => b.is_default - a.is_default || a.id - b.id);
  for (const a of sorted) sel.add(new Option(`${a.emoji} ${a.name}`, a.id));
  const def = sorted.find((a) => a.is_default);
  if (def) sel.value = def.id;
}

function agentById(id) { return state.agents.find((a) => a.id === Number(id)); }

// ---------------- settings ----------------

async function loadSettings() {
  try { state.settings = (await api('/api/settings')).settings || {}; } catch { state.settings = {}; }
}

function applyDefaultsToSelects() {
  fillModelSelect($('#model-select'), [state.settings.default_model]);
  $('#model-select').value = state.settings.default_model || $('#model-select').options[0]?.value || '';
  fillModelSelect($('#set-model'), [state.settings.default_model]);
  $('#set-model').value = state.settings.default_model || '';
  const imgSel = $('#set-img-model');
  imgSel.innerHTML = '';
  for (const m of state.imageModels.slice(0, 40)) imgSel.add(new Option(m.name || m.id, m.id));
  imgSel.value = state.settings.default_image_model || imgSel.options[0]?.value || '';
}

$('#btn-save-settings').addEventListener('click', async () => {
  $('#settings-msg').textContent = '';
  try {
    const r = await api('/api/settings', { method: 'PUT', body: { default_model: $('#set-model').value, default_image_model: $('#set-img-model').value } });
    state.settings = r.settings;
    applyDefaultsToSelects();
    $('#settings-msg').textContent = 'Saved ✓';
  } catch (err) { $('#settings-msg').textContent = err.message; }
});

async function refreshStats() {
  try {
    const { stats } = await api('/api/stats');
    $('#stats-grid').innerHTML = [
      ['Files', stats.files],
      ['Storage', fmtBytes(stats.bytes)],
      ['Chats', stats.conversations],
      ['Messages', stats.messages],
    ].map(([k, v]) => `<div class="stat"><div class="v">${escapeHtml(String(v))}</div><div class="k">${k}</div></div>`).join('');
  } catch {}
}

// ---------------- conversations ----------------

async function loadConversations() {
  try {
    const r = await api('/api/conversations');
    state.conversations = r.conversations || [];
  } catch { state.conversations = []; }
  const list = $('#conv-list');
  list.innerHTML = '';
  for (const c of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
    item.innerHTML = `
      <div class="t">${escapeHtml(c.title)}</div>
      <div class="p">${escapeHtml((c.preview || '').slice(0, 60))} · ${timeAgo(c.updated_at)}</div>
      <button class="conv-del" title="Delete">🗑</button>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('conv-del')) return;
      openConversation(c.id);
    });
    item.querySelector('.conv-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this chat and its stored files?')) return;
      await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
      if (state.currentConvId === c.id) newChat();
      loadConversations();
    });
    list.appendChild(item);
  }
}

$('#btn-new-chat').addEventListener('click', newChat);

function newChat() {
  state.currentConvId = null;
  $('#chat-title').textContent = 'New chat';
  $('#messages').innerHTML = `
    <div class="empty-state">
      <div class="empty-logo">👑</div>
      <h2>What are we working on, Rahat?</h2>
      <p>Ask anything — attach PDFs, images, audio or video, or switch agents from the header.</p>
    </div>`;
  showView('chat');
  loadConversations();
}

async function openConversation(id) {
  try {
    const r = await api(`/api/conversations/${id}`);
    state.currentConvId = id;
    $('#chat-title').textContent = r.conversation.title;
    if (r.conversation.agent_id && agentById(r.conversation.agent_id)) $('#agent-select').value = r.conversation.agent_id;
    if (r.conversation.model) {
      const sel = $('#model-select');
      if (![...sel.options].some((o) => o.value === r.conversation.model)) sel.add(new Option(r.conversation.model, r.conversation.model), 0);
      sel.value = r.conversation.model;
    }
    const box = $('#messages');
    box.innerHTML = '';
    for (const m of r.messages) {
      if (m.role === 'assistant') addMessage('assistant', m.content, []);
      else addMessage('user', m.content, m.attachments || []);
    }
    showView('chat');
    scrollBottom(true);
    loadConversations();
  } catch (err) { toast(err.message); }
}

// ---------------- message rendering ----------------

function agentName() {
  const a = agentById($('#agent-select').value);
  return a ? `${a.emoji} ${a.name}` : 'Rahat AI';
}

function addMessage(role, content, atts = []) {
  const empty = $('#messages .empty-state');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const who = role === 'user' ? (state.user?.name || 'You') : 'Rahat AI';
  div.innerHTML = `<div class="who">${role === 'user' ? '' : '👑 '}${escapeHtml(who)}</div><div class="body"></div>`;
  const body = div.querySelector('.body');
  body.innerHTML = role === 'user' ? renderMarkdown(content) : renderMarkdown(content);

  if (atts.length) {
    const wrap = document.createElement('div');
    wrap.className = 'atts';
    for (const a of atts) {
      if (a.kind === 'image' && a.url) {
        const link = document.createElement('a');
        link.href = a.url;
        link.target = '_blank';
        const img = document.createElement('img');
        img.className = 'att-thumb';
        img.src = a.url;
        img.alt = a.file_name || 'image';
        img.loading = 'lazy';
        link.appendChild(img);
        wrap.appendChild(link);
      } else if (a.url) {
        const chip = document.createElement('span');
        chip.className = 'att-chip';
        chip.innerHTML = `${kindIcon(a.kind)} <span class="nm">${escapeHtml(a.file_name || 'file')}</span> <span class="muted small">${fmtBytes(a.size)}</span>`;
        chip.querySelector('.nm').outerHTML = `<a class="nm" href="${a.url}" target="_blank">${escapeHtml(a.file_name || 'file')}</a>`;
        wrap.appendChild(chip);
      }
    }
    div.appendChild(wrap);
  }
  $('#messages').appendChild(div);
  scrollBottom();
  return div;
}

function kindIcon(kind) {
  return { image: '🖼', pdf: '📄', audio: '🎧', video: '🎬' }[kind] || '📎';
}

function scrollBottom(force = false) {
  const m = $('#messages');
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 220;
  if (near || force) m.scrollTop = m.scrollHeight;
}

// ---------------- attachments ----------------

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mpeg: 'video/mpeg',
};

async function uploadFile(file, onStatus) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime = (file.type || MIME_BY_EXT[ext] || '').toLowerCase();
  const kind = kindOf(mime);
  if (!kind) { toast(`"${file.name}" — only images, PDFs, audio and video are allowed`); return null; }
  const max = kind === 'image' ? MAX_IMAGE : MAX_OTHER;
  if (file.size > max) {
    toast(kind === 'image' ? `"${file.name}" is over the 10 MB image limit` : `"${file.name}" is over the 30 MB limit`);
    return null;
  }
  onStatus?.('uploading…');
  const init = await api('/api/upload/init', { body: { fileName: file.name, mime: mime || 'application/octet-stream', size: file.size } });
  const put = await fetch(init.uploadUrl, { method: 'PUT', headers: { 'Content-Type': init.contentType }, body: file });
  if (!put.ok) throw new Error(`Storage upload failed (${put.status})`);
  const done = await api('/api/upload/complete', { body: { fileName: file.name, mime: init.contentType, size: file.size, key: init.key } });
  onStatus?.('');
  return { id: done.id, fileName: done.fileName, mime: done.mimeType, kind: done.kind, size: done.size, url: done.url, inline: null };
}

// Downscale images in the browser so big photos can still be sent to models cheaply.
async function fileToResizedDataUrl(file, maxDim = 1568, quality = 0.85) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } catch { return null; }
}

$('#btn-attach').addEventListener('click', () => $('#file-input').click());

$('#file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const placeholder = { fileName: file.name, size: file.size, kind: kindOf(file.type || '') || 'file', uploading: true };
    state.attachments.push(placeholder);
    renderChips();
    try {
      const done = await uploadFile(file);
      if (done) {
        if (done.kind === 'image') done.inline = await fileToResizedDataUrl(file);
        Object.assign(placeholder, done, { uploading: false });
      } else {
        state.attachments = state.attachments.filter((a) => a !== placeholder);
      }
    } catch (err) {
      state.attachments = state.attachments.filter((a) => a !== placeholder);
      toast(err.message);
    }
    renderChips();
  }
  e.target.value = '';
});

function renderChips() {
  const box = $('#attach-chips');
  box.innerHTML = '';
  for (const a of state.attachments) {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    chip.innerHTML = `${kindIcon(a.kind)} <span class="nm">${escapeHtml(a.fileName)}</span> <span class="muted small">${a.uploading ? 'uploading…' : fmtBytes(a.size)}</span>`;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', () => { state.attachments = state.attachments.filter((x) => x !== a); renderChips(); });
    chip.appendChild(rm);
    box.appendChild(chip);
  }
}

// ---------------- chat send (SSE) ----------------

const promptEl = $('#prompt');
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
});
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#btn-send').addEventListener('click', sendMessage);

function setSending(v) {
  state.sending = v;
  $('#btn-send').disabled = v;
}

async function sendMessage() {
  if (state.sending) return;
  const content = promptEl.value.trim();
  const atts = state.attachments.filter((a) => !a.uploading);
  const stillUploading = state.attachments.some((a) => a.uploading);
  if (stillUploading) { toast('Hold on — files are still uploading'); return; }
  if (!content && !atts.length) return;

  setSending(true);
  addMessage('user', content, atts);
  promptEl.value = '';
  promptEl.style.height = 'auto';
  state.attachments = [];
  renderChips();

  const bubble = addMessage('assistant', '');
  const body = bubble.querySelector('.body');
  body.innerHTML = '<span class="cursor"></span>';

  let text = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: state.currentConvId,
        agentId: $('#agent-select').value || null,
        model: $('#model-select').value || null,
        content,
        attachments: atts.map(({ id, inline }) => ({ id, inline })),
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Error ${res.status}`);
    }
    const reader = res.body.getReader();
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
        let ev;
        try { ev = JSON.parse(t.slice(5)); } catch { continue; }
        if (ev.type === 'begin') {
          state.currentConvId = ev.conversationId;
          if ($('#chat-title').textContent === 'New chat') {
            $('#chat-title').textContent = (content || 'New chat').slice(0, 60);
          }
        } else if (ev.type === 'delta') {
          text += ev.text;
          body.innerHTML = renderMarkdown(text) + '<span class="cursor"></span>';
          scrollBottom();
        } else if (ev.type === 'error') {
          throw new Error(ev.error);
        }
      }
    }
    body.innerHTML = renderMarkdown(text) || '<span class="muted">(empty response)</span>';
  } catch (err) {
    bubble.classList.add('error');
    body.innerHTML = `<span>⚠ ${escapeHtml(err.message)}</span>`;
  } finally {
    setSending(false);
    scrollBottom();
    loadConversations();
  }
}

// ---------------- image studio ----------------

$('#btn-ref').addEventListener('click', () => $('#ref-input').click());
$('#ref-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > MAX_IMAGE) { toast('Reference images are limited to 10 MB'); return; }
  const dataUrl = await fileToResizedDataUrl(file, 2048, 0.9);
  if (!dataUrl) { toast('Could not read that image'); return; }
  state.refDataUrl = dataUrl;
  $('#ref-thumb').src = dataUrl;
  show($('#ref-thumb'));
  show($('#btn-ref-clear'));
  e.target.value = '';
});
$('#btn-ref-clear').addEventListener('click', () => {
  state.refDataUrl = null;
  $('#ref-thumb').src = '';
  hide($('#ref-thumb'));
  hide($('#btn-ref-clear'));
});

$('#btn-generate').addEventListener('click', async () => {
  const prompt = $('#img-prompt').value.trim();
  if (!prompt) { toast('Describe the image first'); return; }
  const btn = $('#btn-generate');
  btn.disabled = true;
  $('#img-status').textContent = state.refDataUrl ? 'Editing image… (this can take up to a minute)' : 'Generating… (this can take up to a minute)';
  try {
    const r = await api('/api/images/generate', {
      body: {
        prompt,
        model: $('#img-model').value || null,
        aspectRatio: $('#img-ratio').value,
        resolution: $('#img-res').value,
        refDataUrl: state.refDataUrl,
      },
    });
    $('#img-status').textContent = r.usage?.cost != null ? `Done — cost $${Number(r.usage.cost).toFixed(4)}` : 'Done';
    for (const url of r.images) addGeneratedImage(url, prompt);
  } catch (err) {
    $('#img-status').textContent = '';
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

function addGeneratedImage(dataUrl, prompt) {
  const gallery = $('#img-gallery');
  gallery.querySelector('.empty-state')?.remove();
  const item = document.createElement('div');
  item.className = 'gen-item';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = prompt.slice(0, 80);
  img.title = 'Click to open full size';
  img.addEventListener('click', () => window.open(dataUrl, '_blank'));
  const actions = document.createElement('div');
  actions.className = 'gen-actions';

  const dl = document.createElement('button');
  dl.className = 'btn';
  dl.textContent = '⬇ Download';
  dl.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `rahat-ai-${Date.now()}.png`;
    a.click();
  });

  const save = document.createElement('button');
  save.className = 'btn ghost';
  save.textContent = '💾 Save to library';
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const blob = dataURLtoBlob(dataUrl);
      const file = new File([blob], `generated-${Date.now()}.png`, { type: blob.type });
      await uploadFile(file);
      save.textContent = 'Saved ✓';
    } catch (err) {
      save.disabled = false;
      save.textContent = '💾 Save to library';
      toast(err.message);
    }
  });

  actions.append(dl, save);
  item.append(img, actions);
  gallery.prepend(item);
}

function dataURLtoBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------------- agents ----------------

function renderAgentCards() {
  const list = $('#agent-list');
  list.innerHTML = '';
  if (!state.agents.length) {
    list.innerHTML = '<div class="muted">No agents yet. Create your first one →</div>';
    return;
  }
  for (const a of [...state.agents].sort((x, y) => y.is_default - x.is_default || x.id - y.id)) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML = `
      <div class="emoji">${escapeHtml(a.emoji)}</div>
      <div class="info">
        <div class="nm">${escapeHtml(a.name)}${a.is_default ? '<span class="tag">default</span>' : ''}</div>
        <div class="ds">${escapeHtml(a.description || '')}</div>
        <div class="sp">${escapeHtml(a.system_prompt)}</div>
      </div>
      <div class="actions">
        <button class="btn small edit">Edit</button>
        <button class="btn small danger del">Delete</button>
      </div>`;
    card.querySelector('.edit').addEventListener('click', () => fillAgentForm(a));
    card.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete agent "${a.name}"?`)) return;
      await api(`/api/agents/${a.id}`, { method: 'DELETE' });
      await loadAgents();
      renderAgentCards();
      toast('Agent deleted');
    });
    list.appendChild(card);
  }
}

function fillAgentForm(a) {
  $('#agent-form-title').textContent = 'Edit agent';
  $('#ag-id').value = a.id;
  $('#ag-name').value = a.name;
  $('#ag-emoji').value = a.emoji;
  $('#ag-desc').value = a.description || '';
  $('#ag-prompt').value = a.system_prompt;
  $('#ag-model').value = a.model || '';
  $('#ag-temp').value = a.temperature ?? 0.7;
  $('#ag-default').checked = !!a.is_default;
  $('#ag-save').textContent = 'Update agent';
  $('#view-agents').scrollIntoView({ behavior: 'smooth' });
}

function resetAgentForm() {
  $('#agent-form-title').textContent = 'New agent';
  $('#agent-form').reset();
  $('#ag-id').value = '';
  $('#ag-temp').value = 0.7;
  $('#ag-save').textContent = 'Save agent';
}

$('#ag-reset').addEventListener('click', resetAgentForm);

$('#agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: $('#ag-name').value.trim(),
    emoji: $('#ag-emoji').value.trim() || '🤖',
    description: $('#ag-desc').value.trim(),
    system_prompt: $('#ag-prompt').value.trim(),
    model: $('#ag-model').value.trim() || null,
    temperature: Number($('#ag-temp').value) || 0.7,
    is_default: $('#ag-default').checked,
  };
  const id = $('#ag-id').value;
  try {
    if (id) await api(`/api/agents/${id}`, { method: 'PATCH', body: payload });
    else await api('/api/agents', { body: payload });
    await loadAgents();
    renderAgentCards();
    resetAgentForm();
    toast('Agent saved ✓');
  } catch (err) { toast(err.message); }
});

// ---------------- boot ----------------

async function boot() {
  try {
    const me = await fetch('/api/auth/me').then((r) => r.json());
    if (me.needsSetup) {
      show($('#auth-view'));
      show($('#setup-form'));
      if (me.requireSetupCode) show($('#su-code-row'));
    } else if (me.user) {
      await enterApp(me.user);
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

boot();
