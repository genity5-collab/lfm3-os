// Tool implementations. Everything runs locally except web_search / web_read,
// which call public read endpoints from the browser.
import { addNote, listNotes } from './store.js';

const enc = encodeURIComponent;

/* ── web: search ─────────────────────────────────────────── */

const READER = 'https://r.jina.ai/';

function unwrapDdg(url) {
  const m = url.match(/[?&]uddg=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : url;
}

function parseDdg(text, limit = 6) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const m = lines[i].match(/^\s*\d+\.\s*\[(.+?)\]\((https?:\/\/[^\s)]+)\)/);
    if (!m) continue;
    const clean = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    let snippet = clean(lines[i + 1] || '');
    if (!snippet || /^https?:/.test(snippet)) snippet = clean(lines[i + 2] || '');
    out.push({ title: clean(m[1]), url: unwrapDdg(m[2]), snippet: snippet.slice(0, 240) });
  }
  return out;
}

async function ddgSearch(query) {
  const target = `https://lite.duckduckgo.com/lite/?q=${enc(query)}`;
  const res = await fetch(READER + target, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error('reader HTTP ' + res.status);
  const md = await res.text();
  const hits = parseDdg(md);
  if (!hits.length) throw new Error('no results parsed');
  return hits;
}

async function wikiSearch(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(
    query
  )}&srlimit=4&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('wiki HTTP ' + res.status);
  const data = await res.json();
  return (data?.query?.search || []).map((r) => ({
    title: r.title,
    url: 'https://en.wikipedia.org/wiki/' + enc(r.title.replace(/ /g, '_')),
    snippet: String(r.snippet || '').replace(/<[^>]+>/g, '').slice(0, 240),
  }));
}

async function tavilySearch(query, key) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 6, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error('tavily HTTP ' + res.status);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content || '').slice(0, 240),
  }));
}

async function proxySearch(query, proxyUrl) {
  const res = await fetch(`${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}q=${enc(query)}`);
  if (!res.ok) throw new Error('proxy HTTP ' + res.status);
  const data = await res.json();
  const rows = data.results || data.organic || [];
  return rows.slice(0, 6).map((r) => ({
    title: r.title || r.name || r.url,
    url: r.url || r.link,
    snippet: (r.snippet || r.content || r.description || '').slice(0, 240),
  }));
}

export async function webSearch(query, settings) {
  const attempts = [];
  if (settings.searchProxy) attempts.push(['your proxy', () => proxySearch(query, settings.searchProxy.trim())]);
  if (settings.tavilyKey) attempts.push(['tavily', () => tavilySearch(query, settings.tavilyKey.trim())]);
  attempts.push(['duckduckgo', () => ddgSearch(query)]);
  attempts.push(['wikipedia', () => wikiSearch(query)]);

  const errors = [];
  for (const [name, run] of attempts) {
    try {
      const hits = await run();
      if (hits.length) return { via: name, hits };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { via: null, hits: [], errors };
}

/* ── web: read ───────────────────────────────────────────── */

export async function webRead(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http');
  const res = await fetch(READER + url, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error('reader HTTP ' + res.status);
  const text = await res.text();
  const body = text
    .replace(/^(Title|URL Source|Published Time|Markdown Content):.*\n/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body.slice(0, 5000);
}

/* ── code sandbox ────────────────────────────────────────── */

export function runCode(code, timeout = 4000) {
  return new Promise((resolve) => {
    const src =
      "const logs=[];\n" +
      "const fmt=(v)=>{try{return typeof v==='string'?v:JSON.stringify(v,null,1)}catch(e){return String(v)}};\n" +
      "self.console={log:(...a)=>logs.push(a.map(fmt).join(' ')),error:(...a)=>logs.push('Error: '+a.map(fmt).join(' ')),warn:(...a)=>logs.push('warn: '+a.map(fmt).join(' ')),info:(...a)=>logs.push(a.map(fmt).join(' '))};\n" +
      "self.fetch=undefined;self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.importScripts=undefined;self.indexedDB=undefined;self.caches=undefined;\n" +
      'self.onmessage=async()=>{\n' +
      '  let result=null,error=null;\n' +
      '  try{ result = await (async()=>{\n' +
      code +
      '\n})(); }catch(e){ error=(e&&e.message)||String(e); }\n' +
      "  self.postMessage({logs, result: result===undefined?null:fmt(result), error});\n" +
      '};';

    const blob = new Blob([src], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    let done = false;

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      resolve(payload);
    };

    const timer = setTimeout(() => finish({ logs: [], result: null, error: `timed out after ${timeout}ms` }), timeout);

    worker.onmessage = (e) => finish(e.data);
    worker.onerror = (e) => finish({ logs: [], result: null, error: e.message || 'script error' });
    worker.postMessage(null);
  });
}

/* ── phone deep links ────────────────────────────────────── */

const APPS = {
  youtube: {
    label: 'YouTube',
    build: (t) => (t ? `https://www.youtube.com/results?search_query=${enc(t)}` : 'https://www.youtube.com'),
  },
  maps: {
    label: 'Maps',
    build: (t) => (t ? `https://www.google.com/maps/search/?api=1&query=${enc(t)}` : 'https://www.google.com/maps'),
  },
  whatsapp: {
    label: 'WhatsApp',
    build: (t) => {
      if (!t) return 'https://web.whatsapp.com';
      const digits = t.replace(/[^\d]/g, '');
      return digits.length > 6
        ? `https://wa.me/${digits}`
        : `https://wa.me/?text=${enc(t)}`;
    },
  },
  phone: {
    label: 'Phone',
    build: (t) => (t ? `tel:${t.replace(/[^\d+*#]/g, '')}` : 'tel:'),
  },
  sms: {
    label: 'Messages',
    build: (t) => (t ? `sms:?&body=${enc(t)}` : 'sms:'),
  },
  mail: {
    label: 'Mail',
    build: (t) =>
      t && t.includes('@')
        ? `mailto:${t}`
        : `mailto:?subject=${enc(t || '')}`,
  },
  spotify: {
    label: 'Spotify',
    build: (t) => (t ? `https://open.spotify.com/search/${enc(t)}` : 'https://open.spotify.com'),
  },
  calendar: {
    label: 'Calendar',
    build: (t) =>
      `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(t || 'New event')}`,
  },
  browser: {
    label: 'Browser',
    build: (t) => (/^https?:\/\//i.test(t || '') ? t : `https://duckduckgo.com/?q=${enc(t || '')}`),
  },
};

export function openApp(app, target) {
  const key = String(app || '').toLowerCase().trim();
  const entry = APPS[key];
  if (!entry) {
    return {
      error: `unknown app "${app}". Available: ${Object.keys(APPS).join(', ')}`,
    };
  }
  return { label: entry.label, url: entry.build(target || ''), app: key };
}

/* ── contacts: text and call ─────────────────────────────── */

const digitsOf = (to) => String(to || '').replace(/[^\d+]/g, '');

export function messageContact(to, text, via) {
  const digits = digitsOf(to);
  const body = String(text || '').slice(0, 900);
  const channel = String(via || 'whatsapp').toLowerCase() === 'sms' ? 'sms' : 'whatsapp';

  if (channel === 'sms') {
    return {
      label: 'Messages',
      channel,
      url: `sms:${digits}?&body=${enc(body)}`,
      note: digits ? undefined : 'No number given, so the user picks the contact.',
    };
  }
  return {
    label: 'WhatsApp',
    channel,
    url: digits.length > 6 ? `https://wa.me/${digits.replace(/\D/g, '')}?text=${enc(body)}` : `https://wa.me/?text=${enc(body)}`,
    note: digits.length > 6 ? undefined : 'No number given, so the user picks the contact.',
  };
}

export function callContact(to) {
  const digits = digitsOf(to);
  if (!digits || digits.replace(/\D/g, '').length < 4) {
    return {
      error:
        'no usable phone number. Browsers cannot read the user\'s contacts, so ask for the number first.',
    };
  }
  return { label: 'Call ' + digits, url: `tel:${digits}` };
}

/* ── time ────────────────────────────────────────────────── */

export function getTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toString(),
    date: now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/* ── dispatcher ──────────────────────────────────────────── */

export const TOOL_META = {
  web_search: { label: 'Web search', icon: 'search' },
  web_read: { label: 'Read page', icon: 'book' },
  note_save: { label: 'Save note', icon: 'note' },
  note_list: { label: 'Read notes', icon: 'note' },
  message_contact: { label: 'Text contact', icon: 'phone' },
  call_contact: { label: 'Call contact', icon: 'phone' },
  code_run: { label: 'Run code', icon: 'code' },
  open_app: { label: 'Open app', icon: 'phone' },
  get_time: { label: 'Clock', icon: 'clock' },
};

const PERMISSION_FOR = {
  note_save: ['notesWrite', 'writing notes'],
  note_list: ['notesRead', 'reading notes'],
  open_app: ['appsOpen', 'opening apps'],
  message_contact: ['messages', 'sending messages'],
  call_contact: ['calls', 'calling'],
};

const DENY_NOTE =
  'permission denied. Tell the user to enable this in Settings, under Permissions. Do not retry.';

export async function callTool(name, args = {}, settings = {}) {
  const gate = PERMISSION_FOR[name];
  if (gate) {
    const perms = settings.perms || {};
    if (!perms[gate[0]]) {
      return { text: `error: ${gate[1]} is not allowed on this device. ${DENY_NOTE}`, denied: true };
    }
  }

  switch (name) {
    case 'web_search': {
      if (!args.query) return { text: 'error: query is required' };
      const { via, hits, errors } = await webSearch(args.query, settings);
      if (!hits.length) {
        return { text: `error: no results${errors && errors.length ? ' (' + errors.join('; ') + ')' : ''}` };
      }
      const text = hits
        .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`)
        .join('\n\n');
      return { text: `source: ${via}\n\n${text}`, data: { via, hits } };
    }

    case 'web_read': {
      if (!args.url) return { text: 'error: url is required' };
      const body = await webRead(args.url);
      return { text: body || 'error: page returned no text', data: { url: args.url } };
    }

    case 'note_save': {
      const note = addNote({
        title: args.title || (args.body || '').slice(0, 60) || 'Note',
        body: args.body || '',
        tags: Array.isArray(args.tags) ? args.tags : args.tags ? [String(args.tags)] : [],
        source: 'agent',
      });
      return { text: `saved note ${note.id}: ${note.title}`, data: { note }, event: 'notes' };
    }

    case 'note_list': {
      const notes = listNotes(args.query || '').slice(0, 8);
      if (!notes.length) return { text: 'no notes found' };
      return {
        text: notes.map((n) => `[${n.id}] ${n.title} — ${n.body.slice(0, 180)}`).join('\n'),
        data: { notes },
      };
    }

    case 'code_run': {
      if (!args.code) return { text: 'error: code is required' };
      const out = await runCode(args.code);
      const parts = [];
      if (out.logs && out.logs.length) parts.push(out.logs.join('\n'));
      if (out.result !== null && out.result !== undefined) parts.push('returned: ' + out.result);
      if (out.error) parts.push('error: ' + out.error);
      return { text: parts.join('\n') || 'ran with no output', data: out };
    }

    case 'open_app': {
      const res = openApp(args.app, args.target);
      if (res.error) return { text: res.error };
      return {
        text: `ready: ${res.label} link built (${res.url}). The user must tap it to launch the app.`,
        data: res,
        launch: res,
      };
    }

    case 'message_contact': {
      const res = messageContact(args.to, args.text, args.via);
      return {
        text: `ready: a ${res.label} message is written${res.note ? ' (' + res.note + ')' : ''}. The user must tap the link to send it. Nothing is sent automatically.`,
        data: res,
        launch: res,
      };
    }

    case 'call_contact': {
      const res = callContact(args.to);
      if (res.error) return { text: 'error: ' + res.error };
      return {
        text: `ready: call link for ${res.label}. The user must tap it to dial; web pages cannot place or answer calls by themselves.`,
        data: res,
        launch: res,
      };
    }

    case 'get_time':
      return { text: JSON.stringify(getTime()) };

    default:
      return { text: `error: unknown tool "${name}". Use one of: ${Object.keys(TOOL_META).join(', ')}` };
  }
}
