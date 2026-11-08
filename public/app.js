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
  memories: [],
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
  await Promise.all([loadAgents(), loadSettings()]);
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
  if (name === 'settings') { refreshStats(); loadMemoriesView(); }
  if (name === 'artifacts') renderArtifactsView();
  if (name === 'connections') renderConnectionsView();
}

$$('.side-link').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

$('#btn-menu').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
$('#scrim').addEventListener('click', closeSidebar);
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

// ---------------- agents select ----------------
// Models are chosen automatically by the workstation (Auto mode) — the UI has no model pickers.

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
    const box = $('#messages');
    box.innerHTML = '';
    for (const m of r.messages) {
      let tl = null;
      if (m.tool_log) { try { tl = JSON.parse(m.tool_log); } catch {} }
      if (m.role === 'assistant') addMessage('assistant', m.content, [], tl);
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

const TOOL_ICON = {
  web_search: '🔍', web_fetch: '🌐', run_js: '⚙️', image_generate: '🎨',
  make_video_program: '🎬', make_artifact: '🧩', save_memory: '🧠', list_connections: '📋', api_request: '🔌',
};
const TOOL_LABEL = {
  web_search: 'Web search', web_fetch: 'Read page', run_js: 'Run code', image_generate: 'Generate image',
  make_video_program: 'Video program', make_artifact: 'Create artifact', save_memory: 'Saved to memory',
  list_connections: 'Connections', api_request: 'API call',
};

function toolItem(name, summary, phase) {
  const el = document.createElement('div');
  el.className = 'tool-item ' + phase;
  el.innerHTML = `<span class="ti-ic">${TOOL_ICON[name] || '🔧'}</span><span class="ti-lb">${escapeHtml(TOOL_LABEL[name] || name)}</span><span class="ti-ds">${escapeHtml(summary || '')}</span><span class="ti-st"></span>`;
  el.querySelector('.ti-st').textContent = phase === 'run' ? '⏳' : phase === 'fail' ? '⚠' : '✓';
  return el;
}

function speakText(text) {
  try {
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, ' code block. ')
      .replace(/[*_#>`|\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 4500);
    if (!clean) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    speechSynthesis.speak(u);
  } catch {}
}

function artifactCard(a) {
  const btn = document.createElement('button');
  btn.className = 'artifact-card';
  const icon = a.type === 'image' ? '🖼' : a.type === 'video-program' ? '🎬' : '🧩';
  btn.innerHTML = `<span class="ac-ic">${icon}</span><span class="ac-t">${escapeHtml(a.title || 'Artifact')}</span><span class="ac-ty">${escapeHtml(a.type || '')}</span>`;
  btn.addEventListener('click', () => openArtifactModal(a.id));
  return btn;
}

function addMessage(role, content, atts = [], toolLog = null) {
  const empty = $('#messages .empty-state');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const who = role === 'user' ? (state.user?.name || 'You') : 'Rahat AI';
  if (role === 'assistant') {
    div.innerHTML = `<div class="who">👑 ${escapeHtml(who)} <button class="speak-btn" title="Read aloud">🔊</button></div><div class="timeline"></div><div class="media"></div><div class="body"></div>`;
  } else {
    div.innerHTML = `<div class="who">${escapeHtml(who)}</div><div class="body"></div>`;
  }
  const body = div.querySelector('.body');
  body.innerHTML = renderMarkdown(content);

  if (role === 'assistant') {
    const tl = div.querySelector('.timeline');
    div.querySelector('.speak-btn').addEventListener('click', () => speakText(content || ''));
    if (Array.isArray(toolLog)) {
      for (const t of toolLog) tl.appendChild(toolItem(t.name, t.summary, t.ok !== false ? 'done' : 'fail'));
    }
  }

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
  if (!put.ok) {
    const detail = (await put.text().catch(() => '')).slice(0, 220);
    throw new Error(`Storage upload failed (${put.status}): ${detail || 'no details returned'}`);
  }
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

// --- voice input (Claude voice-mode / GLM voice equivalent, browser-native) ---
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRec) {
  const mic = $('#btn-mic');
  mic.classList.remove('hidden');
  let rec = null, listening = false, base = '';
  mic.addEventListener('click', () => {
    if (listening) { rec && rec.stop(); return; }
    try {
      rec = new SpeechRec();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      base = promptEl.value ? promptEl.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (e) => {
        let txt = '';
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        promptEl.value = (base + txt).trimStart();
        promptEl.dispatchEvent(new Event('input'));
      };
      rec.onend = () => { listening = false; mic.classList.remove('mic-on'); };
      rec.onerror = () => { listening = false; mic.classList.remove('mic-on'); toast('Voice input failed — check microphone permission'); };
      rec.start();
      listening = true;
      mic.classList.add('mic-on');
      toast('Listening… tap 🎙 again to stop');
    } catch { toast('Voice input is not available here'); }
  });
}

// --- Deep Research mode toggle ---
$('#research-toggle').addEventListener('click', () => {
  state.research = !state.research;
  $('#research-toggle').classList.toggle('on', state.research);
  toast(state.research
    ? '🔬 Research ON — the agent digs through many sources and cites them (slower)'
    : 'Research off — normal speed');
});

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
  const tl = bubble.querySelector('.timeline');
  const media = bubble.querySelector('.media');
  const body = bubble.querySelector('.body');
  body.innerHTML = '<span class="cursor"></span>';
  const pending = new Map();

  let text = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: state.currentConvId,
        agentId: $('#agent-select').value || null,
        model: 'auto',
        content,
        research: state.research === true,
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
        } else if (ev.type === 'tool') {
          if (ev.phase === 'start') {
            const item = toolItem(ev.name, ev.summary, 'run');
            tl.appendChild(item);
            pending.set(`${ev.name}|${ev.summary || ''}`, item);
          } else {
            const item = pending.get(`${ev.name}|${ev.summary || ''}`) || tl.querySelector('.tool-item.run');
            if (item) {
              item.classList.remove('run');
              item.classList.add(ev.ok ? 'done' : 'fail');
              item.querySelector('.ti-st').textContent = ev.ok ? '✓' : '⚠';
            }
            pending.delete(`${ev.name}|${ev.summary || ''}`);
          }
          scrollBottom();
        } else if (ev.type === 'image' && ev.dataUrl) {
          const wrap = document.createElement('div');
          wrap.className = 'gen-inline';
          const img = document.createElement('img');
          img.src = ev.dataUrl;
          img.alt = 'generated image';
          img.addEventListener('click', () => window.open(ev.dataUrl, '_blank'));
          wrap.appendChild(img);
          media.appendChild(wrap);
          scrollBottom();
        } else if (ev.type === 'artifact' && ev.artifact) {
          media.appendChild(artifactCard(ev.artifact));
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
        model: 'auto',
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
    model: null,
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

// ---------------- artifacts: viewer, gallery, PDF export ----------------

async function openArtifactModal(id) {
  try {
    const { artifact } = await api(`/api/artifacts/${id}`);
    $('#am-title').textContent = artifact.title || 'Artifact';
    const stage = $('#am-stage');
    stage.innerHTML = '';
    if (artifact.type === 'image') {
      const img = document.createElement('img');
      img.src = artifact.url || artifact.content || '';
      stage.appendChild(img);
    } else if (artifact.type === 'video-program') {
      const div = document.createElement('div');
      div.className = 'am-md';
      const info = document.createElement('p');
      info.textContent = 'Animation program — render it into a real video file in the Video Studio.';
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = '🎬 Open in Video Studio';
      btn.addEventListener('click', () => {
        hide($('#artifact-modal'));
        openVideoProgramInStudio(artifact.content || '');
      });
      const pre = document.createElement('pre');
      pre.className = 'am-code';
      pre.textContent = (artifact.content || '').slice(0, 4000);
      div.append(info, btn, pre);
      stage.appendChild(div);
    } else if (artifact.type === 'html') {
      const iframe = document.createElement('iframe');
      iframe.className = 'am-iframe';
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.srcdoc = artifact.content || '';
      stage.appendChild(iframe);
    } else if (artifact.type === 'markdown' || artifact.type === 'text') {
      const div = document.createElement('div');
      div.className = 'am-md';
      div.innerHTML = renderMarkdown(artifact.content || '');
      stage.appendChild(div);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'am-code';
      pre.textContent = artifact.content || '';
      stage.appendChild(pre);
    }
    $('#am-download').onclick = () => downloadArtifact(artifact);
    $('#am-pdf').onclick = () => printArtifact(artifact);
    $('#am-word').onclick = () => exportWord(artifact);
    const wordBtn = $('#am-word');
    wordBtn.classList.toggle('hidden', artifact.type === 'image' || artifact.type === 'video-program');
    show($('#artifact-modal'));
  } catch (err) { toast(err.message); }
}

// Word export (Claude "file creation" equivalent): wraps the artifact in a
// Word-compatible HTML document that Word, Google Docs and WPS all open.
function exportWord(artifact) {
  let bodyHtml;
  if (artifact.type === 'html') bodyHtml = artifact.content || '';
  else if (artifact.type === 'markdown') bodyHtml = renderMarkdown(artifact.content || '');
  else bodyHtml = `<pre style="font-family:Consolas,monospace;font-size:11pt;white-space:pre-wrap">${escapeHtml(artifact.content || '')}</pre>`;
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escapeHtml(artifact.title || 'Artifact')}</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5">${bodyHtml}</body></html>`;
  const blob = new Blob(['\ufeff', doc], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(artifact.title || 'artifact').replace(/[^\w.-]+/g, '_')}.doc`;
  a.click();
  toast('Word document downloaded (.doc — opens in Word, Google Docs, WPS)');
}

function downloadArtifact(artifact) {
  const ext = { html: 'html', markdown: 'md', code: 'js', text: 'txt', image: 'png', 'video-program': 'json' }[artifact.type] || 'txt';
  const name = `${(artifact.title || 'artifact').replace(/[^\w.-]+/g, '_')}.${ext}`;
  if (artifact.url) {
    const a = document.createElement('a');
    a.href = artifact.url;
    a.download = name;
    a.click();
    return;
  }
  const blob = artifact.content && artifact.content.startsWith('data:')
    ? dataURLtoBlob(artifact.content)
    : new Blob([artifact.content || ''], { type: artifact.type === 'html' ? 'text/html' : 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// Export via the browser's print dialog → "Save as PDF".
function printArtifact(artifact) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to export as PDF'); return; }
  let inner;
  if (artifact.type === 'html' && !artifact.url) {
    inner = artifact.content || '';
  } else if (artifact.type === 'image') {
    inner = `<h1>${escapeHtml(artifact.title)}</h1><img src="${artifact.url || artifact.content}" style="max-width:100%" />`;
  } else {
    const bodyHtml = artifact.type === 'code'
      ? `<pre>${escapeHtml(artifact.content || '')}</pre>`
      : renderMarkdown(artifact.content || '');
    inner = `<h1>${escapeHtml(artifact.title)}</h1>${bodyHtml}`;
  }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(artifact.title || 'Artifact')}</title>
    <style>body{font-family:Georgia,'Times New Roman',serif;margin:48px auto;max-width:720px;line-height:1.65;color:#111}
    h1,h2,h3{font-family:Arial,sans-serif} pre{background:#f4f4f4;padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap}
    img{max-width:100%} blockquote{border-left:3px solid #ccc;margin:0;padding-left:16px;color:#444}</style></head>
    <body>${inner}</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 700);
}

$('#am-close').addEventListener('click', () => hide($('#artifact-modal')));
$('#artifact-modal').addEventListener('click', (e) => {
  if (e.target.id === 'artifact-modal') hide($('#artifact-modal'));
});

async function renderArtifactsView() {
  const list = $('#artifact-list');
  list.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const { artifacts } = await api('/api/artifacts');
    list.innerHTML = '';
    if (!artifacts.length) {
      list.innerHTML = '<div class="muted">No artifacts yet. Ask Rahat AI for a website, report, document or image — anything it builds lands here.</div>';
      return;
    }
    for (const a of artifacts) {
      const card = document.createElement('div');
      card.className = 'artifact-row';
      card.innerHTML = `<span class="ac-ic">${a.type === 'image' ? '🖼' : a.type === 'html' ? '🌐' : a.type === 'video-program' ? '🎬' : '🧩'}</span>
        <div class="info"><div class="t">${escapeHtml(a.title)}</div><div class="muted small">${escapeHtml(a.type)} · ${timeAgo(a.createdAt)}</div></div>
        <div class="actions"><button class="btn small open">Open</button><button class="btn small danger del">Delete</button></div>`;
      card.querySelector('.open').addEventListener('click', () => openArtifactModal(a.id));
      card.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(`Delete "${a.title}"?`)) return;
        await api(`/api/artifacts/${a.id}`, { method: 'DELETE' });
        renderArtifactsView();
      });
      list.appendChild(card);
    }
  } catch (err) { list.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`; }
}

// ---------------- connections (Netlify, Vercel, any REST API) ----------------

async function renderConnectionsView() {
  const list = $('#conn-list');
  list.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const { connections } = await api('/api/connections');
    list.innerHTML = '';
    if (!connections.length) {
      list.innerHTML = '<div class="muted">No services connected yet. Add one below, then just ask in chat — e.g. “deploy my website to Netlify”.</div>';
    }
    for (const c of connections) {
      const card = document.createElement('div');
      card.className = 'conn-row';
      card.innerHTML = `<div class="info"><div class="t">🔌 ${escapeHtml(c.name)}</div>
        <div class="muted small">${escapeHtml(c.base_url)}${c.notes ? ' · ' + escapeHtml(c.notes) : ''}</div></div>
        <button class="btn small danger del">Delete</button>`;
      card.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(`Disconnect "${c.name}"?`)) return;
        await api(`/api/connections/${c.id}`, { method: 'DELETE' });
        renderConnectionsView();
      });
      list.appendChild(card);
    }
  } catch (err) { list.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`; }
}

$('#conn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#conn-msg').textContent = '';
  try {
    await api('/api/connections', {
      body: {
        name: $('#cn-name').value.trim(),
        baseUrl: $('#cn-url').value.trim(),
        authHeader: $('#cn-auth').value.trim(),
        notes: $('#cn-notes').value.trim(),
      },
    });
    $('#cn-name').value = ''; $('#cn-url').value = ''; $('#cn-auth').value = ''; $('#cn-notes').value = '';
    renderConnectionsView();
    toast('Connection saved — the agent can now use it');
  } catch (err) { $('#conn-msg').textContent = err.message; }
});

// ---------------- memories (settings) ----------------

async function loadMemoriesView() {
  const box = $('#mem-list');
  box.innerHTML = '<div class="muted small">Loading…</div>';
  try {
    const { memories } = await api('/api/memories');
    box.innerHTML = '';
    if (!memories.length) {
      box.innerHTML = '<div class="muted small">Nothing remembered yet. In chat, tell the agent “remember that …” — durable facts appear here and are used in every conversation.</div>';
      return;
    }
    for (const m of memories) {
      const row = document.createElement('div');
      row.className = 'mem-row';
      row.innerHTML = `<span>${escapeHtml(m.content)}</span><button class="rm" title="Forget">✕</button>`;
      row.querySelector('.rm').addEventListener('click', async () => {
        await api(`/api/memories/${m.id}`, { method: 'DELETE' });
        loadMemoriesView();
      });
      box.appendChild(row);
    }
  } catch { box.innerHTML = '<div class="muted small">Could not load memories.</div>'; }
}

// ---------------- Video Studio ----------------
// Motion graphics, 2D animation programs and raw video editing — all rendered
// in-browser on <canvas> and recorded with MediaRecorder. No server encoding.

const video = {
  program: null,
  imgCache: new Map(),
  previewing: false,
  recording: false,
  clips: [],
};

function easeFn(name) {
  switch (name) {
    case 'in': return (t) => t * t;
    case 'out': return (t) => 1 - (1 - t) * (1 - t);
    case 'inout': return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    default: return (t) => t;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Chained anims on the same prop work like keyframes: the last anim whose
// start time has passed owns the value; before any start, the first "from" holds.
function applyAnims(el, t, base) {
  const out = { ...base };
  const byProp = {};
  for (const a of el.anim || []) {
    if (a && a.prop != null) (byProp[a.prop] ||= []).push(a);
  }
  for (const [prop, list] of Object.entries(byProp)) {
    list.sort((x, y) => x.start - y.start);
    let v = list[0].from;
    for (const a of list) {
      if (t < a.start) break;
      const span = (a.end ?? a.start) - a.start;
      const p = span > 0 ? Math.min(1, (t - a.start) / span) : 1;
      v = a.from + ((a.to ?? a.from) - a.from) * easeFn(a.easing)(p);
    }
    out[prop] = v;
  }
  return out;
}

function progBackground(ctx, bg, W, H) {
  if (bg && typeof bg === 'object') {
    let g;
    if (bg.type === 'radial') g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.3);
    else g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg.from || '#101627');
    g.addColorStop(1, bg.to || '#7c5cff');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg || '#0b0f1a';
  }
  ctx.fillRect(0, 0, W, H);
}

function getImage(src) {
  if (!video.imgCache.has(src)) {
    const img = new Image();
    img.src = src;
    video.imgCache.set(src, img);
  }
  return video.imgCache.get(src);
}

function drawElement(ctx, el, t) {
  const base = { x: el.x ?? 0, y: el.y ?? 0, opacity: el.opacity ?? 1, scale: el.scale ?? 1, rotate: el.rotate ?? 0, w: el.w ?? 0 };
  const p = applyAnims(el, t, base);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity));
  ctx.translate(p.x, p.y);
  if (p.rotate) ctx.rotate((p.rotate * Math.PI) / 180);
  if (p.scale !== 1) ctx.scale(p.scale, p.scale);
  if (el.shadow) { ctx.shadowColor = el.shadow; ctx.shadowBlur = el.shadowBlur || 18; }
  if (el.type === 'text') {
    ctx.font = el.font || `bold ${el.size || 80}px Arial, sans-serif`;
    ctx.fillStyle = el.color || '#fff';
    ctx.textAlign = el.align || 'center';
    ctx.textBaseline = 'middle';
    const lines = String(el.text ?? '').split('\n');
    const size = el.size || 80;
    const lh = (el.lineHeight || 1.25) * size;
    lines.forEach((ln, i) => ctx.fillText(ln, 0, (i - (lines.length - 1) / 2) * lh));
  } else if (el.type === 'rect') {
    ctx.fillStyle = el.color || '#fff';
    const w = p.w || el.w || 120;
    const h = el.h ?? 60;
    roundRectPath(ctx, -w / 2, -h / 2, w, h, el.radius ?? 12);
    ctx.fill();
    if (el.stroke) { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeWidth || 3; ctx.stroke(); }
  } else if (el.type === 'circle') {
    ctx.fillStyle = el.color || '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, el.r ?? 60, 0, Math.PI * 2);
    ctx.fill();
  } else if (el.type === 'ring') {
    ctx.strokeStyle = el.color || '#fff';
    ctx.lineWidth = el.lineWidth || 10;
    ctx.beginPath();
    ctx.arc(0, 0, el.r ?? 60, 0, Math.PI * 2);
    ctx.stroke();
  } else if (el.type === 'image' && el.src) {
    const img = getImage(el.src);
    if (img.complete && img.naturalWidth) {
      const w = el.w || img.naturalWidth;
      const h = el.h || img.naturalHeight;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
  }
  ctx.restore();
}

function drawProgram(ctx, prog, t) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  progBackground(ctx, prog.background, W, H);
  for (const sc of prog.scenes || []) {
    if (t < sc.start || t >= (sc.end ?? prog.duration)) continue;
    for (const el of sc.elements || []) drawElement(ctx, el, t);
  }
}

// --- motion-graphics templates ---

function buildTemplateProgram() {
  const kind = $('#vg-template').value;
  const [W, H] = $('#vg-size').value.split('x').map(Number);
  const dur = Math.max(2, Math.min(30, Number($('#vg-dur').value) || 5));
  const t1 = $('#vg-text1').value.trim() || 'RAHAT';
  const t2 = $('#vg-text2').value.trim() || 'AI WORKSTATION';
  const acc = $('#vg-accent').value;
  const prog = { width: W, height: H, fps: 30, duration: dur, scenes: [] };

  if (kind === 'intro') {
    prog.background = { type: 'linear', from: '#0b0f1a', to: acc };
    prog.scenes.push({
      start: 0, end: dur,
      elements: [
        { type: 'text', text: t1, x: W / 2, y: H / 2 - (t2 ? H * 0.06 : 0), size: Math.round(W * 0.11), color: '#ffffff',
          anim: [
            { prop: 'scale', from: 0.5, to: 1, start: 0, end: 0.9, easing: 'out' },
            { prop: 'opacity', from: 0, to: 1, start: 0, end: 0.5 },
            { prop: 'opacity', from: 1, to: 0, start: dur - 0.7, end: dur },
          ] },
        { type: 'rect', x: W / 2, y: H / 2 + H * 0.1, w: 10, h: 8, color: acc, radius: 4,
          anim: [
            { prop: 'w', from: 0, to: W * 0.42, start: 0.4, end: 1.1, easing: 'out' },
            { prop: 'opacity', from: 1, to: 0, start: dur - 0.7, end: dur },
          ] },
        { type: 'text', text: t2, x: W / 2, y: H / 2 + H * 0.2, size: Math.round(W * 0.032), color: '#c9d1e8',
          anim: [
            { prop: 'opacity', from: 0, to: 1, start: 0.9, end: 1.4 },
            { prop: 'opacity', from: 1, to: 0, start: dur - 0.7, end: dur },
          ] },
      ],
    });
  } else if (kind === 'lower') {
    prog.background = { type: 'linear', from: '#101627', to: '#1c2340' };
    const bx = -W * 0.3, bxIn = W * 0.3;
    prog.scenes.push({
      start: 0, end: dur,
      elements: [
        { type: 'rect', x: bxIn + W * 0.25, y: H * 0.78, w: W * 0.46, h: H * 0.13, color: 'rgba(10,14,26,0.92)', radius: 18,
          anim: [{ prop: 'x', from: bx + W * 0.25, to: bxIn + W * 0.25, start: 0.1, end: 0.7, easing: 'out' }] },
        { type: 'rect', x: bxIn + W * 0.25 - W * 0.2, y: H * 0.78, w: 10, h: H * 0.1, color: acc, radius: 5,
          anim: [{ prop: 'x', from: bx + W * 0.25 - W * 0.2, to: bxIn + W * 0.25 - W * 0.2, start: 0.1, end: 0.7, easing: 'out' }] },
        { type: 'text', text: t1, x: bxIn + W * 0.25 - W * 0.17, y: H * 0.757, size: Math.round(H * 0.055), color: '#ffffff', align: 'left',
          anim: [{ prop: 'x', from: bx + W * 0.25 - W * 0.17, to: bxIn + W * 0.25 - W * 0.17, start: 0.1, end: 0.7, easing: 'out' }] },
        { type: 'text', text: t2, x: bxIn + W * 0.25 - W * 0.17, y: H * 0.812, size: Math.round(H * 0.035), color: acc, align: 'left',
          anim: [
            { prop: 'x', from: bx + W * 0.25 - W * 0.17, to: bxIn + W * 0.25 - W * 0.17, start: 0.1, end: 0.7, easing: 'out' },
            { prop: 'opacity', from: 0, to: 1, start: 0.5, end: 0.9 },
          ] },
      ],
    });
  } else if (kind === 'logo') {
    prog.background = '#0b0f1a';
    prog.scenes.push({
      start: 0, end: dur,
      elements: [
        { type: 'ring', x: W / 2, y: H * 0.42, r: Math.round(W * 0.09), color: acc, lineWidth: Math.round(W * 0.012),
          anim: [{ prop: 'scale', from: 0, to: 1, start: 0, end: 0.8, easing: 'out' }, { prop: 'rotate', from: 0, to: 180, start: 0, end: 0.8, easing: 'out' }] },
        { type: 'circle', x: W / 2, y: H * 0.42, r: Math.round(W * 0.035), color: acc,
          anim: [{ prop: 'scale', from: 0, to: 1, start: 0.3, end: 1, easing: 'out' }] },
        { type: 'text', text: t1, x: W / 2, y: H * 0.62, size: Math.round(W * 0.06), color: '#ffffff',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 0.9, end: 1.5 }, { prop: 'opacity', from: 1, to: 0, start: dur - 0.6, end: dur }] },
        { type: 'text', text: t2, x: W / 2, y: H * 0.71, size: Math.round(W * 0.028), color: '#8a93ad',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 1.2, end: 1.8 }, { prop: 'opacity', from: 1, to: 0, start: dur - 0.6, end: dur }] },
      ],
    });
  } else if (kind === 'promo') {
    prog.background = { type: 'radial', from: '#141b30', to: acc };
    prog.scenes.push({
      start: 0, end: dur,
      elements: [
        { type: 'rect', x: W / 2, y: H / 2, w: W * 0.72, h: H * 0.62, color: 'rgba(8,11,22,0.85)', radius: 28,
          anim: [{ prop: 'scale', from: 0.8, to: 1, start: 0, end: 0.6, easing: 'out' }] },
        { type: 'text', text: '✨ ' + t1, x: W / 2, y: H * 0.34, size: Math.round(W * 0.055), color: '#ffffff',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 0.4, end: 0.9 }] },
        { type: 'text', text: t2, x: W / 2, y: H * 0.5, size: Math.round(W * 0.034), color: '#c9d1e8',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 0.8, end: 1.3 }] },
        { type: 'rect', x: W / 2, y: H * 0.66, w: W * 0.3, h: H * 0.1, color: acc, radius: 999,
          anim: [{ prop: 'scale', from: 0, to: 1, start: 1.2, end: 1.6, easing: 'out' }] },
        { type: 'text', text: 'LEARN MORE', x: W / 2, y: H * 0.66, size: Math.round(W * 0.02), color: '#ffffff',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 1.5, end: 1.8 }] },
      ],
    });
  } else if (kind === 'countdown') {
    prog.background = { type: 'linear', from: '#0b0f1a', to: acc };
    const nums = ['3', '2', '1'];
    nums.forEach((n, i) => {
      prog.scenes.push({
        start: i, end: i + 1,
        elements: [
          { type: 'ring', x: W / 2, y: H / 2, r: Math.round(W * 0.16), color: 'rgba(255,255,255,0.35)', lineWidth: 6,
            anim: [{ prop: 'scale', from: 1.3, to: 0.9, start: i, end: i + 1, easing: 'inout' }] },
          { type: 'text', text: n, x: W / 2, y: H / 2, size: Math.round(W * 0.18), color: '#ffffff',
            anim: [
              { prop: 'scale', from: 1.5, to: 1, start: i, end: i + 0.35, easing: 'out' },
              { prop: 'opacity', from: 0, to: 1, start: i, end: i + 0.15 },
              { prop: 'opacity', from: 1, to: 0, start: i + 0.7, end: i + 1 },
            ] },
        ],
      });
    });
    prog.scenes.push({
      start: 3, end: Math.max(4, dur),
      elements: [
        { type: 'text', text: t1 || 'GO!', x: W / 2, y: H / 2, size: Math.round(W * 0.16), color: acc,
          anim: [{ prop: 'scale', from: 0.4, to: 1.1, start: 3, end: 3.4, easing: 'out' }, { prop: 'opacity', from: 0, to: 1, start: 3, end: 3.2 }] },
      ],
    });
    prog.duration = Math.max(4, dur);
  } else { // outro
    prog.background = { type: 'linear', from: acc, to: '#0b0f1a' };
    prog.scenes.push({
      start: 0, end: dur,
      elements: [
        { type: 'text', text: t1, x: W / 2, y: H * 0.38, size: Math.round(W * 0.07), color: '#ffffff',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 0, end: 0.7 }, { prop: 'y', from: H * 0.42, to: H * 0.38, start: 0, end: 0.7, easing: 'out' }] },
        { type: 'rect', x: W / 2, y: H * 0.58, w: W * 0.36, h: H * 0.12, color: 'rgba(255,255,255,0.12)', radius: 999,
          anim: [{ prop: 'scale', from: 0, to: 1, start: 0.5, end: 1, easing: 'out' }, { prop: 'scale', from: 1, to: 1.05, start: 2, end: 2.4, easing: 'inout' }, { prop: 'scale', from: 1.05, to: 1, start: 2.4, end: 2.8, easing: 'inout' }] },
        { type: 'text', text: t2, x: W / 2, y: H * 0.58, size: Math.round(W * 0.03), color: '#ffffff',
          anim: [{ prop: 'opacity', from: 0, to: 1, start: 0.8, end: 1.2 }] },
      ],
    });
  }
  return prog;
}

// --- rendering / recording helpers ---

function sizeCanvasForProgram() {
  const p = video.program || {};
  const c = $('#vcanvas');
  c.width = Math.max(2, Math.min(1920, p.width || 1280));
  c.height = Math.max(2, Math.min(1080, p.height || 720));
}

function renderProgramFrame(t) {
  if (!video.program) return;
  drawProgram($('#vcanvas').getContext('2d'), video.program, t);
}

function stopPreview() { video.previewing = false; }

function previewProgram() {
  const prog = video.program;
  if (!prog) { toast('Build or load a program first'); return; }
  stopPreview();
  video.previewing = true;
  sizeCanvasForProgram();
  $('#vpreview').classList.add('hidden');
  $('#vcanvas').classList.remove('hidden');
  const dur = Number(prog.duration) || 5;
  const t0 = performance.now();
  const step = (now) => {
    if (!video.previewing) return;
    const t = ((now - t0) / 1000) % dur;
    renderProgramFrame(t);
    $('#vstatus').textContent = `Preview ${t.toFixed(1)}s / ${dur}s — press ⏺ Render video to export a real file`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function pickVideoMime() {
  if (!window.MediaRecorder) return '';
  const cands = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const c of cands) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return '';
}

function extForMime(mime) { return mime && mime.includes('mp4') ? 'mp4' : 'webm'; }

async function buildAudioStream(file) {
  if (!file) return null;
  try {
    const el = new Audio(URL.createObjectURL(file));
    el.loop = true;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaElementSource(el);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    return { el, ac, stream: dest.stream };
  } catch { return null; }
}

// Draw frames into `canvas` in real time and record the stream.
async function recordCanvas(canvas, fps, durationSec, audio, drawFrame, onStart) {
  const stream = canvas.captureStream(fps);
  if (audio?.stream) audio.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const mime = pickVideoMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: mime || 'video/webm' })); });
  rec.start(400);
  Promise.resolve(onStart?.()).catch(() => {});
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const t = (now - t0) / 1000;
      if (t >= durationSec) { drawFrame(durationSec); resolve(); return; }
      drawFrame(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  rec.stop();
  return done;
}

async function renderProgramVideo(audioFile) {
  if (video.recording) return;
  if (!video.program) { toast('Build or load a program first'); return; }
  if (!window.MediaRecorder) { toast('This browser cannot record video'); return; }
  stopPreview();
  const prog = video.program;
  const fps = Math.min(60, Number(prog.fps) || 30);
  const dur = Math.max(1, Number(prog.duration) || 5);
  sizeCanvasForProgram();
  const canvas = $('#vcanvas');
  $('#vpreview').classList.add('hidden');
  canvas.classList.remove('hidden');
  const audio = await buildAudioStream(audioFile);
  video.recording = true;
  $('#vstatus').textContent = 'Rendering… keep this screen open';
  try {
    const blob = await recordCanvas(canvas, fps, dur, audio, (t) => {
      renderProgramFrame(t);
      $('#vstatus').textContent = `Rendering… ${Math.min(dur, t).toFixed(1)}s / ${dur}s`;
    }, async () => {
      if (audio) { await audio.ac.resume().catch(() => {}); await audio.el.play().catch(() => {}); }
    });
    showVideoResult(blob, `motion-${Date.now()}`);
  } catch (err) {
    toast('Render failed: ' + err.message);
    $('#vstatus').textContent = '';
  } finally {
    video.recording = false;
    if (audio) { audio.el.pause(); audio.ac.close().catch(() => {}); }
  }
}

function showVideoResult(blob, base) {
  const ext = extForMime(blob.type);
  const url = URL.createObjectURL(blob);
  const vprev = $('#vpreview');
  vprev.src = url;
  vprev.classList.remove('hidden');
  $('#vcanvas').classList.add('hidden');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.${ext}`;
  a.click();
  $('#vstatus').textContent = `✅ Video ready (${fmtBytes(blob.size)}, ${ext.toUpperCase()}) — downloaded and playable above.`;
}

function loadProgramFromJson() {
  try {
    const prog = JSON.parse($('#vp-json').value);
    if (!prog || !Array.isArray(prog.scenes) || !prog.scenes.length) throw new Error('a non-empty scenes[] array is required');
    prog.width = Number(prog.width) || 1280;
    prog.height = Number(prog.height) || 720;
    prog.fps = Number(prog.fps) || 30;
    prog.duration = Number(prog.duration) || 5;
    video.program = prog;
    sizeCanvasForProgram();
    stopPreview();
    renderProgramFrame(0);
    $('#vpreview').classList.add('hidden');
    $('#vcanvas').classList.remove('hidden');
    $('#vstatus').textContent = `Loaded: ${prog.width}×${prog.height}, ${prog.duration}s, ${prog.scenes.length} scene(s)`;
  } catch (err) {
    toast('Invalid program: ' + err.message);
  }
}

function openVideoProgramInStudio(jsonContent) {
  showView('video');
  $$('.vse-tab').forEach((x) => x.classList.toggle('active', x.dataset.vtab === 'anim'));
  $('#vpanel-motion').classList.add('hidden');
  $('#vpanel-edit').classList.add('hidden');
  $('#vpanel-anim').classList.remove('hidden');
  $('#vp-json').value = jsonContent;
  loadProgramFromJson();
}

// --- raw video editor ---

function drawCover(ctx, v, W, H) {
  const vw = v.videoWidth || W;
  const vh = v.videoHeight || H;
  const s = Math.max(W / vw, H / vh);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(v, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
}

async function loadClips(files) {
  video.clips = [];
  const box = $('#ve-clips');
  box.innerHTML = '<div class="muted small">Reading clips…</div>';
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const el = document.createElement('video');
    el.src = url;
    el.preload = 'metadata';
    el.playsInline = true;
    await new Promise((res) => { el.onloadedmetadata = res; el.onerror = res; setTimeout(res, 8000); });
    if (!el.duration || !isFinite(el.duration)) {
      toast(`Skipped "${f.name}" — could not read the video`);
      continue;
    }
    video.clips.push({ file: f, url, el, dur: el.duration, start: 0, end: Math.min(el.duration, 120), muted: false, routed: false });
  }
  renderClips();
}

function renderClips() {
  const box = $('#ve-clips');
  box.innerHTML = '';
  if (!video.clips.length) {
    box.innerHTML = '<div class="muted small">No clips loaded yet.</div>';
    return;
  }
  video.clips.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.innerHTML = `
      <div class="cr-head"><b>🎬 ${escapeHtml(c.file.name)}</b>
        <span class="muted small">${c.dur.toFixed(1)}s → ${Math.max(0, c.end - c.start).toFixed(1)}s</span>
        <label class="cr-mute"><input type="checkbox" ${c.muted ? 'checked' : ''}/> 🔇</label>
        <button class="btn small ghost up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small ghost down" ${i === video.clips.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small danger rm">✕</button>
      </div>
      <label>Trim start <input type="range" class="cs" min="0" max="${c.dur.toFixed(1)}" step="0.1" value="${c.start}"/> <span class="muted small sv">${c.start.toFixed(1)}s</span></label>
      <label>Trim end <input type="range" class="ce" min="0" max="${c.dur.toFixed(1)}" step="0.1" value="${c.end}"/> <span class="muted small ev">${c.end.toFixed(1)}s</span></label>`;
    row.querySelector('.cs').addEventListener('input', (e) => {
      c.start = Math.min(Number(e.target.value), c.end - 0.2);
      e.target.value = c.start;
      row.querySelector('.sv').textContent = `${c.start.toFixed(1)}s`;
      row.querySelector('.cr-head .muted').textContent = `${c.dur.toFixed(1)}s → ${Math.max(0, c.end - c.start).toFixed(1)}s`;
    });
    row.querySelector('.ce').addEventListener('input', (e) => {
      c.end = Math.max(Number(e.target.value), c.start + 0.2);
      e.target.value = c.end;
      row.querySelector('.ev').textContent = `${c.end.toFixed(1)}s`;
      row.querySelector('.cr-head .muted').textContent = `${c.dur.toFixed(1)}s → ${Math.max(0, c.end - c.start).toFixed(1)}s`;
    });
    row.querySelector('.cr-mute input').addEventListener('change', (e) => { c.muted = e.target.checked; });
    row.querySelector('.up').addEventListener('click', () => {
      if (i > 0) { [video.clips[i - 1], video.clips[i]] = [video.clips[i], video.clips[i - 1]]; renderClips(); }
    });
    row.querySelector('.down').addEventListener('click', () => {
      if (i < video.clips.length - 1) { [video.clips[i + 1], video.clips[i]] = [video.clips[i], video.clips[i + 1]]; renderClips(); }
    });
    row.querySelector('.rm').addEventListener('click', () => {
      video.clips = video.clips.filter((x) => x !== c);
      renderClips();
    });
    box.appendChild(row);
  });
}

async function exportEdited() {
  if (video.recording) return;
  if (!window.MediaRecorder) { toast('This browser cannot record video'); return; }
  if (!video.clips.length) { toast('Add video clips first'); return; }
  const [W, H] = $('#ve-size').value.split('x').map(Number);
  const total = video.clips.reduce((s, c) => s + Math.max(0, c.end - c.start), 0);
  if (total <= 0) { toast('All trims are empty'); return; }

  const canvas = $('#vcanvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  stopPreview();
  $('#vpreview').classList.add('hidden');
  canvas.classList.remove('hidden');

  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();
  for (const c of video.clips) {
    try {
      const src = ac.createMediaElementSource(c.el);
      const g = ac.createGain();
      g.gain.value = c.muted ? 0 : 1;
      src.connect(g);
      g.connect(dest);
      c.routed = true;
    } catch {}
  }
  const music = await buildAudioStream($('#ve-audio').files[0]);

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  if (music?.stream) music.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mime = pickVideoMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: mime || 'video/webm' })); });

  video.recording = true;
  $('#ve-status').textContent = 'Exporting in real time — keep this screen open…';
  rec.start(600);
  await ac.resume().catch(() => {});
  if (music) { await music.ac.resume().catch(() => {}); await music.el.play().catch(() => {}); }

  try {
    for (const c of video.clips) {
      if (!c.routed) c.el.muted = true;
      c.el.currentTime = c.start;
      await new Promise((res) => { c.el.onseeked = res; setTimeout(res, 1500); });
      await c.el.play().catch(() => {});
      await new Promise((res) => {
        let finished = false;
        const finish = () => { if (!finished) { finished = true; res(); } };
        const draw = () => {
          if (!video.recording || c.el.ended || c.el.currentTime >= c.end) { finish(); return; }
          drawCover(ctx, c.el, W, H);
          $('#ve-status').textContent = `Exporting… "${c.file.name}" at ${c.el.currentTime.toFixed(1)}s (trim ${c.start.toFixed(1)}–${c.end.toFixed(1)})`;
          requestAnimationFrame(draw);
        };
        draw();
        c.el.onended = finish;
        setTimeout(finish, (c.end - c.start) * 1000 + 3000);
      });
      c.el.pause();
    }
  } finally {
    video.recording = false;
    rec.stop();
    if (music) music.el.pause();
    ac.close().catch(() => {});
  }

  const blob = await done;
  showVideoResult(blob, `edited-${Date.now()}`);
  $('#ve-status').textContent = '';
}

// --- studio bindings ---

$$('.vse-tab').forEach((b) => b.addEventListener('click', () => {
  $$('.vse-tab').forEach((x) => x.classList.toggle('active', x === b));
  const m = b.dataset.vtab;
  $('#vpanel-motion').classList.toggle('hidden', m !== 'motion');
  $('#vpanel-anim').classList.toggle('hidden', m !== 'anim');
  $('#vpanel-edit').classList.toggle('hidden', m !== 'edit');
  if (m !== 'edit') {
    if (!video.program) video.program = buildTemplateProgram();
    sizeCanvasForProgram();
    stopPreview();
    renderProgramFrame(0);
  }
}));

function refreshMotionThumb() {
  video.program = buildTemplateProgram();
  sizeCanvasForProgram();
  stopPreview();
  renderProgramFrame(0);
  $('#vpreview').classList.add('hidden');
  $('#vcanvas').classList.remove('hidden');
  $('#vstatus').textContent = `${video.program.width}×${video.program.height} · ${video.program.duration}s — ▶ Preview loops it, ⏺ Render exports a file`;
}

['vg-template', 'vg-size', 'vg-text1', 'vg-text2', 'vg-accent', 'vg-dur'].forEach((id) => {
  $(`#${id}`).addEventListener('input', refreshMotionThumb);
  $(`#${id}`).addEventListener('change', refreshMotionThumb);
});
$('#vg-play').addEventListener('click', () => { refreshMotionThumb(); previewProgram(); });
$('#vg-record').addEventListener('click', () => { refreshMotionThumb(); renderProgramVideo($('#vg-audio').files[0]); });
$('#vg-json').addEventListener('click', () => {
  video.program = buildTemplateProgram();
  $$('.vse-tab').forEach((x) => x.classList.toggle('active', x.dataset.vtab === 'anim'));
  $('#vpanel-motion').classList.add('hidden');
  $('#vpanel-edit').classList.add('hidden');
  $('#vpanel-anim').classList.remove('hidden');
  $('#vp-json').value = JSON.stringify(video.program, null, 2);
});

$('#vp-load').addEventListener('click', loadProgramFromJson);
$('#vp-play').addEventListener('click', () => { loadProgramFromJson(); previewProgram(); });
$('#vp-record').addEventListener('click', () => { loadProgramFromJson(); renderProgramVideo($('#vp-audio').files[0]); });
$('#vp-from-artifact').addEventListener('click', async () => {
  try {
    const { artifacts } = await api('/api/artifacts');
    const latest = artifacts.find((a) => a.type === 'video-program');
    if (!latest) { toast('No video programs yet — ask the agent for one in chat'); return; }
    const { artifact } = await api(`/api/artifacts/${latest.id}`);
    $('#vp-json').value = artifact.content || '';
    loadProgramFromJson();
    toast(`Loaded "${artifact.title}"`);
  } catch (err) { toast(err.message); }
});

$('#ve-files').addEventListener('change', (e) => loadClips([...e.target.files]));
$('#ve-record').addEventListener('click', exportEdited);

// ---------------- Python Lab (real Python in the browser via Pyodide) ----------------
// Claude and Z.ai both ship a Python sandbox; Cloudflare Workers cannot run
// Python server-side, so we run it client-side (WebAssembly) instead.

let pyodide = null, pyodideLoading = null;

function loadPyodideRuntime() {
  if (pyodide) return Promise.resolve(pyodide);
  if (pyodideLoading) return pyodideLoading;
  pyodideLoading = new Promise((resolve, reject) => {
    $('#py-status').textContent = 'Downloading the Python runtime (~10 MB, one time)…';
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
    s.onload = async () => {
      try {
        pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
        $('#py-status').textContent = 'Python ready — session keeps variables between runs';
        resolve(pyodide);
      } catch (err) { pyodideLoading = null; reject(err); }
    };
    s.onerror = () => { pyodideLoading = null; reject(new Error('Could not download the Python runtime — check your internet')); };
    document.head.appendChild(s);
  });
  return pyodideLoading;
}

async function runPython() {
  const btn = $('#py-run');
  if (btn.disabled) return;
  const code = $('#py-code').value;
  if (!code.trim()) { toast('Type some Python first'); return; }
  btn.disabled = true;
  $('#py-output').textContent = 'Running…';
  let printed = '';
  try {
    const py = await loadPyodideRuntime();
    py.runPython('import sys, io\nsys.stdout = io.StringIO()\nsys.stderr = sys.stdout');
    let result = null;
    try { result = await py.runPythonAsync(code); }
    finally { printed = py.runPython('sys.stdout.getvalue()'); }
    let out = printed;
    if (result != null && typeof result.toString === 'function') {
      const repr = String(result);
      if (repr && !out.includes(repr)) out += (out ? '\n' : '') + `=> ${repr}`;
    }
    $('#py-output').textContent = out.trim() || '(no output — add print() to see results)';
    $('#py-status').textContent = `Done at ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $('#py-output').textContent = (printed ? printed + '\n\n' : '') + '⛔ ' + String(err.message || err);
    $('#py-status').textContent = 'Error';
  } finally { btn.disabled = false; }
}

$('#py-run').addEventListener('click', runPython);
$('#py-clear').addEventListener('click', () => { $('#py-output').textContent = 'Output appears here…'; });

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
