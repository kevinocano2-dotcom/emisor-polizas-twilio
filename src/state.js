import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const DATA_DIR = path.join(process.cwd(), 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POLICIES_FILE = path.join(DATA_DIR, 'policies.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const AFFILIATIONS_FILE = path.join(DATA_DIR, 'affiliations.json');

let db = null;
let firebaseReady = false;
let firebaseDisabledReason = '';

function isFirestoreQuotaError(err) {
  const msg = String(err?.message || err?.details || err || '');
  return err?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

function noteFirestoreError(err, action = 'Firestore') {
  if (isFirestoreQuotaError(err)) {
    firebaseDisabledReason = 'Firestore quota exceeded';
    console.error(`${action}: cuota de Firestore agotada. No se cambia a modo local para evitar separar datos.`, err.message || err);
  } else {
    firebaseDisabledReason = '';
    console.error(`${action}: error Firestore.`, err.message || err);
  }
}



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

export function firestoreStatus() {
  return {
    firebaseReady: Boolean(db),
    firebaseDisabledReason
  };
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
    try {
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
    } catch (err) {
      noteFirestoreError(err, 'getLastFolioNumber');
      throw err;
    }
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

function upperPolicyText(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanPolicyText(value) {
  return String(value || '').trim();
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

export async function loadPolicies({ limit = 500 } = {}) {
  if (useFirebase()) {
    try {
      const max = Math.max(1, Math.min(Number(limit || 500), 1000));
      // Sin orderBy para no ocultar pólizas antiguas que no tenían createdAtMs.
      const snap = await db.collection('policies')
        .limit(max)
        .get();

      return snap.docs
        .map(doc => normalizePolicy({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    } catch (err) {
      noteFirestoreError(err, 'loadPolicies');
      throw err;
    }
  }

  return readJson(POLICIES_FILE, []);
}

function normalizePolicy(policy) {
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
    paidAt: toIso(policy.paidAt)
  };
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

  const record = {
    id: `${nowMs}_${Math.random().toString(16).slice(2)}`,
    phone: clean,

    // Identificación principal
    folio: cleanPolicyText(folio || get('folio')),
    insuredName: upperPolicyText(insuredName || get('name')),
    filename: filename || '',

    // Datos capturados por WhatsApp / portal
    address: upperPolicyText(get('address')),
    auto: upperPolicyText(auto || get('auto')),
    body: upperPolicyText(get('body')),
    modelYear: cleanPolicyText(get('modelYear')),
    vin: upperPolicyText(vin || get('vin')),
    plates: upperPolicyText(get('plates')),

    // Datos fijos / calculados que aparecen en la póliza
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

    // Estado de cobranza
    status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
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


function normalizeMessage(message) {
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
    createdAt: toIso(message.createdAt) || new Date(createdAtMs).toISOString(),
    createdAtMs
  };
}

export async function recordMessage({ phone, direction, source = '', body = '', from = '', to = '', sid = '', mediaUrl = '', status = '' }) {
  const clean = normalizePhone(phone || from || to);
  const record = {
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
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now()
  };

  if (useFirebase()) {
    await db.collection('messages').doc(record.id).set({
      ...record,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return record;
  }

  const messages = readJson(MESSAGES_FILE, []);
  messages.push(record);
  writeJson(MESSAGES_FILE, messages);
  return record;
}

export async function loadMessages({ phone = '', limit = 200 } = {}) {
  const clean = normalizePhone(phone);
  const max = Math.max(1, Math.min(Number(limit || 200), 500));

  if (useFirebase()) {
    try {
      let query = db.collection('messages');

      if (clean) {
        query = query.where('phone', '==', clean).limit(max);
      } else {
        // Sin orderBy para no ocultar mensajes viejos sin createdAtMs.
        query = query.limit(max);
      }

      const snap = await query.get();

      return snap.docs
        .map(doc => normalizeMessage({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
        .slice(0, max);
    } catch (err) {
      noteFirestoreError(err, 'loadMessages');
      throw err;
    }
  }

  const messages = readJson(MESSAGES_FILE, []).map(normalizeMessage);
  return messages
    .filter(m => !clean || m.phone === clean)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, max);
}

export async function getConversationSummary() {
  let messages = [];
  try {
    messages = await loadMessages({ limit: 200 });
  } catch (err) {
    noteFirestoreError(err, 'getConversationSummary');
  }
  const byPhone = new Map();

  for (const msg of messages) {
    if (!msg.phone) continue;

    if (!byPhone.has(msg.phone)) {
      byPhone.set(msg.phone, {
        phone: msg.phone,
        lastBody: msg.body,
        lastDirection: msg.direction,
        lastSource: msg.source,
        lastAt: msg.createdAt,
        lastAtMs: msg.createdAtMs,
        totalMessages: 0,
        inboundCount: 0,
        outboundCount: 0
      });
    }

    const item = byPhone.get(msg.phone);
    item.totalMessages += 1;
    if (msg.direction === 'inbound') item.inboundCount += 1;
    if (msg.direction === 'outbound') item.outboundCount += 1;

    if (msg.createdAtMs > item.lastAtMs) {
      item.lastBody = msg.body;
      item.lastDirection = msg.direction;
      item.lastSource = msg.source;
      item.lastAt = msg.createdAt;
      item.lastAtMs = msg.createdAtMs;
    }
  }

  return Array.from(byPhone.values()).sort((a, b) => b.lastAtMs - a.lastAtMs);
}




export async function setPolicyStatus(policyId, status) {
  const id = String(policyId || '').trim();
  const normalized = String(status || '').trim().toLowerCase();

  if (!id) throw new Error('ID de póliza inválido');
  if (!['pending', 'paid'].includes(normalized)) {
    throw new Error('Estatus inválido');
  }

  if (useFirebase()) {
    const ref = db.collection('policies').doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      throw new Error('Póliza no encontrada');
    }

    const update = {
      status: normalized,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (normalized === 'paid') {
      update.paidAt = admin.firestore.FieldValue.serverTimestamp();
    } else {
      update.paidAt = null;
    }

    await ref.set(update, { merge: true });

    const saved = await ref.get();
    return normalizePolicy({ id: saved.id, ...saved.data() });
  }

  const policies = await loadPolicies();
  const idx = policies.findIndex(p => String(p.id) === id);

  if (idx < 0) {
    throw new Error('Póliza no encontrada');
  }

  policies[idx].status = normalized;
  policies[idx].updatedAt = new Date().toISOString();
  policies[idx].paidAt = normalized === 'paid' ? new Date().toISOString() : null;

  writeJson(POLICIES_FILE, policies);
  return normalizePolicy(policies[idx]);
}


export async function getPolicyStatsForPhone(phone) {
  const clean = normalizePhone(phone);
  let userPolicies = [];

  if (useFirebase()) {
    try {
      const snap = await db.collection('policies')
        .where('phone', '==', clean)
        .limit(500)
        .get();

      userPolicies = snap.docs
        .map(doc => normalizePolicy({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    } catch (err) {
      noteFirestoreError(err, 'getPolicyStatsForPhone');
      throw err;
    }
  } else {
    const policies = await loadPolicies();
    userPolicies = policies.filter(p => p.phone === clean);
  }

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



function normalizeAffiliationRecord(item) {
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
      const max = Math.max(1, Math.min(Number(limit || 500), 1000));
      const snap = await db.collection('affiliations')
        .limit(max)
        .get();

      return snap.docs
        .map(doc => normalizeAffiliationRecord({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    } catch (err) {
      noteFirestoreError(err, 'loadAffiliations');
      throw err;
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
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs
  });

  if (useFirebase()) {
    await db.collection('affiliations').doc(record.id).set({
      ...record,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return record;
  }

  const affiliations = await loadAffiliations();
  affiliations.push(record);
  writeJson(AFFILIATIONS_FILE, affiliations);
  return record;
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
