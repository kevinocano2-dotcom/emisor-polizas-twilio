import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import { deleteUser, getAdminSummary, getLastFolioNumber, liquidatePolicies, markPoliciesPaid, nextFolioNumber, normalizePhone, setLastFolioNumber, setUserActive, storageMode, upsertUser } from './state.js';
import { handleTwilioMessage } from './flow_twilio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 8080);
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');

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

function twimlMessage({ body, mediaUrl }) {
  const media = mediaUrl ? `<Media>${xmlEscape(mediaUrl)}</Media>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>${xmlEscape(body)}</Body>${media}</Message></Response>`;
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function adminTokenExpected() {
  return process.env.ADMIN_TOKEN || process.env.MEDIA_ROUTE_TOKEN || '';
}

function adminTokenFromReq(req) {
  return req.headers['x-admin-token'] || req.query.token || req.body?.token || '';
}

function requireAdmin(req, res, next) {
  const expected = adminTokenExpected();
  if (!expected) return next();
  if (String(adminTokenFromReq(req)) === String(expected)) return next();
  return res.status(401).json({ error: 'Token de administrador inválido' });
}

app.get('/health', async (req, res) => {
  res.json({ ok: true, provider: 'twilio', storageMode: storageMode(), lastFolio: await getLastFolioNumber() });
});

app.get('/api/settings', async (req, res) => {
  res.json({ folioPrefix: FOLIO_PREFIX, lastFolioNumber: await getLastFolioNumber(), storageMode: storageMode() });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const n = Number(req.body.lastFolioNumber);
  if (!n || n < 1) return res.status(400).json({ error: 'lastFolioNumber inválido' });
  await setLastFolioNumber(n);
  res.json({ ok: true, lastFolioNumber: await getLastFolioNumber() });
});

app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  res.json(await getAdminSummary());
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
  try {
    const reply = await handleTwilioMessage({
      from: req.body.From,
      body: req.body.Body,
      baseUrl: requestBaseUrl(req)
    });
    res.type('text/xml').send(twimlMessage(reply));
  } catch (err) {
    console.error('Error en webhook Twilio:', err);
    res.type('text/xml').send(twimlMessage({ body: 'Ocurrió un error generando la póliza. Intenta de nuevo o manda CANCELAR.' }));
  }
});

app.listen(PORT, () => {
  console.log(`Twilio Emisor Administrativo escuchando en http://localhost:${PORT}`);
  console.log(`Webhook Twilio: /twilio/webhook`);
});
