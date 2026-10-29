// UI controller: sessions, streaming, tool cards, notes, settings, loader.
import { MODELS, STORAGE } from './config.js';
import { Engine, describeDevice } from './model.js';
import { Agent } from './agent.js';
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const engine = new Engine();
let settings = store.getSettings();
let sessions = store.getSessions();
let activeId = store.getActiveId();
let running = false;
let pendingPrompt = null;
let currentAgent = null;

/* ── tiny markdown renderer ─────────────────────────────── */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function md(text) {
  const blocks = [];
  let s = escapeHtml(text || '');
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = s.split('\n');
  let html = '';
  let list = null;
  const closeList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };

  for (const line of lines) {
    if (/^\u0000\d+\u0000$/.test(line.trim())) {
      closeList();
      html += line.trim();
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${ul[1]}</li>`;
      continue;
    }
    if (ol) {
      if (list !== 'ol') {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${ol[1]}</li>`;
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (/^#{1,4}\s/.test(line)) {
      html += `<h3>${line.replace(/^#{1,4}\s+/, '')}</h3>`;
      continue;
    }
    html += `<p>${line}</p>`;
  }
  closeList();

  s = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  return s || '<p></p>';
}

/* ── icons ──────────────────────────────────────────────── */
const ICONS = {
  search: '<path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h11v18H6a2 2 0 0 1-2-2z"/><path d="M9 3v18"/>',
  note: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 4l-2 16"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const svgIcon = (name) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.note}</svg>`;

/* ── toast ──────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ── sessions ───────────────────────────────────────────── */
const newSession = () => ({
  id: 's_' + Date.now().toString(36),
  title: 'New session',
  messages: [],
  created: Date.now(),
});

function activeSession() {
  let s = sessions.find((x) => x.id === activeId);
  if (!s) {
    s = sessions[0] || newSession();
    if (!sessions.length) sessions.push(s);
    activeId = s.id;
  }
  return s;
}

function persist() {
  store.saveSessions(sessions);
  store.setActiveId(activeId);
}

function renderSidebar() {
  const list = $('#chatList');
  list.innerHTML = '';
  sessions.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'chat-item' + (s.id === activeId ? ' active' : '');
    el.innerHTML = `<span></span><button class="del" title="Delete">×</button>`;
    $('span', el).textContent = s.title || 'Session';
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) {
        sessions = sessions.filter((x) => x.id !== s.id);
        if (activeId === s.id) activeId = sessions[0]?.id || null;
        persist();
        renderSidebar();
        renderMessages();
        return;
      }
      activeId = s.id;
      persist();
      renderSidebar();
      renderMessages();
      closeSidebar();
    });
    list.appendChild(el);
  });
}

/* ── message rendering ──────────────────────────────────── */
function toolCard(step) {
  const meta = step.meta || { label: step.name, icon: 'note' };
  const wrap = document.createElement('div');
  wrap.className = 'tool';
  wrap.dataset.id = step.id || '';
  const argText = (() => {
    const a = step.args || {};
    const first = a.query || a.url || a.title || a.code || a.target || a.app || '';
    return String(first).replace(/\s+/g, ' ').slice(0, 90);
  })();
  wrap.innerHTML = `
    <div class="tool-head">
      <span class="tool-ico">${svgIcon(meta.icon)}</span>
      <span class="tool-name">${escapeHtml(meta.label || step.name)}</span>
      <span class="tool-arg">${escapeHtml(argText)}</span>
      <span class="tool-state ${step.state || 'run'}">${step.state === 'ok' ? 'done' : step.state === 'err' ? 'failed' : 'running'}</span>
    </div>`;
  const out = document.createElement('div');
  out.className = 'tool-out' + (step.state ? ' hidden' : '');
  out.textContent = step.output || '';
  wrap.appendChild(out);
  wrap.querySelector('.tool-head').addEventListener('click', () => {
    if (out.textContent) out.classList.toggle('hidden');
  });
  if (step.launch) {
    const a = document.createElement('a');
    a.className = 'applaunch';
    a.href = step.launch.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `Open ${escapeHtml(step.launch.label)} →`;
    wrap.appendChild(a);
  }
  return wrap;
}

const emptyTemplate = $('#empty').cloneNode(true);

function bindSuggests(root) {
  $$('.sug', root).forEach((b) => b.addEventListener('click', () => send(b.dataset.prompt)));
}

function renderMessages() {
  const box = $('#messages');
  const session = activeSession();
  box.innerHTML = '';
  if (!session.messages.length) {
    const empty = emptyTemplate.cloneNode(true);
    box.appendChild(empty);
    bindSuggests(empty);
    paintEngine(engine.ready ? 'ready' : 'idle');
    return;
  }
  session.messages.forEach((m) => box.appendChild(messageNode(m)));
  scrollDown();
}

function messageNode(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot');
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = m.role === 'user' ? 'Y' : 'L3';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = `<div class="msg-role">${m.role === 'user' ? 'you' : 'lfm3 os'}</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'user') {
    bubble.innerHTML = md(m.content);
  } else {
    (m.steps || []).forEach((s) => body.appendChild(toolCard(s)));
    if (m.thinking) {
      const d = document.createElement('details');
      d.className = 'thinking';
      d.innerHTML = `<summary>thinking</summary><div>${escapeHtml(m.thinking)}</div>`;
      body.appendChild(d);
    }
    bubble.innerHTML = md(m.content);
  }
  body.appendChild(bubble);
  wrap.appendChild(av);
  wrap.appendChild(body);
  return wrap;
}

function scrollDown() {
  const box = $('#messages');
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}

/* ── engine state → UI ──────────────────────────────────── */
function paintEngine(state) {
  const dot = $('#engineDot');
  const name = $('#modelName');
  const sub = $('#modelState');
  dot.className = 'dot' + (state === 'ready' ? ' on' : state === 'busy' ? ' busy' : '');
  name.textContent = engine.config?.label || MODELS.find((m) => m.id === settings.modelId)?.label || 'no model';
  sub.textContent = state === 'ready' ? 'ready' : state === 'busy' ? 'generating' : 'not loaded';
  $('#footInfo').textContent = engine.ready
    ? `${engine.config.label} · local${navigator.gpu ? ' · WebGPU' : ' · WASM'}`
    : 'Local inference · model not loaded';
  $('#emptyNote').textContent = engine.ready
    ? 'Model ready. It runs here, in this tab.'
    : 'Load the model to begin. One download, then it works offline.';
}

function setStatus(text) {
  const el = $('#agentStatus');
  el.innerHTML = text ? `<span class="sp"></span>${escapeHtml(text)}` : '';
}

/* ── loader overlay ─────────────────────────────────────── */
function openLoader() {
  const overlay = $('#loaderOverlay');
  overlay.hidden = false;
  $('#deviceInfo').textContent = describeDevice();
  $('#loaderBar').style.width = '0%';
  $('#loaderMeta').textContent = 'idle';
  renderModelList();
}

function renderModelList() {
  const box = $('#modelList');
  box.innerHTML = '';
  MODELS.forEach((m) => {
    const el = document.createElement('div');
    el.className = 'model-opt' + (m.id === settings.modelId ? ' sel' : '');
    el.innerHTML = `<div class="t"><span>${escapeHtml(m.label)}</span><em>${m.badge || ''}</em></div>
      <div class="d">${escapeHtml(m.blurb)}<br>download ${m.size} · needs ${m.ram} free</div>`;
    el.addEventListener('click', () => {
      settings = store.saveSettings({ modelId: m.id });
      renderModelList();
      const cfg = MODELS.find((x) => x.id === settings.modelId);
      $('#loaderTitle').textContent = 'Load ' + cfg.label;
      $('#loaderSize').textContent = cfg.size;
      $('#loaderText').innerHTML = `Weights download once (<span>${cfg.size}</span>) and stay cached in your browser.`;
      paintEngine('idle');
    });
    box.appendChild(el);
  });
  const cfg = MODELS.find((x) => x.id === settings.modelId) || MODELS[0];
  $('#loaderSize').textContent = cfg.size;
  $('#loaderTitle').textContent = 'Load ' + cfg.label;
  $('#loaderText').innerHTML = `Weights download once (<span>${cfg.size}</span>) and stay cached in your browser.`;
}

async function loadModel() {
  const btn = $('#btnDownload');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  const bar = $('#loaderBar');
  const meta = $('#loaderMeta');
  try {
    const { device } = await engine.load(settings.modelId, {
      onPhase: (phase) => {
        meta.textContent = phase;
      },
      onProgress: (p) => {
        bar.style.width = p.percent + '%';
        meta.textContent = `${p.percent}% · ${p.file ? p.file.split('/').pop() : ''} · ${(p.loaded / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB`;
      },
    });
    paintEngine('ready');
    meta.textContent = `ready on ${device}`;
    toast('Model loaded. It stays cached in this browser.');
    $('#loaderOverlay').hidden = true;
    if (pendingPrompt) {
      const p = pendingPrompt;
      pendingPrompt = null;
      send(p);
    }
  } catch (e) {
    meta.textContent = 'failed: ' + (e.message || e);
    toast('Could not load the model: ' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download and start';
  }
}

/* ── sending ────────────────────────────────────────────── */
function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
}

async function send(text) {
  text = (text || '').trim();
  if (!text || running) return;

  if (!engine.ready) {
    pendingPrompt = text;
    openLoader();
    toast('Load the model first. It downloads once, then runs offline.');
    return;
  }

  running = true;
  $('#btnSend').disabled = true;
  $('#btnSend').hidden = true;
  $('#btnStop').hidden = false;
  $('#input').value = '';
  autoGrow();

  const session = activeSession();
  if (session.title === 'New session') {
    session.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
    renderSidebar();
  }
  session.messages.push({ role: 'user', content: text, ts: Date.now() });

  const box = $('#messages');
  if (session.messages.length === 1) box.innerHTML = '';
  box.appendChild(messageNode(session.messages[session.messages.length - 1]));
  scrollDown();

  // assistant placeholder
  const node = document.createElement('div');
  node.className = 'msg bot';
  node.innerHTML = `<div class="avatar">L3</div><div class="msg-body"><div class="msg-role">lfm3 os</div></div>`;
  const bodyEl = $('.msg-body', node);
  box.appendChild(node);
  scrollDown();

  let liveText = '';
  let liveEl = document.createElement('div');
  liveEl.className = 'thinking';
  liveEl.innerHTML = '<summary style="display:none"></summary><div></div>';
  bodyEl.appendChild(liveEl);
  const liveBody = $('div', liveEl);

  const steps = [];
  let thinkBuf = '';

  currentAgent = new Agent(engine, () => settings, {
    onStatus: (s) => setStatus(s),
    onToken: (chunk, raw) => {
      thinkBuf = raw;
      if (settings.thinking) liveBody.textContent = raw.slice(-1400);
      scrollDown();
    },
    onTool: (ev) => {
      if (ev.state === 'run') {
        const card = toolCard(ev);
        bodyEl.insertBefore(card, liveEl);
      } else {
        // replace matching running card
        const cards = $$('.tool', bodyEl);
        let target = null;
        for (let i = cards.length - 1; i >= 0; i--) {
          if ($('.tool-state', cards[i]).classList.contains('run')) {
            target = cards[i];
            break;
          }
        }
        const fresh = toolCard(ev);
        if (target) target.replaceWith(fresh);
        else bodyEl.insertBefore(fresh, liveEl);
      }
      scrollDown();
    },
    onNote: () => {
      renderNotes();
      toast('Note saved');
    },
    onError: (e) => toast(e.message || String(e)),
  });

  let result;
  try {
    const history = [];
    session.messages.slice(0, -1).forEach((m) => {
      if (m.role === 'user' || m.role === 'assistant') history.push({ role: m.role, content: m.content });
    });
    history.push({ role: 'user', content: text });
    result = await currentAgent.run(history);
  } catch (e) {
    result = { final: 'Something broke: ' + (e.message || e), steps: [] };
  }

  liveEl.remove();
  setStatus('');

  const thinkingMatch = thinkBuf.match(/<think[^>]*>([\s\S]*?)(<\/think>|$)/i);
  const assistantMsg = {
    role: 'assistant',
    content: result.final || '(no answer)',
    steps: result.steps || [],
    thinking: thinkingMatch ? thinkingMatch[1].trim().slice(0, 3000) : '',
    ts: Date.now(),
  };
  session.messages.push(assistantMsg);
  persist();
  renderMessages();
  renderSidebar();

  running = false;
  $('#btnSend').hidden = false;
  $('#btnSend').disabled = false;
  $('#btnStop').hidden = true;
  currentAgent = null;
}

/* ── notes panel ────────────────────────────────────────── */
function renderNotes(query = $('#noteSearch').value) {
  const list = $('#noteList');
  const notes = store.listNotes(query);
  $('#notesCount').textContent = store.countNotes();
  list.innerHTML = '';
  if (!notes.length) {
    list.innerHTML = '<p class="hint">No notes yet. Ask the agent to remember something, or add one here.</p>';
    return;
  }
  notes.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'note';
    el.innerHTML = `<div class="nh"><div class="nt">${escapeHtml(n.title)}</div><button class="nact" title="Delete">×</button></div>
      <div class="nb">${escapeHtml(n.body)}</div>
      <div class="nm"><span>${new Date(n.created).toLocaleString()}</span>
      ${(n.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      ${n.source === 'agent' ? '<span class="tag">agent</span>' : ''}</div>`;
    $('.nact', el).addEventListener('click', () => {
      store.deleteNote(n.id);
      renderNotes();
      toast('Note deleted');
    });
    list.appendChild(el);
  });
}

/* ── panel ──────────────────────────────────────────────── */
function openPanel(tab = 'notes') {
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $$('.panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel-page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab));
  if (tab === 'notes') renderNotes();
  if (tab === 'settings') syncSettings();
}

function closePanel() {
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#backdrop').classList.add('show');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('show');
}

/* ── settings binding ───────────────────────────────────── */
function syncSettings() {
  $('#permNotesRead').checked = !!settings.perms.notesRead;
  $('#permNotesWrite').checked = !!settings.perms.notesWrite;
  $('#permAppsOpen').checked = !!settings.perms.appsOpen;
  $('#permMessages').checked = !!settings.perms.messages;
  $('#permCalls').checked = !!settings.perms.calls;
  $('#setTemp').value = settings.temperature;
  $('#setTempVal').textContent = settings.temperature.toFixed(2);
  $('#setMaxTok').value = settings.maxTokens;
  $('#setMaxTokVal').textContent = settings.maxTokens;
  $('#setSteps').value = settings.maxSteps;
  $('#setStepsVal').textContent = settings.maxSteps;
  $('#setThinking').checked = !!settings.thinking;
  $('#setSearchProxy').value = settings.searchProxy || '';
  $('#setTavily').value = settings.tavilyKey || '';
  renderModelList();
}

function bindSettings() {
  const permBoxes = {
    permNotesRead: 'notesRead',
    permNotesWrite: 'notesWrite',
    permAppsOpen: 'appsOpen',
    permMessages: 'messages',
    permCalls: 'calls',
  };
  Object.entries(permBoxes).forEach(([id, key]) => {
    $('#' + id).addEventListener('change', (e) => {
      settings = store.saveSettings({ perms: { ...settings.perms, [key]: e.target.checked } });
      toast(`${key} ${e.target.checked ? 'allowed' : 'blocked'}`);
    });
  });

  $('#setTemp').addEventListener('input', (e) => {
    settings = store.saveSettings({ temperature: parseFloat(e.target.value) });
    $('#setTempVal').textContent = settings.temperature.toFixed(2);
  });
  $('#setMaxTok').addEventListener('input', (e) => {
    settings = store.saveSettings({ maxTokens: parseInt(e.target.value, 10) });
    $('#setMaxTokVal').textContent = settings.maxTokens;
  });
  $('#setSteps').addEventListener('input', (e) => {
    settings = store.saveSettings({ maxSteps: parseInt(e.target.value, 10) });
    $('#setStepsVal').textContent = settings.maxSteps;
  });
  $('#setThinking').addEventListener('change', (e) => {
    settings = store.saveSettings({ thinking: e.target.checked });
  });
  $('#setSearchProxy').addEventListener('change', (e) => {
    settings = store.saveSettings({ searchProxy: e.target.value.trim() });
    toast('Search proxy saved');
  });
  $('#setTavily').addEventListener('change', (e) => {
    settings = store.saveSettings({ tavilyKey: e.target.value.trim() });
    toast('Tavily key saved on this device');
  });
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lfm3-os-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('Delete all sessions and notes on this device? This cannot be undone.')) return;
    store.wipeAll();
    sessions = [];
    activeId = null;
    settings = store.getSettings();
    renderSidebar();
    renderMessages();
    renderNotes();
    syncSettings();
    toast('Everything local was deleted');
  });
}

/* ── wiring ─────────────────────────────────────────────── */
function bind() {
  $('#btnNew').addEventListener('click', () => {
    const s = newSession();
    sessions.unshift(s);
    activeId = s.id;
    persist();
    renderSidebar();
    renderMessages();
    closeSidebar();
  });

  $('#input').addEventListener('input', autoGrow);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send($('#input').value);
    }
  });
  $('#btnSend').addEventListener('click', () => send($('#input').value));
  $('#btnStop').addEventListener('click', () => {
    currentAgent?.cancel();
    setStatus('stopping…');
  });
  $('#btnClear').addEventListener('click', () => {
    const s = activeSession();
    s.messages = [];
    s.title = 'New session';
    persist();
    renderMessages();
    renderSidebar();
  });

  $('#btnMenu').addEventListener('click', openSidebar);
  $('#backdrop').addEventListener('click', closeSidebar);
  $('#btnTools').addEventListener('click', () => openPanel('notes'));
  $('#btnPanelClose').addEventListener('click', closePanel);
  $('#btnLoad').addEventListener('click', openLoader);
  $('#modelChip').addEventListener('click', openLoader);
  $('#btnLoaderClose').addEventListener('click', () => ($('#loaderOverlay').hidden = true));
  $('#btnDownload').addEventListener('click', loadModel);

  $$('.panel-tab').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.panel-tab').forEach((x) => x.classList.toggle('active', x === b));
      $$('.panel-page').forEach((p) => p.classList.toggle('active', p.dataset.page === b.dataset.tab));
      if (b.dataset.tab === 'notes') renderNotes();
      if (b.dataset.tab === 'settings') syncSettings();
    })
  );

  $$('[data-panel]').forEach((b) =>
    b.addEventListener('click', () => {
      openPanel(b.dataset.panel);
      closeSidebar();
    })
  );

  $('#btnAddNote').addEventListener('click', () => {
    const title = $('#noteTitle').value.trim();
    const body = $('#noteBody').value.trim();
    if (!title && !body) return toast('Write something first');
    store.addNote({ title: title || body.slice(0, 40), body, tags: ['manual'] });
    $('#noteTitle').value = '';
    $('#noteBody').value = '';
    renderNotes();
    toast('Note saved');
  });
  $('#noteSearch').addEventListener('input', (e) => renderNotes(e.target.value));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePanel();
      closeSidebar();
      if (!$('#loaderOverlay').hidden) $('#loaderOverlay').hidden = true;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ── boot ───────────────────────────────────────────────── */
function boot() {
  if (!sessions.length) {
    const s = newSession();
    sessions.push(s);
    activeId = s.id;
    persist();
  }
  bind();
  bindSettings();
  renderSidebar();
  renderMessages();
  renderNotes();
  syncSettings();
  paintEngine(engine.ready ? 'ready' : 'idle');
  if (!navigator.gpu) {
    $('#emptyNote').textContent = 'WebGPU is not available in this browser. Loading will fall back to WASM and be very slow.';
  }
}

boot();
