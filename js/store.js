// Small persistence layer. Everything stays on this device.
import { DEFAULT_SETTINGS, STORAGE } from './config.js';

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

/* ── settings ─────────────────────────────────────────── */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(STORAGE.settings, {}) };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write(STORAGE.settings, next);
  return next;
}

/* ── sessions ─────────────────────────────────────────── */
export function getSessions() {
  return read(STORAGE.sessions, []);
}
export function saveSessions(sessions) {
  // Keep storage sane: 40 sessions, 200 messages each.
  const trimmed = sessions.slice(0, 40).map((s) => ({
    ...s,
    messages: (s.messages || []).slice(-200),
  }));
  write(STORAGE.sessions, trimmed);
}
export function getActiveId() {
  return read(STORAGE.active, null);
}
export function setActiveId(id) {
  write(STORAGE.active, id);
}

/* ── notes ────────────────────────────────────────────── */
export function listNotes(query = '') {
  const notes = read(STORAGE.notes, []);
  const q = query.trim().toLowerCase();
  const sorted = notes.sort((a, b) => b.created - a.created);
  if (!q) return sorted;
  return sorted.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.body.toLowerCase().includes(q) ||
      (n.tags || []).some((t) => t.toLowerCase().includes(q))
  );
}

export function addNote({ title, body, tags = [], source = 'user' }) {
  const notes = read(STORAGE.notes, []);
  const note = {
    id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: (title || 'Untitled').slice(0, 140),
    body: (body || '').slice(0, 8000),
    tags: (tags || []).slice(0, 6),
    source,
    created: Date.now(),
  };
  notes.push(note);
  write(STORAGE.notes, notes.slice(-500));
  return note;
}

export function deleteNote(id) {
  const notes = read(STORAGE.notes, []).filter((n) => n.id !== id);
  write(STORAGE.notes, notes);
  return true;
}

export function countNotes() {
  return read(STORAGE.notes, []).length;
}

export function exportAll() {
  return {
    exported_at: new Date().toISOString(),
    app: 'LFM3 OS',
    settings: getSettings(),
    notes: read(STORAGE.notes, []),
    sessions: getSessions(),
  };
}

export function wipeAll() {
  Object.values(STORAGE).forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
}
