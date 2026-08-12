import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const DATA_DIR = path.join(process.cwd(), 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POLICIES_FILE = path.join(DATA_DIR, 'policies.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const AFFILIATIONS_FILE = path.join(DATA_DIR, 'affiliations.json');
const CARTERAPRO_SESSIONS_FILE = path.join(DATA_DIR, 'carterapro_sales_sessions.json');
const CARTERAPRO_LEADS_FILE = path.join(DATA_DIR, 'carterapro_leads.json');
const CARTERAPRO_ONBOARDING_FILE = path.join(DATA_DIR, 'carterapro_onboarding.json');

let firebaseDb = null;
let firebaseBackend = '';
let firebaseReady = false;
let firebaseDisabledReason = '';

function isFirebaseQuotaError(err) {
  const msg = String(err?.message || err?.details || err || '');
  return err?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded|quota/i.test(msg);
}

function noteFirebaseError(err, action = 'Firebase') {
  if (isFirebaseQuotaError(err)) {
    firebaseDisabledReason = `${firebaseBackend || 'Firebase'} quota exceeded`;
    console.error(`${action}: cuota agotada. Se activa modo local de emergencia durante este arranque para no detener WhatsApp.`, err?.message || err);
  } else {
    firebaseDisabledReason = `${firebaseBackend || 'Firebase'} error`;
    console.error(`${action}: error Firebase. Se activa modo local de emergencia durante este arranque para no detener WhatsApp.`, err?.message || err);
  }

  // Circuit breaker: después del primer fallo evitamos reintentos contra Firebase en este proceso.
  // Así el webhook sigue preguntando datos, generando PDF y mandando respaldo por WhatsApp.
  firebaseDb = null;
  firebaseBackend = '';
}

function firebaseErrorText(err) {
  return String(err?.details || err?.message || err || 'Error Firebase').slice(0, 300);
}

// Compatibilidad con server.js antiguo: conserva el nombre aunque ahora puede ser Firestore o RTDB.
export function firestoreStatus() {
  return {
    firebaseReady: Boolean(firebaseDb),
    firebaseBackend: firebaseBackend || 'local',
    firebaseDisabledReason
  };
}

function emergencyNumbersFromEnv() {
  return [
    process.env.EMERGENCY_ALLOWED_NUMBERS || '',
    process.env.ALLOWED_NUMBERS || '',
    process.env.ADMIN_NOTIFY_NUMBERS || ''
  ]
    .join(',')
    .split(',')
    .map(v => normalizePhone(v))
    .filter(Boolean);
}

function requestedBackend() {
  const raw = String(
    process.env.FIREBASE_DATA_BACKEND ||
    process.env.FIREBASE_BACKEND ||
    process.env.FIREBASE_DATABASE_BACKEND ||
    ''
  ).trim().toLowerCase();

  if (/^(realtime|realtime_database|rtdb|database)$/.test(raw)) return 'realtime';
  if (/^(firestore|cloud_firestore)$/.test(raw)) return 'firestore';

  // Atajo opcional para no tener que borrar las variables viejas.
  if (process.env.FIREBASE_USE_REALTIME_DB === 'true') return 'realtime';

  return 'firestore';
}

function initFirebase() {
  if (firebaseReady) return Boolean(firebaseDb);
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

    const backend = requestedBackend();
    const databaseURL =
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_REALTIME_DATABASE_URL ||
      process.env.REALTIME_DATABASE_URL ||
      '';

    if (backend === 'realtime' && !databaseURL) {
      console.warn('FIREBASE_DATA_BACKEND=realtime, pero falta FIREBASE_DATABASE_URL. Usando archivos locales temporales.');
      return false;
    }

    if (!admin.apps.length) {
      const storageBucket = String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
      admin.initializeApp({
        credential: admin.credential.cert(parsed),
        ...(backend === 'realtime' ? { databaseURL } : {}),
        ...(storageBucket ? { storageBucket } : {})
      });
    }

    firebaseBackend = backend;
    firebaseDb = backend === 'realtime'
      ? admin.database()
      : admin.firestore();

    console.log(`Firebase conectado usando ${backend === 'realtime' ? 'Realtime Database' : 'Cloud Firestore'}.`);
    return true;
  } catch (err) {
    console.error('No se pudo iniciar Firebase. Usando archivos locales temporales:', err.message);
    firebaseDb = null;
    firebaseBackend = '';
    return false;
  }
}

function useFirebase() {
  return initFirebase() && Boolean(firebaseDb);
}

function useRealtime() {
  return useFirebase() && firebaseBackend === 'realtime';
}

function useFirestore() {
  return useFirebase() && firebaseBackend === 'firestore';
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
  if (!useFirebase()) return 'local';
  return firebaseBackend === 'realtime' ? 'firebase_realtime_database' : 'firebase_firestore';
}

function initialLastFolio() {
  return Number(process.env.LAST_FOLIO_NUMBER || 981);
}

function safeKey(value) {
  return String(value || '').replace(/[.#$\[\]\/]/g, '_');
}

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value.seconds) return new Date(value.seconds * 1000).toISOString();
  return String(value);
}

function upperPolicyText(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanPolicyText(value) {
  return String(value || '').trim();
}

function withUpdatedAt(data = {}) {
  return { ...data, updatedAt: data.updatedAt || nowIso() };
}

async function fbGetDoc(collectionName, id) {
  const docId = safeKey(id);
  if (useRealtime()) {
    const snap = await firebaseDb.ref(`${collectionName}/${docId}`).once('value');
    const value = snap.val();
    return value ? { id: docId, ...value } : null;
  }
  if (useFirestore()) {
    const snap = await firebaseDb.collection(collectionName).doc(docId).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }
  return null;
}

async function fbSetDoc(collectionName, id, data, { merge = true } = {}) {
  const docId = safeKey(id);
  if (useRealtime()) {
    const ref = firebaseDb.ref(`${collectionName}/${docId}`);
    if (merge) await ref.update(data);
    else await ref.set(data);
    return;
  }
  if (useFirestore()) {
    await firebaseDb.collection(collectionName).doc(docId).set(data, { merge });
  }
}

async function fbDeleteDoc(collectionName, id) {
  const docId = safeKey(id);
  if (useRealtime()) {
    await firebaseDb.ref(`${collectionName}/${docId}`).remove();
    return;
  }
  if (useFirestore()) {
    await firebaseDb.collection(collectionName).doc(docId).delete();
  }
}

async function fbListDocs(collectionName, { limit = 500, orderBy = '', orderDirection = 'desc' } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 500), 5000));
  if (useRealtime()) {
    let ref = firebaseDb.ref(collectionName);
    if (orderBy) ref = ref.orderByChild(orderBy);
    const snap = await ref.limitToLast(max).once('value');
    const value = snap.val() || {};
    return Object.entries(value).map(([id, data]) => ({ id, ...(data || {}) }));
  }
  if (useFirestore()) {
    let ref = firebaseDb.collection(collectionName);
    if (orderBy) ref = ref.orderBy(orderBy, orderDirection === 'asc' ? 'asc' : 'desc');
    const snap = await ref.limit(max).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
  return [];
}

async function seedUsersIfNeededFirebase() {
  const marker = await fbGetDoc('settings', 'seed');
  if (marker?.usersSeeded) return;

  const raw = process.env.ALLOWED_NUMBERS || '';
  let count = 0;
  const writes = [];

  for (const item of raw.split(',')) {
    const phone = normalizePhone(item);
    if (!phone) continue;
    writes.push(fbSetDoc('users', phone, {
      phone,
      name: '',
      active: true,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }, { merge: true }));
    count += 1;
  }

  writes.push(fbSetDoc('settings', 'seed', {
    usersSeeded: true,
    seededCount: count,
    updatedAt: nowIso()
  }, { merge: true }));

  await Promise.all(writes);
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
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
  }
  writeJson(USERS_FILE, users);
}

export async function getLastFolioNumber() {
  const initial = initialLastFolio();

  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('settings', 'counter');
      if (!doc) {
        await fbSetDoc('settings', 'counter', { last: initial, updatedAt: nowIso() }, { merge: true });
        return initial;
      }
      return Number(doc.last || initial);
    } catch (err) {
      noteFirebaseError(err, 'getLastFolioNumber');
      return Number(readJson(COUNTER_FILE, { last: initial }).last || initial);
    }
  }

  return Number(readJson(COUNTER_FILE, { last: initial }).last || initial);
}

export async function setLastFolioNumber(n) {
  const value = Number(n);
  if (useFirebase()) {
    try {
      await fbSetDoc('settings', 'counter', { last: value, updatedAt: nowIso() }, { merge: true });
      writeJson(COUNTER_FILE, { last: value, updatedAt: nowIso(), mirrorOfFirebase: true, firebaseBackend });
      return;
    } catch (err) {
      noteFirebaseError(err, 'setLastFolioNumber');
    }
  }

  writeJson(COUNTER_FILE, { last: value, updatedAt: nowIso(), emergencyLocal: true });
}

export async function nextFolioNumber() {
  if (useRealtime()) {
    try {
      const ref = firebaseDb.ref('settings/counter/last');
      const result = await ref.transaction(current => Number(current || initialLastFolio()) + 1);
      const next = Number(result.snapshot.val() || initialLastFolio() + 1);
      await fbSetDoc('settings', 'counter', { last: next, updatedAt: nowIso() }, { merge: true });
      writeJson(COUNTER_FILE, { last: next, updatedAt: nowIso(), mirrorOfFirebase: true, firebaseBackend });
      return next;
    } catch (err) {
      noteFirebaseError(err, 'nextFolioNumber RTDB');
    }
  }

  if (useFirestore()) {
    const ref = firebaseDb.collection('settings').doc('counter');
    try {
      const next = await firebaseDb.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const current = snap.exists ? Number(snap.data().last || initialLastFolio()) : initialLastFolio();
        const value = current + 1;
        tx.set(ref, { last: value, updatedAt: nowIso() }, { merge: true });
        return value;
      });
      writeJson(COUNTER_FILE, { last: next, updatedAt: nowIso(), mirrorOfFirebase: true, firebaseBackend });
      return next;
    } catch (err) {
      noteFirebaseError(err, 'nextFolioNumber Firestore');
    }
  }

  const next = await getLastFolioNumber() + 1;
  writeJson(COUNTER_FILE, { last: next, updatedAt: nowIso(), emergencyLocal: true });
  return next;
}

export async function getSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('sessions', clean);
      return doc || null;
    } catch (err) {
      noteFirebaseError(err, 'getSession');
    }
  }

  const sessions = readJson(SESSIONS_FILE, {});
  return sessions[clean] || null;
}

export async function setSession(phone, session) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      await fbSetDoc('sessions', clean, { ...session, phone: clean, updatedAt: nowIso() }, { merge: true });
      return;
    } catch (err) {
      noteFirebaseError(err, 'setSession');
    }
  }

  const sessions = readJson(SESSIONS_FILE, {});
  sessions[clean] = { ...session, phone: clean, updatedAt: nowIso(), emergencyLocal: Boolean(firebaseDisabledReason) };
  writeJson(SESSIONS_FILE, sessions);
}

export async function clearSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      await fbDeleteDoc('sessions', clean);
      return;
    } catch (err) {
      noteFirebaseError(err, 'clearSession');
    }
  }

  const sessions = readJson(SESSIONS_FILE, {});
  delete sessions[clean];
  writeJson(SESSIONS_FILE, sessions);
}

function normalizeUser(user = {}) {
  return {
    phone: normalizePhone(user.phone),
    name: String(user.name || '').trim().toUpperCase(),
    active: user.active !== false,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt)
  };
}

export async function loadUsers() {
  if (useFirebase()) {
    try {
      await seedUsersIfNeededFirebase();
      const docs = await fbListDocs('users', { limit: 1000 });
      const users = {};
      for (const doc of docs) {
        const normalized = normalizeUser({ phone: doc.phone || doc.id, ...doc });
        if (normalized.phone) users[normalized.phone] = normalized;
      }
      return users;
    } catch (err) {
      noteFirebaseError(err, 'loadUsers');
    }
  }

  seedUsersIfNeededLocal();
  return readJson(USERS_FILE, {});
}

export async function upsertUser({ phone, name = '', active = true }) {
  const clean = normalizePhone(phone);
  if (!clean) throw new Error('Número inválido');

  if (useFirebase()) {
    try {
      const existing = await fbGetDoc('users', clean) || {};
      const user = {
        phone: clean,
        name: String(name || existing.name || '').trim().toUpperCase(),
        active: Boolean(active),
        createdAt: existing.createdAt || nowIso(),
        updatedAt: nowIso()
      };
      await fbSetDoc('users', clean, user, { merge: true });
      const saved = await fbGetDoc('users', clean);
      return normalizeUser(saved || user);
    } catch (err) {
      noteFirebaseError(err, 'upsertUser');
    }
  }

  const users = await loadUsers();
  const existing = users[clean] || {};
  users[clean] = {
    phone: clean,
    name: String(name || existing.name || '').trim().toUpperCase(),
    active: Boolean(active),
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  writeJson(USERS_FILE, users);
  return users[clean];
}

export async function setUserActive(phone, active) {
  const clean = normalizePhone(phone);

  if (useFirebase()) {
    try {
      const existing = await fbGetDoc('users', clean);
      if (!existing) throw new Error('Número no encontrado');
      await fbSetDoc('users', clean, { active: Boolean(active), updatedAt: nowIso() }, { merge: true });
      const saved = await fbGetDoc('users', clean);
      return normalizeUser(saved);
    } catch (err) {
      noteFirebaseError(err, 'setUserActive');
      if (!firebaseDisabledReason) throw err;
    }
  }

  const users = await loadUsers();
  if (!users[clean]) throw new Error('Número no encontrado');
  users[clean].active = Boolean(active);
  users[clean].updatedAt = nowIso();
  writeJson(USERS_FILE, users);
  return users[clean];
}

export async function deleteUser(phone) {
  const clean = normalizePhone(phone);

  if (useFirebase()) {
    try {
      await fbDeleteDoc('users', clean);
      return;
    } catch (err) {
      noteFirebaseError(err, 'deleteUser');
    }
  }

  const users = await loadUsers();
  delete users[clean];
  writeJson(USERS_FILE, users);
}

export async function getUser(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('users', clean);
      return doc ? normalizeUser({ phone: clean, ...doc }) : null;
    } catch (err) {
      noteFirebaseError(err, 'getUser');
    }
  }

  const users = await loadUsers();
  return users[clean] || null;
}

export async function isUserAllowed(phone) {
  const clean = normalizePhone(phone);
  const user = await getUser(clean);
  if (user) return Boolean(user.active);

  // Si Firebase falló, permite únicamente números de emergencia definidos por variable.
  if (firebaseDisabledReason) {
    const emergencyNumbers = emergencyNumbersFromEnv();
    if (emergencyNumbers.length) return emergencyNumbers.includes(clean);
    return process.env.EMERGENCY_ALLOW_ALL_WHATSAPP === 'true';
  }

  return false;
}

function normalizePolicy(policy = {}) {
  return {
    id: policy.id,
    phone: normalizePhone(policy.phone),
    folio: cleanPolicyText(policy.folio),
    insuredName: upperPolicyText(policy.insuredName || policy.name),
    address: upperPolicyText(policy.address),
    cityState: upperPolicyText(policy.cityState),
    cp: cleanPolicyText(policy.cp),
    auto: upperPolicyText(policy.auto),
    body: upperPolicyText(policy.body || policy.carroceria),
    modelYear: cleanPolicyText(policy.modelYear || policy.modelo),
    vin: upperPolicyText(policy.vin || policy.noser),
    plates: upperPolicyText(policy.plates),
    service: upperPolicyText(policy.service),
    coverage: upperPolicyText(policy.coverage),
    coverageDesc: upperPolicyText(policy.coverageDesc),
    rc: cleanPolicyText(policy.rc),
    deductible: cleanPolicyText(policy.deductible || policy.ded),
    prima: cleanPolicyText(policy.prima),
    gastos: cleanPolicyText(policy.gastos),
    subtotal: cleanPolicyText(policy.subtotal),
    iva: cleanPolicyText(policy.iva),
    total: cleanPolicyText(policy.total),
    totalQr: cleanPolicyText(policy.totalQr),
    vigencia: cleanPolicyText(policy.vigencia || policy.nextDate),
    date: cleanPolicyText(policy.date),
    nextDate: cleanPolicyText(policy.nextDate || policy.vigencia),
    desde: cleanPolicyText(policy.desde),
    hasta: cleanPolicyText(policy.hasta),
    hour: cleanPolicyText(policy.hour),
    qrPayload: cleanPolicyText(policy.qrPayload),
    filename: policy.filename || '',
    status: policy.status || 'pending',
    createdAt: toIso(policy.createdAt) || new Date(policy.createdAtMs || Date.now()).toISOString(),
    createdAtMs: Number(policy.createdAtMs || Date.now()),
    paidAt: toIso(policy.paidAt),
    mediaUrl: policy.mediaUrl || ''
  };
}

export async function loadPolicies({ limit = 500 } = {}) {
  if (useFirebase()) {
    try {
      const docs = await fbListDocs('policies', { limit });
      return docs
        .map(doc => normalizePolicy({ id: doc.id, ...doc }))
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    } catch (err) {
      noteFirebaseError(err, 'loadPolicies');
    }
  }

  return readJson(POLICIES_FILE, []).map(normalizePolicy);
}

export async function recordPolicy({
  phone,
  folio,
  insuredName,
  auto,
  vin,
  filename,
  policy = {},
  inputData = {}
}) {
  const clean = normalizePhone(phone);
  const get = (key, fallback = '') => {
    const fromPolicy = policy?.[key];
    if (fromPolicy !== undefined && fromPolicy !== null && String(fromPolicy) !== '') return fromPolicy;
    const fromInput = inputData?.[key];
    if (fromInput !== undefined && fromInput !== null && String(fromInput) !== '') return fromInput;
    return fallback;
  };

  const nowMs = Date.now();

  const record = normalizePolicy({
    id: `${nowMs}_${Math.random().toString(16).slice(2)}`,
    phone: clean,
    folio: cleanPolicyText(folio || get('folio')),
    insuredName: upperPolicyText(insuredName || get('name')),
    filename: filename || '',
    address: upperPolicyText(get('address')),
    auto: upperPolicyText(auto || get('auto')),
    body: upperPolicyText(get('body')),
    modelYear: cleanPolicyText(get('modelYear')),
    vin: upperPolicyText(vin || get('vin')),
    plates: upperPolicyText(get('plates')),
    cityState: upperPolicyText(get('cityState')),
    cp: cleanPolicyText(get('cp')),
    service: upperPolicyText(get('service')),
    coverage: upperPolicyText(get('coverage')),
    coverageDesc: upperPolicyText(get('coverageDesc')),
    rc: cleanPolicyText(get('rc')),
    deductible: cleanPolicyText(get('deductible', get('ded'))),
    prima: cleanPolicyText(get('prima')),
    gastos: cleanPolicyText(get('gastos')),
    subtotal: cleanPolicyText(get('subtotal')),
    iva: cleanPolicyText(get('iva')),
    total: cleanPolicyText(get('total')),
    totalQr: cleanPolicyText(get('totalQr')),
    vigencia: cleanPolicyText(get('nextDate', get('vigencia'))),
    date: cleanPolicyText(get('date')),
    nextDate: cleanPolicyText(get('nextDate')),
    desde: cleanPolicyText(get('desde')),
    hasta: cleanPolicyText(get('hasta')),
    hour: cleanPolicyText(get('hour')),
    qrPayload: cleanPolicyText(get('qrPayload')),
    status: 'pending',
    createdAt: nowIso(),
    createdAtMs: nowMs,
    paidAt: null
  });

  if (useFirebase()) {
    try {
      await fbSetDoc('policies', record.id, record, { merge: false });
      return { ...record, storedIn: storageMode() };
    } catch (err) {
      noteFirebaseError(err, 'recordPolicy');
      record.firebaseSaveError = firebaseErrorText(err);
      record.storedIn = 'local_backup';
    }
  }

  const policies = readJson(POLICIES_FILE, []).map(normalizePolicy);
  policies.push(record);
  writeJson(POLICIES_FILE, policies);
  return { ...record, storedIn: record.storedIn || 'local' };
}

export async function markPoliciesPaid(phone, count = 1) {
  const clean = normalizePhone(phone);
  const qty = Math.max(0, Number(count || 0));
  if (!qty) return 0;

  const policies = await loadPolicies({ limit: 5000 });
  const pending = policies
    .filter(policy => policy.phone === clean && policy.status === 'pending')
    .sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0))
    .slice(0, qty);

  let marked = 0;
  for (const policy of pending) {
    policy.status = 'paid';
    policy.paidAt = nowIso();
    policy.updatedAt = nowIso();
    marked += 1;
    if (useFirebase()) {
      try {
        await fbSetDoc('policies', policy.id, { status: 'paid', paidAt: policy.paidAt, updatedAt: policy.updatedAt }, { merge: true });
      } catch (err) {
        noteFirebaseError(err, 'markPoliciesPaid');
      }
    }
  }

  if (!useFirebase()) {
    const allPolicies = await loadPolicies({ limit: 5000 });
    const updates = new Map(pending.map(p => [String(p.id), p]));
    const merged = allPolicies.map(p => updates.get(String(p.id)) || p);
    writeJson(POLICIES_FILE, merged);
  }

  return marked;
}

export async function liquidatePolicies(phone) {
  const clean = normalizePhone(phone);
  const policies = await loadPolicies({ limit: 5000 });
  const pending = policies.filter(policy => policy.phone === clean && policy.status === 'pending');

  let marked = 0;
  for (const policy of pending) {
    policy.status = 'paid';
    policy.paidAt = nowIso();
    policy.updatedAt = nowIso();
    marked += 1;
    if (useFirebase()) {
      try {
        await fbSetDoc('policies', policy.id, { status: 'paid', paidAt: policy.paidAt, updatedAt: policy.updatedAt }, { merge: true });
      } catch (err) {
        noteFirebaseError(err, 'liquidatePolicies');
      }
    }
  }

  if (!useFirebase()) {
    const updates = new Map(pending.map(p => [String(p.id), p]));
    const merged = policies.map(p => updates.get(String(p.id)) || p);
    writeJson(POLICIES_FILE, merged);
  }

  return marked;
}

function normalizeMessage(message = {}) {
  const createdAtMs = Number(message.createdAtMs || Date.now());
  return {
    id: message.id || `${createdAtMs}_${Math.random().toString(16).slice(2)}`,
    phone: normalizePhone(message.phone),
    direction: message.direction || 'inbound',
    source: message.source || '',
    body: String(message.body || ''),
    from: String(message.from || ''),
    to: String(message.to || ''),
    sid: String(message.sid || ''),
    mediaUrl: String(message.mediaUrl || ''),
    status: message.status || '',
    referral: message.referral && typeof message.referral === 'object' ? message.referral : null,
    createdAt: toIso(message.createdAt) || new Date(createdAtMs).toISOString(),
    createdAtMs
  };
}

function conversationAreaFromSource(source = '', current = 'unknown') {
  const s = String(source || '').toLowerCase();
  if (s.includes('carterapro')) return 'carterapro';
  if (s === 'emisor') return 'emisor';
  if (s === 'help') return current === 'unknown' ? 'mixed' : current;
  if (s === 'manual') return current || 'unknown';
  if (s === 'whatsapp') return current || 'unknown';
  return current || 'unknown';
}

function normalizeConversation(item = {}) {
  const phone = normalizePhone(item.phone || item.id);
  const lastAtMs = Number(item.lastAtMs || item.updatedAtMs || Date.now());
  return {
    phone,
    area: String(item.area || 'unknown'),
    firstAt: toIso(item.firstAt) || toIso(item.lastAt) || new Date(lastAtMs).toISOString(),
    firstAtMs: Number(item.firstAtMs || lastAtMs),
    lastAt: toIso(item.lastAt) || new Date(lastAtMs).toISOString(),
    lastAtMs,
    lastBody: String(item.lastBody || ''),
    lastDirection: String(item.lastDirection || ''),
    lastSource: String(item.lastSource || ''),
    totalMessages: Number(item.totalMessages || 0),
    inboundCount: Number(item.inboundCount || 0),
    outboundCount: Number(item.outboundCount || 0),
    unreadCount: Number(item.unreadCount || 0),
    lastInboundAt: toIso(item.lastInboundAt) || null,
    lastInboundAtMs: Number(item.lastInboundAtMs || 0),
    lastOutboundAt: toIso(item.lastOutboundAt) || null,
    lastOutboundAtMs: Number(item.lastOutboundAtMs || 0),
    readAt: toIso(item.readAt) || null,
    referralCtwaClid: String(item.referralCtwaClid || ''),
    referralSourceId: String(item.referralSourceId || ''),
    referralSourceUrl: String(item.referralSourceUrl || ''),
    referralHeadline: String(item.referralHeadline || ''),
    referralBody: String(item.referralBody || ''),
    origin: String(item.origin || ''),
    updatedAt: toIso(item.updatedAt) || nowIso(),
    updatedAtMs: Number(item.updatedAtMs || lastAtMs)
  };
}

const conversationCache = new Map();

async function loadConversationForUpdate(phone) {
  const clean = normalizePhone(phone);
  if (!clean) return normalizeConversation({ phone: clean });
  if (conversationCache.has(clean)) return { ...conversationCache.get(clean) };

  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('conversations', clean);
      if (doc) {
        const value = normalizeConversation({ phone: clean, ...doc });
        conversationCache.set(clean, value);
        return { ...value };
      }
    } catch (err) {
      console.error('No se pudo leer índice de conversación:', err?.message || err);
    }
  }

  const local = readJson(CONVERSATIONS_FILE, {});
  const value = normalizeConversation(local[clean] || { phone: clean });
  conversationCache.set(clean, value);
  return { ...value };
}

async function updateConversationIndex(record) {
  const clean = normalizePhone(record.phone);
  if (!clean) return null;

  const previous = await loadConversationForUpdate(clean);
  const isInbound = record.direction === 'inbound';
  const isOutbound = record.direction === 'outbound';
  const createdMs = Number(record.createdAtMs || Date.now());

  const next = normalizeConversation({
    ...previous,
    phone: clean,
    area: conversationAreaFromSource(record.source, previous.area),
    firstAt: previous.totalMessages ? previous.firstAt : record.createdAt,
    firstAtMs: previous.totalMessages ? previous.firstAtMs : createdMs,
    lastAt: record.createdAt,
    lastAtMs: createdMs,
    lastBody: record.body,
    lastDirection: record.direction,
    lastSource: record.source,
    totalMessages: Number(previous.totalMessages || 0) + 1,
    inboundCount: Number(previous.inboundCount || 0) + (isInbound ? 1 : 0),
    outboundCount: Number(previous.outboundCount || 0) + (isOutbound ? 1 : 0),
    unreadCount: Number(previous.unreadCount || 0) + (isInbound ? 1 : 0),
    lastInboundAt: isInbound ? record.createdAt : previous.lastInboundAt,
    lastInboundAtMs: isInbound ? createdMs : previous.lastInboundAtMs,
    lastOutboundAt: isOutbound ? record.createdAt : previous.lastOutboundAt,
    lastOutboundAtMs: isOutbound ? createdMs : previous.lastOutboundAtMs,
    referralCtwaClid: record.referral?.ctwaClid || previous.referralCtwaClid || '',
    referralSourceId: record.referral?.sourceId || previous.referralSourceId || '',
    referralSourceUrl: record.referral?.sourceUrl || previous.referralSourceUrl || '',
    referralHeadline: record.referral?.headline || previous.referralHeadline || '',
    referralBody: record.referral?.body || previous.referralBody || '',
    origin: record.referral?.ctwaClid ? 'facebook_ads' : (previous.origin || ''),
    updatedAt: nowIso(),
    updatedAtMs: Date.now()
  });

  conversationCache.set(clean, next);

  if (useFirebase()) {
    try {
      await fbSetDoc('conversations', clean, next, { merge: true });
      return next;
    } catch (err) {
      // No tumbamos Firebase solo por fallar el índice de chat.
      console.error('No se pudo guardar índice de conversación en Firebase:', err?.message || err);
    }
  }

  const local = readJson(CONVERSATIONS_FILE, {});
  local[clean] = next;
  writeJson(CONVERSATIONS_FILE, local);
  return next;
}

export async function recordMessage({ phone, direction, source = '', body = '', from = '', to = '', sid = '', mediaUrl = '', status = '', referral = null }) {
  const clean = normalizePhone(phone || from || to);
  const record = normalizeMessage({
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    phone: clean,
    direction,
    source,
    body: String(body || ''),
    from: String(from || ''),
    to: String(to || ''),
    sid: String(sid || ''),
    mediaUrl: String(mediaUrl || ''),
    status: String(status || ''),
    referral: referral && typeof referral === 'object' ? {
      ctwaClid:String(referral.ctwaClid||''),
      sourceId:String(referral.sourceId||''),
      sourceType:String(referral.sourceType||''),
      sourceUrl:String(referral.sourceUrl||''),
      headline:String(referral.headline||''),
      body:String(referral.body||''),
      mediaContentType:String(referral.mediaContentType||'')
    } : null,
    createdAt: nowIso(),
    createdAtMs: Date.now()
  });

  let storedIn = 'local';
  if (useFirebase()) {
    try {
      await fbSetDoc('messages', record.id, record, { merge: false });
      storedIn = storageMode();
    } catch (err) {
      noteFirebaseError(err, 'recordMessage');
      record.firebaseSaveError = firebaseErrorText(err);
      storedIn = 'local_backup';
    }
  }

  if (storedIn === 'local' || storedIn === 'local_backup') {
    const messages = readJson(MESSAGES_FILE, []).map(normalizeMessage);
    messages.push(record);
    writeJson(MESSAGES_FILE, messages);
  }

  await updateConversationIndex(record).catch(err =>
    console.error('No se pudo actualizar resumen de conversación:', err?.message || err)
  );

  return { ...record, storedIn };
}

export async function loadMessages({ phone = '', limit = 200 } = {}) {
  const clean = normalizePhone(phone);
  const max = Math.max(1, Math.min(Number(limit || 200), 5000));

  if (useFirebase()) {
    try {
      if (!clean) {
        const docs = await fbListDocs('messages', {
          limit: max,
          orderBy: 'createdAtMs',
          orderDirection: 'desc'
        });
        return docs.map(doc => normalizeMessage({ id: doc.id, ...doc }))
          .sort((a,b) => b.createdAtMs - a.createdAtMs).slice(0,max);
      }

      // Para un chat específico intentamos una consulta directa. Si el proyecto
      // necesita índice compuesto, hacemos fallback a los 5000 mensajes más recientes.
      if (useFirestore()) {
        try {
          const snap = await firebaseDb.collection('messages')
            .where('phone','==',clean)
            .orderBy('createdAtMs','desc')
            .limit(max)
            .get();
          return snap.docs.map(doc => normalizeMessage({ id:doc.id, ...doc.data() }))
            .sort((a,b)=>b.createdAtMs-a.createdAtMs);
        } catch (queryErr) {
          console.warn('Consulta directa de chat no disponible; usando fallback:', queryErr?.message || queryErr);
        }
      }

      const docs = await fbListDocs('messages', {
        limit: 5000,
        orderBy: 'createdAtMs',
        orderDirection: 'desc'
      });
      return docs.map(doc => normalizeMessage({ id: doc.id, ...doc }))
        .filter(m => m.phone === clean)
        .sort((a,b)=>b.createdAtMs-a.createdAtMs)
        .slice(0,max);
    } catch (err) {
      noteFirebaseError(err, 'loadMessages');
      throw err;
    }
  }

  const messages = readJson(MESSAGES_FILE, []).map(normalizeMessage);
  return messages
    .filter(m => !clean || m.phone === clean)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, max);
}

export async function loadConversationIndex({ limit = 1000 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 1000), 5000));
  if (useFirebase()) {
    try {
      const docs = await fbListDocs('conversations', {
        limit: max,
        orderBy: 'lastAtMs',
        orderDirection: 'desc'
      });
      const list = docs.map(x => normalizeConversation({ phone:x.phone || x.id, ...x }))
        .filter(x => x.phone)
        .sort((a,b)=>b.lastAtMs-a.lastAtMs)
        .slice(0,max);
      list.forEach(x=>conversationCache.set(x.phone,x));
      return list;
    } catch (err) {
      console.error('No se pudo cargar índice de conversaciones:', err?.message || err);
    }
  }

  return Object.values(readJson(CONVERSATIONS_FILE, {}))
    .map(normalizeConversation)
    .filter(x=>x.phone)
    .sort((a,b)=>b.lastAtMs-a.lastAtMs)
    .slice(0,max);
}

export async function markConversationRead(phone) {
  const clean = normalizePhone(phone);
  const current = await loadConversationForUpdate(clean);
  const next = normalizeConversation({
    ...current,
    phone:clean,
    unreadCount:0,
    readAt:nowIso(),
    updatedAt:nowIso(),
    updatedAtMs:Date.now()
  });
  conversationCache.set(clean,next);

  if (useFirebase()) {
    try {
      await fbSetDoc('conversations',clean,next,{merge:true});
      return next;
    } catch(err) {
      console.error('No se pudo marcar chat leído en Firebase:',err?.message||err);
    }
  }
  const local=readJson(CONVERSATIONS_FILE,{});
  local[clean]=next;
  writeJson(CONVERSATIONS_FILE,local);
  return next;
}

export async function rebuildConversationIndex({ limit = 5000 } = {}) {
  const messages = (await loadMessages({ limit })).slice().sort((a,b)=>a.createdAtMs-b.createdAtMs);
  const map = new Map();

  for (const msg of messages) {
    const phone = normalizePhone(msg.phone);
    if (!phone) continue;
    const prev = map.get(phone) || normalizeConversation({ phone, firstAt:msg.createdAt, firstAtMs:msg.createdAtMs, lastAt:msg.createdAt, lastAtMs:msg.createdAtMs });
    const isInbound = msg.direction === 'inbound';
    const isOutbound = msg.direction === 'outbound';
    const next = normalizeConversation({
      ...prev,
      phone,
      area:conversationAreaFromSource(msg.source,prev.area),
      firstAt:prev.totalMessages ? prev.firstAt : msg.createdAt,
      firstAtMs:prev.totalMessages ? prev.firstAtMs : msg.createdAtMs,
      lastAt:msg.createdAt,
      lastAtMs:msg.createdAtMs,
      lastBody:msg.body,
      lastDirection:msg.direction,
      lastSource:msg.source,
      totalMessages:Number(prev.totalMessages||0)+1,
      inboundCount:Number(prev.inboundCount||0)+(isInbound?1:0),
      outboundCount:Number(prev.outboundCount||0)+(isOutbound?1:0),
      unreadCount:Number(prev.unreadCount||0)+(isInbound?1:0),
      lastInboundAt:isInbound?msg.createdAt:prev.lastInboundAt,
      lastInboundAtMs:isInbound?msg.createdAtMs:prev.lastInboundAtMs,
      lastOutboundAt:isOutbound?msg.createdAt:prev.lastOutboundAt,
      lastOutboundAtMs:isOutbound?msg.createdAtMs:prev.lastOutboundAtMs,
      updatedAt:nowIso(),
      updatedAtMs:Date.now()
    });
    map.set(phone,next);
  }

  const local = readJson(CONVERSATIONS_FILE,{});
  for (const [phone,item] of map.entries()) {
    local[phone]=item;
    conversationCache.set(phone,item);
    if (useFirebase()) {
      try { await fbSetDoc('conversations',phone,item,{merge:true}); }
      catch(err){ console.error('No se pudo reconstruir chat',phone,err?.message||err); }
    }
  }
  writeJson(CONVERSATIONS_FILE,local);
  return Array.from(map.values()).sort((a,b)=>b.lastAtMs-a.lastAtMs);
}

export async function getConversationSummary() {
  const indexed = await loadConversationIndex({ limit: 2000 });
  if (indexed.length) return indexed;

  // Compatibilidad con instalaciones que ya tenían mensajes antes de esta versión.
  const messages = await loadMessages({ limit: 1000 }).catch(()=>[]);
  const byPhone = new Map();
  for (const msg of messages.slice().sort((a,b)=>a.createdAtMs-b.createdAtMs)) {
    const phone=normalizePhone(msg.phone);
    if(!phone) continue;
    const prev=byPhone.get(phone)||normalizeConversation({phone});
    const inbound=msg.direction==='inbound';
    const outbound=msg.direction==='outbound';
    byPhone.set(phone,normalizeConversation({
      ...prev,phone,
      area:conversationAreaFromSource(msg.source,prev.area),
      firstAt:prev.totalMessages?prev.firstAt:msg.createdAt,
      firstAtMs:prev.totalMessages?prev.firstAtMs:msg.createdAtMs,
      lastAt:msg.createdAt,lastAtMs:msg.createdAtMs,lastBody:msg.body,
      lastDirection:msg.direction,lastSource:msg.source,
      totalMessages:Number(prev.totalMessages||0)+1,
      inboundCount:Number(prev.inboundCount||0)+(inbound?1:0),
      outboundCount:Number(prev.outboundCount||0)+(outbound?1:0),
      unreadCount:Number(prev.unreadCount||0)+(inbound?1:0)
    }));
  }
  return Array.from(byPhone.values()).sort((a,b)=>b.lastAtMs-a.lastAtMs);
}

export async function setPolicyStatus(policyId, status) {
  const id = String(policyId || '').trim();
  const normalized = String(status || '').trim().toLowerCase();

  if (!id) throw new Error('ID de póliza inválido');
  if (!['pending', 'paid'].includes(normalized)) throw new Error('Estatus inválido');

  if (useFirebase()) {
    try {
      const existing = await fbGetDoc('policies', id);
      if (!existing) throw new Error('Póliza no encontrada');
      const update = {
        status: normalized,
        updatedAt: nowIso(),
        paidAt: normalized === 'paid' ? nowIso() : null
      };
      await fbSetDoc('policies', id, update, { merge: true });
      const saved = await fbGetDoc('policies', id);
      return normalizePolicy(saved);
    } catch (err) {
      noteFirebaseError(err, 'setPolicyStatus');
      if (!firebaseDisabledReason) throw err;
    }
  }

  const policies = await loadPolicies({ limit: 5000 });
  const idx = policies.findIndex(p => String(p.id) === id);
  if (idx < 0) throw new Error('Póliza no encontrada');
  policies[idx].status = normalized;
  policies[idx].updatedAt = nowIso();
  policies[idx].paidAt = normalized === 'paid' ? nowIso() : null;
  writeJson(POLICIES_FILE, policies);
  return normalizePolicy(policies[idx]);
}

export async function getPolicyStatsForPhone(phone) {
  const clean = normalizePhone(phone);
  const policies = await loadPolicies({ limit: 5000 });
  const userPolicies = policies.filter(p => p.phone === clean)
    .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));

  const pendingPolicies = userPolicies.filter(p => p.status === 'pending');
  const paidPolicies = userPolicies.filter(p => p.status === 'paid');

  return {
    phone: clean,
    totalIssued: userPolicies.length,
    pendingCount: pendingPolicies.length,
    paidCount: paidPolicies.length,
    pendingFolios: pendingPolicies.map(p => p.folio).filter(Boolean),
    allFolios: userPolicies.map(p => p.folio).filter(Boolean)
  };
}

function normalizeAffiliationRecord(item = {}) {
  const createdAtMs = Number(item.createdAtMs || Date.now());
  const names = Array.isArray(item.names)
    ? item.names.map(upperPolicyText).filter(Boolean).slice(0, 3)
    : String(item.names || '')
        .split(',')
        .map(upperPolicyText)
        .filter(Boolean)
        .slice(0, 3);

  return {
    id: item.id || `${createdAtMs}_${Math.random().toString(16).slice(2)}`,
    phone: normalizePhone(item.phone),
    type: item.type || 'afiliacion',
    policyFolio: cleanPolicyText(item.policyFolio),
    filename: item.filename || '',
    mediaUrl: item.mediaUrl || '',
    estado: upperPolicyText(item.estado || 'SONORA'),
    municipio: upperPolicyText(item.municipio || 'HERMOSILLO'),
    exp: upperPolicyText(item.exp || item.plates),
    plates: upperPolicyText(item.plates || item.exp),
    customerPhone: normalizePhone(item.customerPhone || item.telefono || item.numeroCliente),
    names,
    nombre1: upperPolicyText(item.nombre1 || names[0]),
    nombre2: upperPolicyText(item.nombre2 || names.slice(1).join(', ')),
    auto: upperPolicyText(item.auto || item.marca),
    body: upperPolicyText(item.body || item.tipo),
    modelYear: cleanPolicyText(item.modelYear || item.modelo),
    vin: upperPolicyText(item.vin || item.serie),
    color: upperPolicyText(item.color),
    date: cleanPolicyText(item.date),
    createdAt: toIso(item.createdAt) || new Date(createdAtMs).toISOString(),
    createdAtMs
  };
}

export async function loadAffiliations({ limit = 500 } = {}) {
  if (useFirebase()) {
    try {
      const docs = await fbListDocs('affiliations', { limit });
      return docs
        .map(doc => normalizeAffiliationRecord({ id: doc.id, ...doc }))
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    } catch (err) {
      noteFirebaseError(err, 'loadAffiliations');
    }
  }

  return readJson(AFFILIATIONS_FILE, []).map(normalizeAffiliationRecord);
}

export async function recordAffiliation({
  phone,
  type = 'afiliacion',
  policyFolio = '',
  filename = '',
  mediaUrl = '',
  affiliation = {},
  inputData = {}
}) {
  const clean = normalizePhone(phone);
  const get = (key, fallback = '') => {
    const fromAff = affiliation?.[key];
    if (fromAff !== undefined && fromAff !== null && String(fromAff) !== '') return fromAff;
    const fromInput = inputData?.[key];
    if (fromInput !== undefined && fromInput !== null && String(fromInput) !== '') return fromInput;
    return fallback;
  };

  const nowMs = Date.now();
  const names = Array.isArray(get('names')) ? get('names') : [];
  const record = normalizeAffiliationRecord({
    id: `${nowMs}_${Math.random().toString(16).slice(2)}`,
    phone: clean,
    type,
    policyFolio,
    filename,
    mediaUrl,
    estado: get('estado', 'SONORA'),
    municipio: get('municipio', 'HERMOSILLO'),
    exp: get('exp', get('plates')),
    plates: get('plates', get('exp')),
    customerPhone: get('customerPhone', get('phone')),
    names,
    nombre1: get('nombre1', names[0]),
    nombre2: get('nombre2', names.slice(1).join(', ')),
    auto: get('auto'),
    body: get('body'),
    modelYear: get('modelYear'),
    vin: get('vin'),
    color: get('color'),
    date: get('date'),
    createdAt: nowIso(),
    createdAtMs: nowMs
  });

  if (useFirebase()) {
    try {
      await fbSetDoc('affiliations', record.id, record, { merge: false });
      return { ...record, storedIn: storageMode() };
    } catch (err) {
      noteFirebaseError(err, 'recordAffiliation');
      record.firebaseSaveError = firebaseErrorText(err);
      record.storedIn = 'local_backup';
    }
  }

  const affiliations = readJson(AFFILIATIONS_FILE, []).map(normalizeAffiliationRecord);
  affiliations.push(record);
  writeJson(AFFILIATIONS_FILE, affiliations);
  return { ...record, storedIn: record.storedIn || 'local' };
}



// ============================================================
// CarteraPro Ventas / onboarding
// Se mantiene separado de las sesiones del emisor para no mezclar flujos.
// ============================================================
function normalizeCarteraProSession(item = {}) {
  return {
    ...item,
    phone: normalizePhone(item.phone),
    updatedAt: toIso(item.updatedAt) || nowIso(),
    createdAt: toIso(item.createdAt) || nowIso()
  };
}

export async function getCarteraProSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('carterapro_sales_sessions', clean);
      return doc ? normalizeCarteraProSession({ phone: clean, ...doc }) : null;
    } catch (err) {
      noteFirebaseError(err, 'getCarteraProSession');
    }
  }
  const sessions = readJson(CARTERAPRO_SESSIONS_FILE, {});
  return sessions[clean] ? normalizeCarteraProSession(sessions[clean]) : null;
}

export async function setCarteraProSession(phone, session = {}) {
  const clean = normalizePhone(phone);
  const value = normalizeCarteraProSession({
    ...session,
    phone: clean,
    createdAt: session.createdAt || nowIso(),
    updatedAt: nowIso()
  });
  if (useFirebase()) {
    try {
      await fbSetDoc('carterapro_sales_sessions', clean, value, { merge: false });
      return value;
    } catch (err) {
      noteFirebaseError(err, 'setCarteraProSession');
    }
  }
  const sessions = readJson(CARTERAPRO_SESSIONS_FILE, {});
  sessions[clean] = { ...value, emergencyLocal: Boolean(firebaseDisabledReason) };
  writeJson(CARTERAPRO_SESSIONS_FILE, sessions);
  return value;
}

export async function clearCarteraProSession(phone) {
  const clean = normalizePhone(phone);
  if (useFirebase()) {
    try {
      await fbDeleteDoc('carterapro_sales_sessions', clean);
      return;
    } catch (err) {
      noteFirebaseError(err, 'clearCarteraProSession');
    }
  }
  const sessions = readJson(CARTERAPRO_SESSIONS_FILE, {});
  delete sessions[clean];
  writeJson(CARTERAPRO_SESSIONS_FILE, sessions);
}

function normalizeCarteraProLead(item = {}) {
  return {
    id: String(item.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`),
    phone: normalizePhone(item.phone),
    name: String(item.name || '').trim(),
    email: String(item.email || '').trim().toLowerCase(),
    company: String(item.company || '').trim(),
    portfolioSize: String(item.portfolioSize || '').trim(),
    plan: String(item.plan || '').trim().toLowerCase(),
    type: String(item.type || 'lead').trim().toLowerCase(),
    source: String(item.source || 'whatsapp').trim(),
    status: String(item.status || 'new').trim().toLowerCase(),
    note: String(item.note || '').trim(),
    createdAt: toIso(item.createdAt) || nowIso(),
    createdAtMs: Number(item.createdAtMs || Date.now()),
    updatedAt: toIso(item.updatedAt) || nowIso()
  };
}

export async function recordCarteraProLead(input = {}) {
  const lead = normalizeCarteraProLead(input);
  if (useFirebase()) {
    try {
      await fbSetDoc('carterapro_leads', lead.id, lead, { merge: true });
      return { ...lead, storedIn: storageMode() };
    } catch (err) {
      noteFirebaseError(err, 'recordCarteraProLead');
      lead.firebaseSaveError = firebaseErrorText(err);
    }
  }
  const list = readJson(CARTERAPRO_LEADS_FILE, []);
  const idx = list.findIndex(x => String(x.id) === lead.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...lead };
  else list.push(lead);
  writeJson(CARTERAPRO_LEADS_FILE, list);
  return { ...lead, storedIn: firebaseDisabledReason ? 'local_backup' : 'local' };
}

export async function loadCarteraProLeads({ limit = 300 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 300), 2000));
  if (useFirebase()) {
    try {
      const docs = await fbListDocs('carterapro_leads', { limit: max });
      return docs.map(x => normalizeCarteraProLead({ id: x.id, ...x }))
        .sort((a,b) => b.createdAtMs - a.createdAtMs).slice(0,max);
    } catch (err) {
      noteFirebaseError(err, 'loadCarteraProLeads');
    }
  }
  return readJson(CARTERAPRO_LEADS_FILE, []).map(normalizeCarteraProLead)
    .sort((a,b) => b.createdAtMs - a.createdAtMs).slice(0,max);
}

function normalizeOnboarding(item = {}) {
  return {
    ...item,
    token: String(item.token || '').trim(),
    phone: normalizePhone(item.phone),
    plan: String(item.plan || '').trim().toLowerCase(),
    method: String(item.method || '').trim().toLowerCase(),
    status: String(item.status || 'created').trim().toLowerCase(),
    createdAt: toIso(item.createdAt) || nowIso(),
    updatedAt: toIso(item.updatedAt) || nowIso(),
    expiresAt: toIso(item.expiresAt) || null
  };
}

export async function saveCarteraProOnboarding(input = {}) {
  const token = String(input.token || '').trim();
  if (!token) throw new Error('Token onboarding requerido');
  const existing = await getCarteraProOnboarding(token).catch(() => null);
  const value = normalizeOnboarding({ ...existing, ...input, token, updatedAt: nowIso() });
  if (useFirebase()) {
    try {
      await fbSetDoc('carterapro_onboarding', token, value, { merge: true });
      return { ...value, storedIn: storageMode() };
    } catch (err) {
      noteFirebaseError(err, 'saveCarteraProOnboarding');
      value.firebaseSaveError = firebaseErrorText(err);
    }
  }
  const list = readJson(CARTERAPRO_ONBOARDING_FILE, []);
  const idx = list.findIndex(x => String(x.token) === token);
  if (idx >= 0) list[idx] = { ...list[idx], ...value };
  else list.push(value);
  writeJson(CARTERAPRO_ONBOARDING_FILE, list);
  return { ...value, storedIn: firebaseDisabledReason ? 'local_backup' : 'local' };
}

export async function getCarteraProOnboarding(token) {
  const clean = String(token || '').trim();
  if (!clean) return null;
  if (useFirebase()) {
    try {
      const doc = await fbGetDoc('carterapro_onboarding', clean);
      return doc ? normalizeOnboarding({ token: clean, ...doc }) : null;
    } catch (err) {
      noteFirebaseError(err, 'getCarteraProOnboarding');
    }
  }
  const list = readJson(CARTERAPRO_ONBOARDING_FILE, []);
  const found = list.find(x => String(x.token) === clean);
  return found ? normalizeOnboarding(found) : null;
}

export async function loadCarteraProOnboarding({ limit = 300 } = {}) {
  const max = Math.max(1, Math.min(Number(limit || 300), 2000));
  if (useFirebase()) {
    try {
      const docs = await fbListDocs('carterapro_onboarding', { limit: max });
      return docs.map(x => normalizeOnboarding({ token: x.token || x.id, ...x }))
        .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,max);
    } catch (err) {
      noteFirebaseError(err, 'loadCarteraProOnboarding');
    }
  }
  return readJson(CARTERAPRO_ONBOARDING_FILE, []).map(normalizeOnboarding)
    .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,max);
}

export async function storeCarteraProUpload({ token, localPath, filename, contentType = 'application/zip', size = 0 }) {
  const onboarding = await getCarteraProOnboarding(token);
  if (!onboarding) throw new Error('Solicitud de carga no encontrada');

  const safeName = String(filename || 'cartera.zip').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 140);
  const bucketName = String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  let upload = {
    filename: safeName,
    contentType,
    size: Number(size || 0),
    localPath: String(localPath || ''),
    storedIn: 'render_local',
    uploadedAt: nowIso()
  };

  if (bucketName && useFirebase()) {
    try {
      const bucket = admin.storage().bucket(bucketName);
      const destination = `carterapro/onboarding/${safeKey(token)}/${Date.now()}_${safeName}`;
      await bucket.upload(localPath, {
        destination,
        resumable: false,
        metadata: { contentType, metadata: { onboardingToken: token } }
      });
      upload = {
        ...upload,
        storageBucket: bucketName,
        storagePath: destination,
        localPath: '',
        storedIn: 'firebase_storage'
      };
      try { fs.unlinkSync(localPath); } catch {}
    } catch (err) {
      console.error('Firebase Storage falló; se conserva archivo local temporal:', err?.message || err);
      upload.storageError = firebaseErrorText(err);
    }
  }

  await saveCarteraProOnboarding({
    ...onboarding,
    upload,
    status: 'files_received',
    completedAt: nowIso()
  });
  return upload;
}

export function getFirebaseStorageBucketName() {
  return String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
}

export async function getAdminSummary() {
  const usersObj = await loadUsers();
  const policies = await loadPolicies({ limit: 300 });
  const affiliations = await loadAffiliations({ limit: 300 });

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
    firebase: firestoreStatus(),
    lastFolioNumber: await getLastFolioNumber(),
    users: enrichedUsers,
    policies: policies.slice().reverse(),
    affiliations: affiliations.slice().reverse(),
    totals: {
      users: users.length,
      activeUsers: users.filter(u => u.active).length,
      totalIssued: policies.length,
      affiliations: affiliations.length,
      pending: policies.filter(p => p.status === 'pending').length,
      paid: policies.filter(p => p.status === 'paid').length
    }
  };
}
