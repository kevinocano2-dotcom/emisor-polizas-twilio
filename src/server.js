import twilio from 'twilio';
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import { buildAffiliationPdfBuffer, normalizeAffiliationInput } from './affiliation_generator.js';
import { deleteUser, getAdminSummary, getConversationSummary, getLastFolioNumber, liquidatePolicies, loadMessages, markPoliciesPaid, nextFolioNumber, normalizePhone, recordAffiliation, recordMessage, setLastFolioNumber, setPolicyStatus, setUserActive, storageMode, upsertUser, firestoreStatus, getSession, loadCarteraProLeads, loadCarteraProOnboarding, getCarteraProOnboarding, saveCarteraProOnboarding, storeCarteraProUpload, getFirebaseStorageBucketName, recordCarteraProLead, loadConversationIndex, markConversationRead, rebuildConversationIndex } from './state.js';
import { handleTwilioMessage } from './flow_twilio.js';
import { handleCarteraProMessage, isEmitterSpecificCommand, isGeneralHelp, combinedHelp, validateOnboardingToken, onboardingEncryptionReady, encryptCredentials, decryptCredentials } from './carterapro_sales.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 8080);
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');
const CARTERAPRO_UPLOAD_DIR = path.join(process.cwd(), 'data', 'carterapro_uploads');
const CARTERAPRO_UPLOAD_MAX_MB = Math.max(10, Math.min(Number(process.env.CARTERAPRO_UPLOAD_MAX_MB || 100), 250));
fs.mkdirSync(CARTERAPRO_UPLOAD_DIR, { recursive: true });

process.on('unhandledRejection', err => {
  console.error('Promesa no manejada. Se evita caída del servidor:', err?.message || err);
});


app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanMediaUrls(mediaUrl, mediaUrls) {
  return []
    .concat(Array.isArray(mediaUrls) ? mediaUrls : [])
    .concat(mediaUrl || [])
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
}

function twimlMessage(reply = {}) {
  let messages = [];

  if (Array.isArray(reply.messages) && reply.messages.length) {
    messages = reply.messages.map(message => ({
      body: message.body || '',
      mediaUrls: cleanMediaUrls(message.mediaUrl, message.mediaUrls)
    }));
  } else {
    const urls = cleanMediaUrls(reply.mediaUrl, reply.mediaUrls);

    // Twilio/WhatsApp puede ignorar medios adicionales si van todos dentro
    // del mismo <Message>. Por eso, si hay varios PDFs, se mandan como
    // mensajes separados para asegurar que llegue la afiliación también.
    if (urls.length > 1) {
      messages = urls.map((url, index) => ({
        body: index === 0 ? (reply.body || '') : `Documento adicional ${index + 1}:`,
        mediaUrls: [url]
      }));
    } else {
      messages = [{
        body: reply.body || '',
        mediaUrls: urls
      }];
    }
  }

  if (!messages.length) messages = [{ body: reply.body || '', mediaUrls: [] }];

  const xmlMessages = messages.map(message => {
    const bodyXml = message.body ? `<Body>${xmlEscape(message.body)}</Body>` : '';
    const mediaXml = message.mediaUrls.map(url => `<Media>${xmlEscape(url)}</Media>`).join('');
    return `<Message>${bodyXml}${mediaXml}</Message>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlMessages}</Response>`;
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function ensureGeneratedDir() {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function mediaUrlFor(req, filename) {
  const token = process.env.MEDIA_ROUTE_TOKEN || 'cambia_este_token_largo';
  return `${requestBaseUrl(req)}/media/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
}

function adminTokenExpected() {
  return process.env.ADMIN_TOKEN || process.env.MEDIA_ROUTE_TOKEN || '';
}

function adminTokenFromReq(req) {
  return req.headers['x-admin-token'] || req.query.token || req.body?.token || '';
}

function formatWhatsAppAddress(value) {
  const raw = String(value || '').trim();

  if (!raw) return '';
  if (raw.startsWith('whatsapp:')) return raw;

  const clean = normalizePhone(raw);
  if (!clean) return '';

  return `whatsapp:+${clean}`;
}

function twilioFromAddress() {
  return formatWhatsAppAddress(
    process.env.TWILIO_WHATSAPP_FROM ||
    process.env.TWILIO_FROM ||
    process.env.WHATSAPP_FROM ||
    ''
  );
}

function adminNotifyNumbers() {
  const raw = process.env.ADMIN_NOTIFY_NUMBERS || '5216622434983';
  return raw
    .split(',')
    .map(v => normalizePhone(v))
    .filter(Boolean);
}

function buildAdminNotificationText(info = {}) {
  if (info.kind === 'carterapro_sales' && info.customText) return String(info.customText);
  if (info.kind === 'emit_error_backup') {
    const data = info.capturedData || {};
    const recovered = info.recoveryPolicy || {};
    const folio = recovered.folio || 'NO ASIGNADO / NO GUARDADO';
    const cliente = recovered.insuredName || data.name || '-';
    const domicilio = recovered.address || data.address || '-';
    const auto = recovered.auto || data.auto || '-';
    const carroceria = recovered.body || data.body || '-';
    const modelo = recovered.modelYear || data.modelYear || '-';
    const serie = recovered.vin || data.vin || '-';
    const total = recovered.total || '575.00';
    const vigencia = recovered.nextDate || '-';

    const lines = [
      '⚠️ MODO EMERGENCIA / RESPALDO WHATSAPP',
      'El PDF sí pudo generarse, pero Firebase no guardó o hubo error de sistema.',
      `Error: ${info.error || '-'}`,
      `Usuario: ${info.phone || '-'}`,
      '',
      'DATOS PARA CAPTURAR DESPUÉS:',
      `Folio: ${folio}`,
      `Cliente: ${cliente}`,
      `Domicilio: ${domicilio}`,
      `Auto: ${auto}`,
      `Carrocería: ${carroceria}`,
      `Modelo: ${modelo}`,
      `Serie: ${serie}`,
      `Total: ${total}`,
      `Vigencia: ${vigencia}`
    ];

    if (recovered.mediaUrl) {
      lines.push('', `PDF póliza temporal: ${recovered.mediaUrl}`);
    }

    const affiliation = info.recoveryAffiliation || {};
    if (Object.keys(affiliation).length) {
      lines.push(
        '',
        'DATOS AFILIACIÓN:',
        `EXP / Placa: ${affiliation.exp || '-'}`,
        `Cliente 1: ${affiliation.nombre1 || '-'}`,
        `Cliente 2: ${affiliation.nombre2 || '-'}`,
        `Teléfono cliente: ${affiliation.customerPhone || '-'}`,
        `Auto: ${affiliation.auto || '-'}`,
        `Tipo: ${affiliation.body || '-'}`,
        `Modelo: ${affiliation.modelYear || '-'}`,
        `Serie: ${affiliation.vin || '-'}`,
        `Color: ${affiliation.color || '-'}`
      );
      if (affiliation.mediaUrl) lines.push(`PDF afiliación temporal: ${affiliation.mediaUrl}`);
    }

    lines.push('', 'Revisar/capturar en Firebase cuando se recupere Firestore. Los enlaces temporales dependen de que Render siga corriendo.');
    return lines.join('\n');
  }

  if (info.kind === 'affiliation_generated') {
    const a = info.affiliation || {};
    return [
      'Nueva hoja de afiliación generada',
      `Usuario: ${info.phone || '-'}`,
      `EXP / Placa: ${a.exp || '-'}`,
      `Cliente: ${a.nombre1 || '-'}`,
      a.nombre2 ? `Clientes adicionales: ${a.nombre2}` : '',
      `Teléfono cliente guardado: ${a.customerPhone || '-'}`,
      `Auto: ${a.auto || '-'}`,
      `Tipo: ${a.body || '-'}`,
      `Modelo: ${a.modelYear || '-'}`,
      `Serie: ${a.vin || '-'}`,
      `Color: ${a.color || '-'}`,
      info.mediaUrl ? `PDF: ${info.mediaUrl}` : ''
    ].filter(Boolean).join('\n');
  }

  if (info.kind === 'policy_affiliation_generated') {
    const a = info.affiliation || {};
    const folios = Array.isArray(info.pendingFolios) && info.pendingFolios.length
      ? info.pendingFolios.join(', ')
      : 'Sin folios pendientes';
    const pendingText = Number(info.pendingCount || 0) === 1
      ? '1 pendiente'
      : `${Number(info.pendingCount || 0)} pendientes`;

    return [
      'Nueva póliza + afiliación generadas',
      `Usuario: ${info.phone || '-'}`,
      `Folio póliza: ${info.folio || '-'}`,
      `EXP / Placa: ${a.exp || '-'}`,
      `Cliente: ${info.insuredName || a.nombre1 || '-'}`,
      a.nombre2 ? `Clientes adicionales: ${a.nombre2}` : '',
      `Teléfono cliente guardado: ${a.customerPhone || '-'}`,
      `Auto: ${info.auto || a.auto || '-'}`,
      `Serie: ${info.vin || a.vin || '-'}`,
      `Color: ${a.color || '-'}`,
      `Pendientes del usuario: ${pendingText}`,
      `Folios pendientes: ${folios}`,
      info.affiliationMediaUrl ? `PDF afiliación: ${info.affiliationMediaUrl}` : ''
    ].filter(Boolean).join('\n');
  }

  const folios = Array.isArray(info.pendingFolios) && info.pendingFolios.length
    ? info.pendingFolios.join(', ')
    : 'Sin folios pendientes';

  const pendingText = Number(info.pendingCount || 0) === 1
    ? '1 pendiente'
    : `${Number(info.pendingCount || 0)} pendientes`;

  return [
    'Nueva póliza emitida',
    `Usuario: ${info.phone || '-'}`,
    `Folio: ${info.folio || '-'}`,
    `Cliente: ${info.insuredName || '-'}`,
    `Auto: ${info.auto || '-'}`,
    `Serie: ${info.vin || '-'}`,
    `Pendientes del usuario: ${pendingText}`,
    `Folios pendientes: ${folios}`
  ].join('\n');
}

async function sendAdminNotification(info = {}) {
  const from = twilioFromAddress();
  const recipients = adminNotifyNumbers();

  if (!from || !recipients.length) return;

  const client = twilioClient();
  const body = buildAdminNotificationText(info);

  for (const phone of recipients) {
    const to = formatWhatsAppAddress(phone);

    try {
      const sent = await client.messages.create({ from, to, body });

      await recordMessage({
        phone,
        direction: 'outbound',
        source: 'admin_notify',
        body,
        from,
        to,
        sid: sent.sid || '',
        status: sent.status || 'sent'
      }).catch(() => {});
    } catch (err) {
      console.error('No se pudo enviar aviso admin a', phone, err.message || err);
    }
  }
}

function twilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';

  if (!sid || !token) {
    throw new Error('Faltan TWILIO_ACCOUNT_SID y/o TWILIO_AUTH_TOKEN en Render Environment.');
  }

  return twilio(sid, token);
}

function requireAdmin(req, res, next) {
  const expected = adminTokenExpected();
  if (!expected) return next();
  if (String(adminTokenFromReq(req)) === String(expected)) return next();
  return res.status(401).json({ error: 'Token de administrador inválido' });
}

function apiError(res, err, fallback = 'Error del servidor') {
  const msg = err?.message || err?.details || fallback;
  console.error(fallback + ':', msg);
  res.status(500).json({
    ok: false,
    error: String(msg),
    firestore: firestoreStatus()
  });
}


function escHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function isEmitterMode(session) {
  return Boolean(session && ['policy','policy_affiliation','affiliation'].includes(session.mode));
}

async function shouldUseEmitter(phone, body) {
  if (isEmitterSpecificCommand(body)) return true;
  const session = await getSession(phone).catch(() => null);
  if (isEmitterMode(session)) return true;
  const x = String(body || '').trim().toUpperCase();
  if (/^CANCELAR$/i.test(x) && isEmitterMode(session)) return true;
  return false;
}

function buildOnboardingPage({ title, subtitle, bodyHtml, error = '' }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Segoe UI,Arial;background:radial-gradient(circle at 10% 0,rgba(79,107,255,.15),transparent 30%),#f5f7fb;color:#111827;padding:26px}.wrap{max-width:720px;margin:auto}.brand{font-weight:950;font-size:20px;margin:0 0 15px}.brand span{color:#4f6bff}.card{background:#fff;border:1px solid #e2e7f0;border-radius:22px;padding:24px;box-shadow:0 24px 65px rgba(32,45,82,.08)}h1{font-size:27px;letter-spacing:-1px;margin:0 0 7px}p{color:#697386;line-height:1.55}label{display:block;font-size:10px;font-weight:900;color:#697386;text-transform:uppercase;letter-spacing:.5px;margin:13px 0 5px}input,select,textarea{width:100%;border:1px solid #dce2eb;border-radius:11px;padding:11px;font:inherit}button{width:100%;margin-top:16px;border:0;border-radius:12px;min-height:47px;background:linear-gradient(135deg,#4f6bff,#7b5cff);color:#fff;font-weight:900;cursor:pointer}.note{background:#effbf6;border:1px solid #d3eee3;color:#176e55;padding:11px;border-radius:12px;font-size:11px;line-height:1.5}.warn{background:#fff5f6;border:1px solid #f0d7dc;color:#9b3043;padding:11px;border-radius:12px;font-size:11px}.small{font-size:10px;color:#8a93a3}.success{font-size:44px;margin-bottom:5px}</style></head><body><div class="wrap"><div class="brand">Cartera<span>Pro</span></div><div class="card"><h1>${escHtml(title)}</h1><p>${escHtml(subtitle)}</p>${error?`<div class="warn">${escHtml(error)}</div>`:''}${bodyHtml}</div></div></body></html>`;
}

async function notifyCarteraProAdmin(text) {
  try {
    await sendAdminNotification({ kind:'carterapro_sales', customText:text });
  } catch (err) {
    console.error('No se pudo avisar CarteraPro a administración:', err?.message || err);
  }
}

app.get('/health', async (req, res) => {
  try {
    res.json({
      ok: true,
      provider: 'twilio',
      storageMode: storageMode(),
      firestore: firestoreStatus(),
      lastFolio: await getLastFolioNumber()
    });
  } catch (err) {
    apiError(res, err, 'Error en health');
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json({
      folioPrefix: FOLIO_PREFIX,
      lastFolioNumber: await getLastFolioNumber(),
      storageMode: storageMode(),
      firestore: firestoreStatus()
    });
  } catch (err) {
    apiError(res, err, 'Error cargando settings');
  }
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const n = Number(req.body.lastFolioNumber);
    if (!n || n < 1) return res.status(400).json({ error: 'lastFolioNumber inválido' });
    await setLastFolioNumber(n);
    res.json({ ok: true, lastFolioNumber: await getLastFolioNumber() });
  } catch (err) {
    apiError(res, err, 'Error guardando settings');
  }
});

let adminSummaryCache = { expires: 0, data: null };

app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    if (adminSummaryCache.data && adminSummaryCache.expires > now && !req.query.fresh) {
      return res.json(adminSummaryCache.data);
    }

    const data = await getAdminSummary();
    adminSummaryCache = { expires: now + 15000, data };
    res.json(data);
  } catch (err) {
    apiError(res, err, 'Error cargando resumen admin');
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const user = await upsertUser({
      phone: req.body.phone,
      name: req.body.name,
      active: req.body.active !== false
    });
    res.json({ ok: true, user, summary: await getAdminSummary() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:phone', requireAdmin, async (req, res) => {
  try {
    let user;
    if (Object.prototype.hasOwnProperty.call(req.body, 'active')) {
      user = await setUserActive(req.params.phone, Boolean(req.body.active));
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
      user = await upsertUser({
        phone: req.params.phone,
        name: req.body.name,
        active: user ? user.active : req.body.active !== false
      });
    }
    res.json({ ok: true, user, summary: await getAdminSummary() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:phone', requireAdmin, async (req, res) => {
  await deleteUser(req.params.phone);
  res.json({ ok: true, summary: await getAdminSummary() });
});

app.post('/api/admin/users/:phone/pay', requireAdmin, async (req, res) => {
  try {
    const count = Number(req.body.count || 0);
    const marked = await markPoliciesPaid(req.params.phone, count);
    res.json({ ok: true, marked, summary: await getAdminSummary() });
  } catch (err) {
    console.error('Error al marcar pagadas:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron marcar como pagadas. Revisa logs de Render.' });
  }
});

app.post('/api/admin/users/:phone/liquidate', requireAdmin, async (req, res) => {
  const marked = await liquidatePolicies(req.params.phone);
  res.json({ ok: true, marked, summary: await getAdminSummary() });
});

app.patch('/api/admin/policies/:id/status', requireAdmin, async (req, res) => {
  try {
    const policy = await setPolicyStatus(req.params.id, req.body.status);
    adminSummaryCache = { expires: 0, data: null };
    res.json({
      ok: true,
      policy,
      summary: await getAdminSummary()
    });
  } catch (err) {
    console.error('Error cambiando estatus de póliza:', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'No se pudo cambiar el estatus de la póliza.'
    });
  }
});


function latestByPhone(list = []) {
  const map = new Map();
  for (const item of list) {
    const phone = normalizePhone(item.phone);
    if (!phone) continue;
    const current = map.get(phone);
    const t = Number(item.createdAtMs || new Date(item.createdAt || 0).getTime() || 0);
    const ct = current ? Number(current.createdAtMs || new Date(current.createdAt || 0).getTime() || 0) : -1;
    if (!current || t >= ct) map.set(phone,item);
  }
  return map;
}
function salesStageFor(lead, onboarding) {
  const os = String(onboarding?.status || '').toLowerCase();
  if (os === 'files_received') return { key:'files_received', label:'ZIP recibido', priority:8 };
  if (os === 'credentials_received') return { key:'credentials_received', label:'Acceso recibido', priority:8 };

  const type = String(lead?.type || '').toLowerCase();
  const status = String(lead?.status || '').toLowerCase();
  if (type === 'registration' || status === 'pending_activation') return {key:'registration',label:'Registro pendiente',priority:7};
  if (type === 'purchase_reported' || status === 'pending_verification') return {key:'purchase',label:'Pago reportado',priority:6};
  if (type.includes('onboarding') || status === 'awaiting_documents') return {key:'onboarding',label:'Carga inicial',priority:5};
  if (type === 'demo' || status === 'demo_sent') return {key:'demo',label:'Demo enviada',priority:3};
  if (lead) return {key:'new',label:'Prospecto',priority:2};
  return {key:'unknown',label:'Sin clasificar',priority:0};
}
async function buildCarteraProInbox() {
  const [conversations, leads, onboarding] = await Promise.all([
    loadConversationIndex({limit:2000}),
    loadCarteraProLeads({limit:2000}),
    loadCarteraProOnboarding({limit:2000})
  ]);

  const latestLead = latestByPhone(leads);
  const latestOnboarding = latestByPhone(onboarding);

  return conversations.map(c=>{
    const phone=normalizePhone(c.phone);
    const lead=latestLead.get(phone)||null;
    const onboard=latestOnboarding.get(phone)||null;
    const stage=salesStageFor(lead,onboard);
    const area = c.area === 'unknown' && lead ? 'carterapro' : c.area;
    return {
      ...c,
      area,
      name:lead?.name || onboard?.name || '',
      email:lead?.email || onboard?.email || '',
      company:lead?.company || onboard?.company || '',
      plan:lead?.plan || onboard?.plan || '',
      stage,
      leadType:lead?.type || '',
      leadStatus:lead?.status || '',
      onboardingMethod:onboard?.method || '',
      onboardingStatus:onboard?.status || '',
      onboardingToken:onboard?.token || ''
    };
  }).sort((a,b)=>b.lastAtMs-a.lastAtMs);
}

app.get('/api/admin/carterapro/inbox', requireAdmin, async (req,res)=>{
  try{
    const conversations=await buildCarteraProInbox();
    const unread=conversations.reduce((n,c)=>n+Number(c.unreadCount||0),0);
    const sales=conversations.filter(c=>c.area==='carterapro');
    res.json({
      ok:true,
      totals:{
        conversations:conversations.length,
        sales:sales.length,
        unread,
        purchase:sales.filter(c=>c.stage?.key==='purchase').length,
        registration:sales.filter(c=>c.stage?.key==='registration').length,
        onboarding:sales.filter(c=>['onboarding','credentials_received','files_received'].includes(c.stage?.key)).length
      },
      conversations
    });
  }catch(err){
    console.error('Error inbox CarteraPro:',err);
    res.status(500).json({ok:false,error:err.message||'No se pudo cargar el inbox'});
  }
});

app.get('/api/admin/carterapro/thread/:phone', requireAdmin, async (req,res)=>{
  try{
    const phone=normalizePhone(req.params.phone);
    const [messages, leads, onboarding, conversations]=await Promise.all([
      loadMessages({phone,limit:500}),
      loadCarteraProLeads({limit:2000}),
      loadCarteraProOnboarding({limit:2000}),
      loadConversationIndex({limit:2000})
    ]);
    const lead=latestByPhone(leads).get(phone)||null;
    const onboard=latestByPhone(onboarding).get(phone)||null;
    const conversation=conversations.find(x=>normalizePhone(x.phone)===phone)||null;
    await markConversationRead(phone).catch(()=>{});
    res.json({
      ok:true,
      phone,
      conversation,
      lead,
      onboarding:onboard,
      stage:salesStageFor(lead,onboard),
      messages:messages.slice().reverse()
    });
  }catch(err){
    console.error('Error thread CarteraPro:',err);
    res.status(500).json({ok:false,error:err.message||'No se pudo cargar la conversación'});
  }
});

app.post('/api/admin/carterapro/read/:phone', requireAdmin, async (req,res)=>{
  try{
    const conversation=await markConversationRead(req.params.phone);
    res.json({ok:true,conversation});
  }catch(err){
    res.status(500).json({ok:false,error:err.message||'No se pudo marcar como leído'});
  }
});

app.post('/api/admin/carterapro/rebuild-index', requireAdmin, async (req,res)=>{
  try{
    const conversations=await rebuildConversationIndex({limit:5000});
    res.json({ok:true,count:conversations.length});
  }catch(err){
    console.error('Error reconstruyendo índice:',err);
    res.status(500).json({ok:false,error:err.message||'No se pudo reconstruir el índice'});
  }
});

app.get('/api/admin/conversations', requireAdmin, async (req, res) => {
  try {
    res.json({
      ok: true,
      conversations: await getConversationSummary()
    });
  } catch (err) {
    console.error('Error cargando conversaciones:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las conversaciones.' });
  }
});

app.get('/api/admin/messages/:phone', requireAdmin, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 200);
    const messages = await loadMessages({ phone: req.params.phone, limit });
    res.json({
      ok: true,
      phone: normalizePhone(req.params.phone),
      messages: messages.slice().reverse()
    });
  } catch (err) {
    console.error('Error cargando mensajes:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar los mensajes.' });
  }
});

app.post('/api/admin/messages/reply', requireAdmin, async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const body = String(req.body.body || '').trim();

    if (!phone) return res.status(400).json({ ok: false, error: 'Número inválido.' });
    if (!body) return res.status(400).json({ ok: false, error: 'Mensaje vacío.' });

    const from = twilioFromAddress();
    if (!from) {
      return res.status(400).json({
        ok: false,
        error: 'Falta configurar TWILIO_WHATSAPP_FROM en Render. Ejemplo: whatsapp:+5216623889875'
      });
    }

    const to = formatWhatsAppAddress(phone);
    const client = twilioClient();

    const sent = await client.messages.create({
      from,
      to,
      body
    });

    const message = await recordMessage({
      phone,
      direction: 'outbound',
      source: 'manual',
      body,
      from,
      to,
      sid: sent.sid || '',
      status: sent.status || 'sent'
    });

    res.json({
      ok: true,
      message,
      conversations: await getConversationSummary(),
      messages: (await loadMessages({ phone, limit: 200 })).slice().reverse()
    });
  } catch (err) {
    console.error('Error enviando respuesta manual:', err);
    res.status(500).json({ ok: false, error: err.message || 'No se pudo enviar el mensaje manual.' });
  }
});


app.post('/api/emitir', requireAdmin, async (req, res) => {
  const data = req.body || {};
  if (!data.name || !data.auto || !data.vin) {
    return res.status(400).json({ error: 'Faltan name, auto o vin' });
  }
  const n = await nextFolioNumber();
  const policy = normalizePolicyInput({ ...data, plates: '' }, n, FOLIO_PREFIX, new Date());
  const pdf = buildPdfBuffer(policy);
  const filename = `${cleanFileName(policy.folio)}_${cleanFileName(policy.name)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdf);
});


app.post('/api/admin/affiliations', requireAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    const affiliation = normalizeAffiliationInput({
      ...data,
      names: data.names || data.affiliateNames,
      plates: data.plates || data.exp || data.placa,
      customerPhone: data.customerPhone || data.numeroCliente || data.telefono,
      auto: data.auto || data.marca,
      body: data.body || data.tipo,
      modelYear: data.modelYear || data.modelo,
      vin: data.vin || data.serie
    }, new Date());

    const missing = [];
    if (!affiliation.exp) missing.push('placa / EXP');
    if (!affiliation.customerPhone) missing.push('número del cliente / teléfono');
    if (!affiliation.nombre1) missing.push('nombre del cliente');
    if (!affiliation.auto) missing.push('marca / vehículo');
    if (!affiliation.body) missing.push('tipo');
    if (!affiliation.modelYear) missing.push('modelo');
    if (!affiliation.vin) missing.push('serie / VIN');
    if (!affiliation.color) missing.push('color');

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Faltan datos: ${missing.join(', ')}`
      });
    }

    ensureGeneratedDir();
    const pdf = await buildAffiliationPdfBuffer(affiliation);
    const filename = `AFILIACION_${cleanFileName(affiliation.exp || 'SIN_EXP')}_${cleanFileName(affiliation.nombre1 || 'CLIENTE')}.pdf`;
    const filepath = path.join(GENERATED_DIR, filename);
    const mediaUrl = mediaUrlFor(req, filename);

    fs.writeFileSync(filepath, pdf);

    const record = await recordAffiliation({
      phone: data.phone || data.emitterPhone || '',
      type: 'portal_html',
      policyFolio: data.policyFolio || '',
      filename,
      mediaUrl,
      affiliation,
      inputData: data
    });

    adminSummaryCache = { expires: 0, data: null };

    res.json({
      ok: true,
      affiliation: record,
      filename,
      mediaUrl,
      summary: await getAdminSummary()
    });
  } catch (err) {
    console.error('Error generando afiliación desde portal:', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'No se pudo generar la afiliación.'
    });
  }
});


// ============================================================
// CarteraPro Ventas / onboarding — mismo servicio de Render
// ============================================================
app.get('/carterapro/onboarding/acceso/:token', async (req, res) => {
  const valid = await validateOnboardingToken(req.params.token, 'portal');
  if (!valid.ok) return res.status(400).type('html').send(buildOnboardingPage({ title:'Enlace no disponible', subtitle:'Solicita uno nuevo por WhatsApp.', bodyHtml:'', error:valid.reason }));
  const disabled = !onboardingEncryptionReady();
  const bodyHtml = disabled
    ? `<div class="warn">El formulario de credenciales todavía no está habilitado. Falta configurar CARTERAPRO_ONBOARDING_SECRET en Render. Puedes regresar a WhatsApp y elegir la opción ZIP.</div>`
    : `<div class="note"><b>Seguridad:</b> usa de preferencia una contraseña temporal y cámbiala después de que terminemos la carga inicial. La contraseña no se envía por WhatsApp y se guarda cifrada.</div>
      <form method="post">
      <label>Nombre</label><input name="name" required maxlength="120" autocomplete="name">
      <label>Correo</label><input type="email" name="email" required maxlength="180" autocomplete="email">
      <label>Compañía / portal principal</label><input name="company" required maxlength="160" placeholder="AXA, Quálitas, GNP...">
      <label>Dirección del portal (opcional)</label><input name="portalUrl" maxlength="300" placeholder="https://...">
      <label>Usuario del portal</label><input name="portalUser" required maxlength="200" autocomplete="username">
      <label>Contraseña temporal</label><input type="password" name="portalPassword" required maxlength="300" autocomplete="current-password">
      <label style="text-transform:none;letter-spacing:0;font-size:11px"><input type="checkbox" name="authorization" value="yes" required style="width:auto;margin-right:6px">Autorizo el uso temporal de estos datos únicamente para realizar la carga inicial de mi cartera en CarteraPro.</label>
      <button type="submit">Enviar acceso de forma segura</button>
      <p class="small">CarteraPro no necesita que mantengas esta contraseña después de la carga inicial. Te recomendamos cambiarla al finalizar.</p></form>`;
  res.type('html').send(buildOnboardingPage({ title:'Carga inicial por portal', subtitle:'Proporciona acceso temporal para que podamos cargar tu cartera sin costo adicional.', bodyHtml }));
});

app.post('/carterapro/onboarding/acceso/:token', express.urlencoded({ extended:true }), async (req, res) => {
  const valid = await validateOnboardingToken(req.params.token, 'portal');
  if (!valid.ok) return res.status(400).type('html').send(buildOnboardingPage({ title:'Enlace no disponible', subtitle:'Solicita uno nuevo por WhatsApp.', bodyHtml:'', error:valid.reason }));
  if (!onboardingEncryptionReady()) return res.status(503).type('html').send(buildOnboardingPage({ title:'Formulario no habilitado', subtitle:'Elige la opción ZIP por WhatsApp.', bodyHtml:'', error:'Falta configurar el cifrado en Render.' }));
  if (req.body.authorization !== 'yes') return res.status(400).type('html').send(buildOnboardingPage({ title:'Falta autorización', subtitle:'Debes autorizar el uso temporal de los datos.', bodyHtml:'', error:'Marca la autorización para continuar.' }));
  const sensitive = {
    portalUrl:String(req.body.portalUrl||'').trim().slice(0,300),
    portalUser:String(req.body.portalUser||'').trim().slice(0,200),
    portalPassword:String(req.body.portalPassword||'').slice(0,300)
  };
  if (!sensitive.portalUser || !sensitive.portalPassword) return res.status(400).type('html').send(buildOnboardingPage({ title:'Datos incompletos', subtitle:'Revisa usuario y contraseña.', bodyHtml:'', error:'Usuario y contraseña son obligatorios.' }));
  const encrypted = encryptCredentials(sensitive);
  const updated = await saveCarteraProOnboarding({
    ...valid.record,
    name:String(req.body.name||'').trim().slice(0,120),
    email:String(req.body.email||'').trim().toLowerCase().slice(0,180),
    company:String(req.body.company||'').trim().slice(0,160),
    credentialsEncrypted:encrypted,
    credentialsVersion:'aes-256-gcm-v1',
    status:'credentials_received', completedAt:new Date().toISOString()
  });
  await recordCarteraProLead({ id:`onboarding_${updated.token}`, phone:updated.phone, name:updated.name, email:updated.email, company:updated.company, plan:updated.plan, type:'onboarding_portal', status:'received', note:'Credenciales cifradas recibidas' });
  notifyCarteraProAdmin(`🔐 CarteraPro: acceso temporal recibido\nCliente: ${updated.name||'-'}\nWhatsApp: ${updated.phone||'-'}\nCompañía: ${updated.company||'-'}\nPlan: ${updated.plan||'-'}\nRevisar en el panel CarteraPro de Render.`);
  res.type('html').send(buildOnboardingPage({ title:'Acceso recibido', subtitle:'La información fue registrada de forma cifrada.', bodyHtml:'<div class="success">✅</div><div class="note"><b>Listo.</b> Ya tenemos lo necesario para iniciar la carga de tu cartera. Cuando terminemos, cambia la contraseña temporal de tu portal.</div>' }));
});

app.get('/carterapro/onboarding/zip/:token', async (req, res) => {
  const valid = await validateOnboardingToken(req.params.token, 'zip');
  if (!valid.ok) return res.status(400).type('html').send(buildOnboardingPage({ title:'Enlace no disponible', subtitle:'Solicita uno nuevo por WhatsApp.', bodyHtml:'', error:valid.reason }));
  const bodyHtml = `<div class="note"><b>Qué incluir:</b> un archivo ZIP con los PDF de tus pólizas de los últimos 12 meses. Puedes incluir varias compañías.</div>
    <label>Nombre</label><input id="upName" required maxlength="120">
    <label>Correo</label><input id="upEmail" type="email" required maxlength="180">
    <label>Compañías que manejas</label><input id="upCompany" maxlength="200" placeholder="AXA, Quálitas, GNP...">
    <label>Archivo ZIP</label><input id="upFile" type="file" accept=".zip,application/zip,application/x-zip-compressed" required>
    <button id="upBtn" type="button" onclick="uploadZip()">Subir cartera</button>
    <div id="upStatus" class="small"></div>
    <p class="small">Máximo configurado: ${CARTERAPRO_UPLOAD_MAX_MB} MB. Si tu ZIP es mayor, divídelo y solicita otro enlace.</p>
    <script>
    async function uploadZip(){
      const name=document.getElementById('upName').value.trim();
      const email=document.getElementById('upEmail').value.trim();
      const company=document.getElementById('upCompany').value.trim();
      const file=document.getElementById('upFile').files[0];
      const status=document.getElementById('upStatus');
      const btn=document.getElementById('upBtn');
      if(!name||!email||!file){status.textContent='Completa nombre, correo y selecciona el ZIP.';return}
      if(!file.name.toLowerCase().endsWith('.zip')){status.textContent='El archivo debe terminar en .zip';return}
      if(file.size>${CARTERAPRO_UPLOAD_MAX_MB}*1024*1024){status.textContent='El ZIP excede el límite permitido.';return}
      btn.disabled=true;status.textContent='Subiendo... no cierres esta página.';
      try{
        const r=await fetch(location.pathname,{
          method:'POST',
          headers:{
            'Content-Type':'application/zip',
            'X-Cartera-File':encodeURIComponent(file.name),
            'X-Cartera-Name':encodeURIComponent(name),
            'X-Cartera-Email':encodeURIComponent(email),
            'X-Cartera-Company':encodeURIComponent(company)
          },
          body:file
        });
        const html=await r.text();
        document.open();document.write(html);document.close();
      }catch(e){status.textContent='No se pudo subir. Revisa tu conexión e intenta de nuevo.';btn.disabled=false}
    }
    </script>`;
  res.type('html').send(buildOnboardingPage({ title:'Sube tu cartera en ZIP', subtitle:'Carga los PDF de tus pólizas de los últimos 12 meses.', bodyHtml }));
});

app.post('/carterapro/onboarding/zip/:token', express.raw({ type:['application/zip','application/x-zip-compressed','application/octet-stream'], limit:`${CARTERAPRO_UPLOAD_MAX_MB}mb` }), async (req, res) => {
  let tempPath='';
  try {
    const valid = await validateOnboardingToken(req.params.token, 'zip');
    if (!valid.ok) return res.status(400).type('html').send(buildOnboardingPage({ title:'Enlace no disponible', subtitle:'Solicita uno nuevo por WhatsApp.', bodyHtml:'', error:valid.reason }));
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).type('html').send(buildOnboardingPage({ title:'Falta el ZIP', subtitle:'Selecciona tu archivo.', bodyHtml:'', error:'No se recibió ningún archivo.' }));
    const dec = value => { try { return decodeURIComponent(String(value||'')); } catch { return String(value||''); } };
    const original = dec(req.headers['x-cartera-file'] || 'cartera.zip').replace(/[\\/]/g,'_').slice(0,140);
    if (!/\.zip$/i.test(original)) return res.status(400).type('html').send(buildOnboardingPage({ title:'Archivo no válido', subtitle:'Necesitamos un archivo ZIP.', bodyHtml:'', error:'Comprime tus PDF en formato .zip e inténtalo de nuevo.' }));
    const safeName=original.replace(/[^a-zA-Z0-9._-]+/g,'_');
    tempPath=path.join(CARTERAPRO_UPLOAD_DIR,`${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${safeName}`);
    fs.writeFileSync(tempPath,req.body);
    const upload = await storeCarteraProUpload({ token:req.params.token, localPath:tempPath, filename:original, contentType:'application/zip', size:req.body.length });
    tempPath='';
    const updated = await saveCarteraProOnboarding({ ...valid.record, name:dec(req.headers['x-cartera-name']).trim().slice(0,120), email:dec(req.headers['x-cartera-email']).trim().toLowerCase().slice(0,180), company:dec(req.headers['x-cartera-company']).trim().slice(0,200), upload, status:'files_received', completedAt:new Date().toISOString() });
    await recordCarteraProLead({ id:`onboarding_${updated.token}`, phone:updated.phone, name:updated.name, email:updated.email, company:updated.company, plan:updated.plan, type:'onboarding_zip', status:'received', note:`ZIP recibido: ${upload.filename}` });
    notifyCarteraProAdmin(`📦 CarteraPro: ZIP recibido\nCliente: ${updated.name||'-'}\nWhatsApp: ${updated.phone||'-'}\nCompañías: ${updated.company||'-'}\nArchivo: ${upload.filename}\nAlmacenamiento: ${upload.storedIn}\nRevisar en panel CarteraPro.`);
    const storageMsg = upload.storedIn === 'firebase_storage' ? 'El archivo quedó guardado en Firebase Storage.' : 'El archivo quedó temporalmente en Render; descárgalo desde el panel lo antes posible.';
    res.type('html').send(buildOnboardingPage({ title:'Cartera recibida', subtitle:'Ya registramos tu archivo para la carga inicial.', bodyHtml:`<div class="success">✅</div><div class="note"><b>Listo.</b> ${escHtml(storageMsg)} Continuaremos con la carga inicial sin costo adicional.</div>` }));
  } catch (err) {
    console.error('Error carga ZIP CarteraPro:',err);
    if(tempPath) try{fs.unlinkSync(tempPath)}catch{}
    res.status(err?.type==='entity.too.large'?413:500).type('html').send(buildOnboardingPage({ title:'No pudimos guardar el ZIP', subtitle:'Intenta nuevamente o solicita otro enlace.', bodyHtml:'', error:err?.type==='entity.too.large'?`El ZIP excede ${CARTERAPRO_UPLOAD_MAX_MB} MB.`:(err?.message||String(err)) }));
  }
});


const registrationAlertHits = new Map();
function registrationAlertCors(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed = String(process.env.CARTERAPRO_ALLOWED_ORIGINS || 'https://carteraproautos.netlify.app')
    .split(',').map(v=>v.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
}
function allowRegistrationAlert(req) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const oneHour = 60*60*1000;
  const current = (registrationAlertHits.get(key) || []).filter(t=>now-t<oneHour);
  if (current.length >= 20) return false;
  current.push(now);
  registrationAlertHits.set(key,current);
  return true;
}
app.options('/carterapro/api/registration-alert', (req,res)=>{
  registrationAlertCors(req,res);
  res.status(204).end();
});
app.post('/carterapro/api/registration-alert', async (req,res)=>{
  registrationAlertCors(req,res);
  const origin=String(req.headers.origin||'');
  const allowed=String(process.env.CARTERAPRO_ALLOWED_ORIGINS || 'https://carteraproautos.netlify.app')
    .split(',').map(v=>v.trim()).filter(Boolean);
  if (origin && !allowed.includes(origin)) return res.status(403).json({ok:false,error:'Origen no permitido'});
  if (!allowRegistrationAlert(req)) return res.status(429).json({ok:false,error:'Demasiadas solicitudes'});

  const b=req.body||{};
  const uid=String(b.uid||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
  const phone=normalizePhone(b.phone||'');
  const name=String(b.name||'').trim().slice(0,120);
  const email=String(b.email||'').trim().slice(0,160);
  const plan=String(b.plan||'').trim().toLowerCase()==='plus'?'plus':'basic';
  const username=String(b.username||'').trim().slice(0,80);
  const primaryCompany=String(b.primaryCompany||'').trim().slice(0,100);
  const companies=Array.isArray(b.companies)?b.companies.map(x=>String(x).slice(0,80)).slice(0,20):[];

  if (!phone || phone.length<10 || !name) return res.status(400).json({ok:false,error:'Datos incompletos'});

  const id=`registration_${uid || phone}`;
  await recordCarteraProLead({
    id,
    phone,
    name,
    company:primaryCompany,
    plan,
    type:'registration',
    status:'pending_activation',
    note:`Usuario ${username || '-'} · ${email || '-'} · Compañías: ${companies.join(', ') || '-'}`,
    createdAt:new Date().toISOString(),
    createdAtMs:Date.now()
  }).catch(()=>{});

  await notifyCarteraProAdmin([
    '✅ *Nuevo registro CarteraPro*',
    `Nombre: ${name}`,
    `WhatsApp: ${phone}`,
    `Usuario: ${username || '-'}`,
    `Plan: ${plan === 'plus' ? 'Plus · $698' : 'Básico · $499'}`,
    `Compañía principal: ${primaryCompany || '-'}`,
    companies.length ? `Compañías: ${companies.join(', ')}` : '',
    email ? `Correo: ${email}` : '',
    '',
    'Estado: pendiente de activación.',
    '⚠️ Este aviso confirma el registro; el pago debe verificarse por separado mientras se utilicen Links de pago de Mercado Pago.'
  ].filter(Boolean).join('\n'));

  res.json({ok:true});
});

app.get('/carterapro/admin', requireAdmin, async (req, res) => {
  const [leads,onboarding] = await Promise.all([loadCarteraProLeads({limit:300}),loadCarteraProOnboarding({limit:300})]);
  const rows = onboarding.map(x => `<tr><td>${escHtml(x.createdAt||'')}</td><td>${escHtml(x.phone||'')}</td><td>${escHtml(x.name||'')}</td><td>${escHtml(x.plan||'')}</td><td>${escHtml(x.method||'')}</td><td>${escHtml(x.status||'')}</td><td>${x.credentialsEncrypted?`<a href="/carterapro/admin/onboarding/${encodeURIComponent(x.token)}?token=${encodeURIComponent(adminTokenFromReq(req))}">Ver acceso</a>`:''}${x.upload?`${x.credentialsEncrypted?' · ':''}<a href="/carterapro/admin/file/${encodeURIComponent(x.token)}?token=${encodeURIComponent(adminTokenFromReq(req))}">Descargar ZIP</a>`:''}</td></tr>`).join('');
  const leadRows=leads.slice(0,100).map(x=>`<tr><td>${escHtml(x.createdAt||'')}</td><td>${escHtml(x.type||'')}</td><td>${escHtml(x.phone||'')}</td><td>${escHtml(x.name||'')}</td><td>${escHtml(x.company||'')}</td><td>${escHtml(x.plan||'')}</td><td>${escHtml(x.status||'')}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CarteraPro Ventas</title><style>body{font-family:system-ui;background:#f5f7fb;color:#111827;padding:20px}.w{max-width:1200px;margin:auto}.card{background:#fff;border:1px solid #e3e7ef;border-radius:16px;padding:16px;margin-bottom:14px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}th{background:#fafafa}a{color:#3152f3}.pill{padding:5px 8px;border-radius:999px;background:#eafaf4;color:#087657}</style></head><body><div class="w"><div class="card"><h1>CarteraPro Ventas</h1><p>Prospectos, compras reportadas y carga inicial. <span class="pill">Mismo Render del emisor</span></p><p><a style="display:inline-block;background:#3152f3;color:#fff;text-decoration:none;padding:9px 12px;border-radius:10px;font-weight:800" href="/carterapro-inbox.html?token=${encodeURIComponent(adminTokenFromReq(req))}">💬 Abrir Inbox de ventas</a></p><p>Firebase Storage: <b>${escHtml(getFirebaseStorageBucketName()||'No configurado')}</b></p></div><div class="card"><h2>Onboarding</h2><div style="overflow:auto"><table><thead><tr><th>Fecha</th><th>WhatsApp</th><th>Nombre</th><th>Plan</th><th>Método</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows||'<tr><td colspan="7">Sin onboarding todavía.</td></tr>'}</tbody></table></div></div><div class="card"><h2>Prospectos</h2><div style="overflow:auto"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>WhatsApp</th><th>Nombre</th><th>Compañía</th><th>Plan</th><th>Estado</th></tr></thead><tbody>${leadRows||'<tr><td colspan="7">Sin prospectos todavía.</td></tr>'}</tbody></table></div></div></div></body></html>`);
});

app.get('/carterapro/admin/onboarding/:onboardingToken', requireAdmin, async (req,res) => {
  const item=await getCarteraProOnboarding(req.params.onboardingToken);
  if(!item) return res.sendStatus(404);
  let creds=null,error='';
  if(item.credentialsEncrypted){ try{creds=decryptCredentials(item.credentialsEncrypted)}catch(err){error=err?.message||String(err)} }
  res.type('html').send(buildOnboardingPage({title:'Datos de carga inicial',subtitle:`${item.name||item.phone||''} · ${item.company||''}`,error,bodyHtml:creds?`<div class="warn"><b>Información sensible.</b> Úsala únicamente para la carga autorizada y evita copiarla a chats.</div><label>Portal</label><input readonly value="${escHtml(creds.portalUrl||'')}"><label>Usuario</label><input readonly value="${escHtml(creds.portalUser||'')}"><label>Contraseña temporal</label><input readonly value="${escHtml(creds.portalPassword||'')}"><p class="small">Al terminar, pide al cliente cambiar su contraseña temporal.</p>`:'<div class="note">No hay credenciales registradas en esta solicitud.</div>'}));
});

app.get('/carterapro/admin/file/:onboardingToken', requireAdmin, async (req,res) => {
  const item=await getCarteraProOnboarding(req.params.onboardingToken);
  const upload=item?.upload;
  if(!upload) return res.sendStatus(404);
  res.setHeader('Content-Disposition',`attachment; filename="${String(upload.filename||'cartera.zip').replace(/"/g,'')}"`);
  res.setHeader('Content-Type',upload.contentType||'application/zip');
  if(upload.storedIn==='firebase_storage' && upload.storagePath && getFirebaseStorageBucketName()){
    try{
      const bucket=admin.storage().bucket(getFirebaseStorageBucketName());
      return bucket.file(upload.storagePath).createReadStream().on('error',()=>res.sendStatus(404)).pipe(res);
    }catch(err){console.error(err);return res.sendStatus(500)}
  }
  const local=String(upload.localPath||'');
  const safeRoot=path.resolve(CARTERAPRO_UPLOAD_DIR)+path.sep;
  const resolved=path.resolve(local);
  if(!local || !resolved.startsWith(safeRoot) || !fs.existsSync(resolved)) return res.status(404).send('Archivo local ya no disponible. Configura FIREBASE_STORAGE_BUCKET para persistencia.');
  res.sendFile(resolved);
});

app.get('/media/:token/:filename', (req, res) => {
  const expected = process.env.MEDIA_ROUTE_TOKEN || 'cambia_este_token_largo';
  if (req.params.token !== expected) return res.sendStatus(403);
  const safeName = path.basename(req.params.filename);
  const file = path.join(GENERATED_DIR, safeName);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.sendFile(file);
});


function clickToWhatsAppReferral(body={}) {
  const r={
    ctwaClid:String(body.ReferralCtwaClid||''),
    sourceId:String(body.ReferralSourceId||''),
    sourceType:String(body.ReferralSourceType||''),
    sourceUrl:String(body.ReferralSourceUrl||''),
    headline:String(body.ReferralHeadline||''),
    body:String(body.ReferralBody||''),
    mediaContentType:String(body.ReferralMediaContentType||'')
  };
  return Object.values(r).some(Boolean) ? r : null;
}

app.post(['/twilio/webhook', '/webhook'], async (req, res) => {
  const incomingFrom = req.body.From || '';
  const incomingTo = req.body.To || '';
  const incomingBody = req.body.Body || '';
  const sender = normalizePhone(incomingFrom);
  const adContext = clickToWhatsAppReferral(req.body || {});

  try {
    await recordMessage({
      phone: sender,
      direction: 'inbound',
      source: 'whatsapp',
      body: incomingBody,
      from: incomingFrom,
      to: incomingTo,
      sid: req.body.MessageSid || req.body.SmsMessageSid || '',
      status: req.body.SmsStatus || '',
      referral: adContext
    }).catch(err => console.error('No se pudo guardar mensaje entrante:', err));

    let reply;
    let routeSource = 'carterapro_sales';

    // HELP es el único mensaje general que revela también los comandos del emisor.
    if (isGeneralHelp(incomingBody)) {
      reply = { body: combinedHelp() };
      routeSource = 'help';
    } else if (/^(HELP|AYUDA|MENU|MENÚ)\s+EMISOR$/i.test(String(incomingBody||'').trim())) {
      reply = await handleTwilioMessage({ from: incomingFrom, body: 'HELP', baseUrl: requestBaseUrl(req) });
      routeSource = 'emisor';
    } else if (await shouldUseEmitter(sender, incomingBody)) {
      // El emisor conserva su lógica, pero solo entra con comando específico o sesión activa.
      reply = await handleTwilioMessage({ from: incomingFrom, body: incomingBody, baseUrl: requestBaseUrl(req) });
      routeSource = 'emisor';
    } else {
      // Todo mensaje normal es atendido automáticamente por CarteraPro Ventas.
      reply = await handleCarteraProMessage({ from: incomingFrom, body: incomingBody, baseUrl: requestBaseUrl(req), notifyAdmin: notifyCarteraProAdmin, adContext });
      routeSource = 'carterapro_sales';
    }

    await recordMessage({
      phone: sender,
      direction: 'outbound',
      source: routeSource,
      body: reply?.body || '',
      from: incomingTo,
      to: incomingFrom,
      mediaUrl: Array.isArray(reply?.mediaUrls) && reply.mediaUrls.length ? reply.mediaUrls.join('\n') : (reply?.mediaUrl || ''),
      status: 'twiml'
    }).catch(err => console.error('No se pudo guardar respuesta del bot:', err));

    if (reply?.adminNotification) {
      sendAdminNotification(reply.adminNotification).catch(err => console.error('Error enviando aviso admin:', err));
    }

    res.type('text/xml').send(twimlMessage(reply || { body:'' }));
  } catch (err) {
    console.error('Error en webhook Twilio:', err);
    const fallback = 'Tuvimos un problema temporal. Escribe CARTERAPRO para volver a empezar o HELP para ver opciones.';
    await recordMessage({ phone:sender,direction:'outbound',source:'bot_error',body:fallback,from:incomingTo,to:incomingFrom,status:'error' }).catch(()=>{});
    res.type('text/xml').send(twimlMessage({ body:fallback }));
  }
});

app.listen(PORT, () => {
  console.log(`Twilio Emisor Administrativo escuchando en http://localhost:${PORT}`);
  console.log(`Webhook Twilio: /twilio/webhook`);
});
