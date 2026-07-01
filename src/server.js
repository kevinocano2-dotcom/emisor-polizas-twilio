import twilio from 'twilio';
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import { buildAffiliationPdfBuffer, normalizeAffiliationInput } from './affiliation_generator.js';
import { deleteUser, getAdminSummary, getConversationSummary, getLastFolioNumber, liquidatePolicies, loadMessages, markPoliciesPaid, nextFolioNumber, normalizePhone, recordAffiliation, recordMessage, setLastFolioNumber, setPolicyStatus, setUserActive, storageMode, upsertUser, firestoreStatus } from './state.js';
import { handleTwilioMessage } from './flow_twilio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 8080);
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');

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

app.post(['/twilio/webhook', '/webhook'], async (req, res) => {
  const incomingFrom = req.body.From || '';
  const incomingTo = req.body.To || '';
  const incomingBody = req.body.Body || '';
  const sender = normalizePhone(incomingFrom);

  try {
    await recordMessage({
      phone: sender,
      direction: 'inbound',
      source: 'whatsapp',
      body: incomingBody,
      from: incomingFrom,
      to: incomingTo,
      sid: req.body.MessageSid || req.body.SmsMessageSid || '',
      status: req.body.SmsStatus || ''
    }).catch(err => console.error('No se pudo guardar mensaje entrante:', err));

    const reply = await handleTwilioMessage({
      from: incomingFrom,
      body: incomingBody,
      baseUrl: requestBaseUrl(req)
    });

    await recordMessage({
      phone: sender,
      direction: 'outbound',
      source: 'bot',
      body: reply.body || '',
      from: incomingTo,
      to: incomingFrom,
      mediaUrl: Array.isArray(reply.mediaUrls) && reply.mediaUrls.length ? reply.mediaUrls.join('\n') : (reply.mediaUrl || ''),
      status: 'twiml'
    }).catch(err => console.error('No se pudo guardar respuesta del bot:', err));

    if (reply.adminNotification) {
      sendAdminNotification(reply.adminNotification)
        .catch(err => console.error('Error enviando aviso admin:', err));
    }

    res.type('text/xml').send(twimlMessage(reply));
  } catch (err) {
    console.error('Error en webhook Twilio:', err);

    const fallback = 'Ocurrió un error generando la póliza. Intenta de nuevo o manda CANCELAR.';

    sendAdminNotification({
      kind: 'emit_error_backup',
      phone: sender,
      error: err?.details || err?.message || String(err),
      capturedData: { mensaje: incomingBody },
      recoveryPolicy: {}
    }).catch(notifyErr => console.error('No se pudo enviar respaldo de error admin:', notifyErr));

    await recordMessage({
      phone: sender,
      direction: 'outbound',
      source: 'bot_error',
      body: fallback,
      from: incomingTo,
      to: incomingFrom,
      status: 'error'
    }).catch(() => {});

    res.type('text/xml').send(twimlMessage({ body: fallback }));
  }
});

app.listen(PORT, () => {
  console.log(`Twilio Emisor Administrativo escuchando en http://localhost:${PORT}`);
  console.log(`Webhook Twilio: /twilio/webhook`);
});
