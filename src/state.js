import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const DATA_DIR = path.join(process.cwd(), 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POLICIES_FILE = path.join(DATA_DIR, 'policies.json');

let db = null;
let firebaseReady = false;

function initFirebase() {
  if (firebaseReady) return Boolean(db);
  firebaseReady = true;

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_CONFIG_JSON ||
    '';

  if (!raw) {
    console.warn('Firebase no configurado. Usando archivos locales temporales.');
    return false;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(parsed)
      });
    }

    db = admin.firestore();
    console.log('Firebase Firestore conectado.');
    return true;
  } catch (err) {
    console.error('No se pudo iniciar Firebase. Usando archivos locales temporales:', err.message);
    db = null;
    return false;
  }
}

function useFirebase() {
  return initFirebase() && db;
}

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

export function normalizePhone(value) {
  return String(value || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
}

export function storageMode() {
  return useFirebase() ? 'firebase' : 'local';
}

function initialLastFolio() {
  return Number(process.env.LAST_FOLIO_NUMBER || 981);
}

export async function getLastFolioNumber() {
  if (useFirebase()) {
    const ref = db.collection('settings').doc('counter');
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        last: initialLastFolio(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return initialLastFolio();
    }
    return Number(snap.data().last || initialLastFolio());
  }

  const initial = initialLastFolio();
  return Number(readJson(COUNTER_FILE, { last: initial }).last || initial);
}

export async function setLastFolioNumber(n) {
  const value = Number(n);
  if (useFirebase()) {
    await db.collection('settings').doc('counter').set({
      last: value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  writeJson(COUNTER_FILE, { last: value, updatedAt: new Date().toISOString() });
}

export async function nextFolioNumber() {
  if (useFirebase()) {
    const ref = db.collection('settings').doc('counter');
    return await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists ? Number(snap.data().last || initialLastFolio()) : initialLastFolio();
      const next = current + 1;
      tx.set(ref, {
        last: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return next;
    });
  }

  const next = await getLastFolioNumber() + 1;
  await setLastFolioNumber(next);
  return next;
}

export async function getSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    const snap = await db.collection('sessions').doc(clean).get();
    return snap.exists ? snap.data() : null;
  }

  const sessions = readJson(SESSIONS_FILE, {});
  return sessions[clean] || null;
}

export async function setSession(phone, session) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    await db.collection('sessions').doc(clean).set({
      ...session,
      phone: clean,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  const sessions = readJson(SESSIONS_FILE, {});
  sessions[clean] = { ...session, updatedAt: new Date().toISOString() };
  writeJson(SESSIONS_FILE, sessions);
}

export async function clearSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    await db.collection('sessions').doc(clean).delete().catch(() => {});
    return;
  }

  const sessions = readJson(SESSIONS_FILE, {});
  delete sessions[clean];
  writeJson(SESSIONS_FILE, sessions);
}

async function seedUsersIfNeededFirebase() {
  const marker = db.collection('settings').doc('seed');
  const snap = await marker.get();
  if (snap.exists && snap.data().usersSeeded) return;

  const raw = process.env.ALLOWED_NUMBERS || '';
  const batch = db.batch();
  let count = 0;
  for (const item of raw.split(',')) {
    const phone = normalizePhone(item);
    if (!phone) continue;
    batch.set(db.collection('users').doc(phone), {
      phone,
      name: '',
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    count += 1;
  }

  batch.set(marker, {
    usersSeeded: true,
    seededCount: count,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await batch.commit();
}

function seedUsersIfNeededLocal() {
  ensureData();
  if (fs.existsSync(USERS_FILE)) return;
  const raw = process.env.ALLOWED_NUMBERS || '';
  const users = {};
  for (const item of raw.split(',')) {
    const phone = normalizePhone(item);
    if (!phone) continue;
    users[phone] = {
      phone,
      name: '',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  writeJson(USERS_FILE, users);
}

export async function loadUsers() {
  if (useFirebase()) {
    await seedUsersIfNeededFirebase();
    const snap = await db.collection('users').get();
    const users = {};
    snap.forEach(doc => {
      users[doc.id] = normalizeUser(doc.data());
    });
    return users;
  }

  seedUsersIfNeededLocal();
  return readJson(USERS_FILE, {});
}

function normalizeUser(user) {
  return {
    phone: normalizePhone(user.phone),
    name: String(user.name || '').trim().toUpperCase(),
    active: user.active !== false,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt)
  };
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value.seconds) return new Date(value.seconds * 1000).toISOString();
  return String(value);
}

export async function upsertUser({ phone, name = '', active = true }) {
  const clean = normalizePhone(phone);
  if (!clean) throw new Error('Número inválido');

  if (useFirebase()) {
    const ref = db.collection('users').doc(clean);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : {};
    const user = {
      phone: clean,
      name: String(name || existing.name || '').trim().toUpperCase(),
      active: Boolean(active),
      createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(user, { merge: true });
    const saved = await ref.get();
    return normalizeUser(saved.data());
  }

  const users = await loadUsers();
  const existing = users[clean] || {};
  users[clean] = {
    phone: clean,
    name: String(name || existing.name || '').trim().toUpperCase(),
    active: Boolean(active),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeJson(USERS_FILE, users);
  return users[clean];
}

export async function setUserActive(phone, active) {
  const clean = normalizePhone(phone);

  if (useFirebase()) {
    const ref = db.collection('users').doc(clean);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Número no encontrado');
    await ref.set({
      active: Boolean(active),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    const saved = await ref.get();
    return normalizeUser(saved.data());
  }

  const users = await loadUsers();
  if (!users[clean]) throw new Error('Número no encontrado');
  users[clean].active = Boolean(active);
  users[clean].updatedAt = new Date().toISOString();
  writeJson(USERS_FILE, users);
  return users[clean];
}

export async function deleteUser(phone) {
  const clean = normalizePhone(phone);

  if (useFirebase()) {
    await db.collection('users').doc(clean).delete().catch(() => {});
    return;
  }

  const users = await loadUsers();
  delete users[clean];
  writeJson(USERS_FILE, users);
}

export async function getUser(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    const snap = await db.collection('users').doc(clean).get();
    return snap.exists ? normalizeUser(snap.data()) : null;
  }

  const users = await loadUsers();
  return users[clean] || null;
}

export async function isUserAllowed(phone) {
  const user = await getUser(phone);
  return Boolean(user && user.active);
}

export async function loadPolicies() {
  if (useFirebase()) {
    const snap = await db.collection('policies').orderBy('createdAtMs', 'asc').get();
    return snap.docs.map(doc => normalizePolicy({ id: doc.id, ...doc.data() }));
  }

  return readJson(POLICIES_FILE, []);
}

function normalizePolicy(policy) {
  return {
    id: policy.id,
    phone: normalizePhone(policy.phone),
    folio: policy.folio || '',
    insuredName: String(policy.insuredName || '').toUpperCase(),
    auto: String(policy.auto || '').toUpperCase(),
    vin: String(policy.vin || '').toUpperCase(),
    filename: policy.filename || '',
    status: policy.status || 'pending',
    createdAt: toIso(policy.createdAt) || new Date(policy.createdAtMs || Date.now()).toISOString(),
    createdAtMs: Number(policy.createdAtMs || Date.now()),
    paidAt: toIso(policy.paidAt)
  };
}

export async function recordPolicy({ phone, folio, insuredName, auto, vin, filename }) {
  const clean = normalizePhone(phone);
  const record = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    phone: clean,
    folio,
    insuredName: String(insuredName || '').toUpperCase(),
    auto: String(auto || '').toUpperCase(),
    vin: String(vin || '').toUpperCase(),
    filename: filename || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    paidAt: null
  };

  if (useFirebase()) {
    await db.collection('policies').doc(record.id).set({
      ...record,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return record;
  }

  const policies = await loadPolicies();
  policies.push(record);
  writeJson(POLICIES_FILE, policies);
  return record;
}

export async function markPoliciesPaid(phone, count = 1) {
  const clean = normalizePhone(phone);
  const qty = Math.max(0, Number(count || 0));

  if (!qty) return 0;

  if (useFirebase()) {
    // Evita orderBy + limit en Firestore para no requerir índice compuesto.
    // Se leen las pendientes del emisor, se ordenan en Node y se marcan las primeras N.
    const snap = await db.collection('policies')
      .where('phone', '==', clean)
      .where('status', '==', 'pending')
      .get();

    const docs = snap.docs
      .map(doc => ({ doc, data: doc.data() }))
      .sort((a, b) => Number(a.data.createdAtMs || 0) - Number(b.data.createdAtMs || 0))
      .slice(0, qty);

    if (!docs.length) return 0;

    const batch = db.batch();
    let marked = 0;

    for (const item of docs) {
      batch.set(item.doc.ref, {
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      marked += 1;
    }

    await batch.commit();
    return marked;
  }

  const policies = await loadPolicies();
  let marked = 0;
  for (const policy of policies) {
    if (policy.phone === clean && policy.status === 'pending' && marked < qty) {
      policy.status = 'paid';
      policy.paidAt = new Date().toISOString();
      marked += 1;
    }
  }
  writeJson(POLICIES_FILE, policies);
  return marked;
}

export async function liquidatePolicies(phone) {
  const clean = normalizePhone(phone);

  if (useFirebase()) {
    const snap = await db.collection('policies')
      .where('phone', '==', clean)
      .where('status', '==', 'pending')
      .get();

    const batch = db.batch();
    let marked = 0;
    snap.forEach(doc => {
      batch.set(doc.ref, {
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      marked += 1;
    });

    if (marked) await batch.commit();
    return marked;
  }

  const policies = await loadPolicies();
  let marked = 0;
  for (const policy of policies) {
    if (policy.phone === clean && policy.status === 'pending') {
      policy.status = 'paid';
      policy.paidAt = new Date().toISOString();
      marked += 1;
    }
  }
  writeJson(POLICIES_FILE, policies);
  return marked;
}

export async function getAdminSummary() {
  const usersObj = await loadUsers();
  const policies = await loadPolicies();

  const users = Object.values(usersObj).sort((a, b) => a.phone.localeCompare(b.phone));
  const enrichedUsers = users.map(user => {
    const userPolicies = policies.filter(p => p.phone === user.phone);
    const pending = userPolicies.filter(p => p.status === 'pending');
    const paid = userPolicies.filter(p => p.status === 'paid');
    return {
      ...user,
      totalIssued: userPolicies.length,
      pendingCount: pending.length,
      paidCount: paid.length,
      pendingFolios: pending.map(p => p.folio),
      allFolios: userPolicies.map(p => p.folio),
      policies: userPolicies.slice().reverse()
    };
  });

  return {
    storageMode: storageMode(),
    lastFolioNumber: await getLastFolioNumber(),
    users: enrichedUsers,
    policies: policies.slice().reverse(),
    totals: {
      users: users.length,
      activeUsers: users.filter(u => u.active).length,
      totalIssued: policies.length,
      pending: policies.filter(p => p.status === 'pending').length,
      paid: policies.filter(p => p.status === 'paid').length
    }
  };
}
