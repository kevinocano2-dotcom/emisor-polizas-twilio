import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureData();
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureData();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getLastFolioNumber() {
  const initial = Number(process.env.LAST_FOLIO_NUMBER || 981);
  return Number(readJson(COUNTER_FILE, { last: initial }).last || initial);
}

export function setLastFolioNumber(n) {
  writeJson(COUNTER_FILE, { last: Number(n), updatedAt: new Date().toISOString() });
}

export function nextFolioNumber() {
  const next = getLastFolioNumber() + 1;
  setLastFolioNumber(next);
  return next;
}

export function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

export function saveSessions(sessions) {
  writeJson(SESSIONS_FILE, sessions);
}

export function getSession(phone) {
  const sessions = loadSessions();
  return sessions[phone] || null;
}

export function setSession(phone, session) {
  const sessions = loadSessions();
  sessions[phone] = { ...session, updatedAt: new Date().toISOString() };
  saveSessions(sessions);
}

export function clearSession(phone) {
  const sessions = loadSessions();
  delete sessions[phone];
  saveSessions(sessions);
}
