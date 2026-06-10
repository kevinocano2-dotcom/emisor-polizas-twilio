import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import { getLastFolioNumber, nextFolioNumber, setLastFolioNumber } from './state.js';
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

app.get('/health', (req, res) => {
  res.json({ ok: true, provider: 'twilio', lastFolio: getLastFolioNumber() });
});

app.get('/api/settings', (req, res) => {
  res.json({ folioPrefix: FOLIO_PREFIX, lastFolioNumber: getLastFolioNumber() });
});

app.post('/api/settings', (req, res) => {
  const n = Number(req.body.lastFolioNumber);
  if (!n || n < 1) return res.status(400).json({ error: 'lastFolioNumber inválido' });
  setLastFolioNumber(n);
  res.json({ ok: true, lastFolioNumber: getLastFolioNumber() });
});

app.post('/api/emitir', (req, res) => {
  const data = req.body || {};
  if (!data.name || !data.auto || !data.vin) {
    return res.status(400).json({ error: 'Faltan name, auto o vin' });
  }
  const n = nextFolioNumber();
  const policy = normalizePolicyInput(data, n, FOLIO_PREFIX, new Date());
  const pdf = buildPdfBuffer(policy);
  const filename = `${cleanFileName(policy.folio)}_${cleanFileName(policy.name)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdf);
});

// Ruta protegida por token simple para que Twilio pueda descargar el PDF.
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

// Twilio enviará mensajes entrantes como application/x-www-form-urlencoded.
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
