import fs from 'node:fs';
import path from 'node:path';
import { buildPdfBuffer, cleanFileName, FIXED, normalizePolicyInput } from './pdf_generator.js';
import { clearSession, getSession, nextFolioNumber, setSession } from './state.js';

const KEYWORD = 'EMITIR_ADMINISTRATIVO';
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');

const steps = [
  { key: 'name', prompt: 'Nombre completo del asegurado:' },
  { key: 'address', prompt: 'Domicilio del asegurado:' },
  { key: 'auto', prompt: 'Automóvil / descripción del vehículo. Ejemplo: CHEVROLET S14:' },
  { key: 'plates', prompt: 'Placas. Si no tiene, responde SIN PLACAS:' },
  { key: 'body', prompt: 'Carrocería. Ejemplo: PICK UP, SEDAN, SUV:' },
  { key: 'modelYear', prompt: 'Modelo / año del vehículo:' },
  { key: 'vin', prompt: 'No. de serie / VIN:' },
  { key: 'prima', prompt: `Prima neta. Responde OMITIR para usar ${FIXED.primaDefault.toFixed(2)}:` },
  { key: 'gastos', prompt: `Gastos de expedición. Responde OMITIR para usar ${FIXED.gastosDefault.toFixed(2)}:` }
];

function normalizePhone(value) {
  return String(value || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
}

function normalizeAnswer(stepKey, raw) {
  const text = String(raw || '').trim();
  if (stepKey === 'plates' && /^(sin placas|na|n\/a|no|omit(ir)?|omite)$/i.test(text)) return '';
  if (stepKey === 'prima' && /^(omit(ir)?|omite|default|por defecto)$/i.test(text)) return FIXED.primaDefault;
  if (stepKey === 'gastos' && /^(omit(ir)?|omite|default|por defecto)$/i.test(text)) return FIXED.gastosDefault;
  if (stepKey === 'prima' || stepKey === 'gastos') {
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    return n;
  }
  return text;
}

function isAllowed(from) {
  const raw = process.env.ALLOWED_NUMBERS || '';
  const allowed = raw.split(',').map(x => x.replace(/\D/g, '')).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(normalizePhone(from));
}

function summary(data) {
  const prima = Number(data.prima ?? FIXED.primaDefault);
  const gastos = Number(data.gastos ?? FIXED.gastosDefault);
  const subtotal = prima + gastos;
  const iva = subtotal * 0.16;
  const total = subtotal + iva;
  return `Revisa la información:\n\n` +
    `Nombre: ${data.name}\n` +
    `Domicilio: ${data.address}\n` +
    `Ciudad/Estado: ${FIXED.cityState}\n` +
    `CP: ${FIXED.cp}\n` +
    `Auto: ${data.auto}\n` +
    `Placas: ${data.plates || 'SIN PLACAS'}\n` +
    `Servicio: ${FIXED.service}\n` +
    `Carrocería: ${data.body}\n` +
    `Modelo: ${data.modelYear}\n` +
    `Serie/VIN: ${data.vin}\n` +
    `Cobertura: ${FIXED.coverage}\n` +
    `Reporte siniestros: ${FIXED.claimPhone}\n` +
    `Prima: ${prima.toFixed(2)}\n` +
    `Gastos: ${gastos.toFixed(2)}\n` +
    `Total aprox.: ${total.toFixed(2)}\n\n` +
    `Responde CONFIRMAR para emitir o CANCELAR para salir.`;
}

function publicBaseUrlFrom(baseUrl) {
  return String(process.env.PUBLIC_BASE_URL || baseUrl || '').replace(/\/$/, '');
}

function mediaUrlFor(baseUrl, filename) {
  const token = process.env.MEDIA_ROUTE_TOKEN || 'cambia_este_token_largo';
  return `${publicBaseUrlFrom(baseUrl)}/media/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
}

function ensureGeneratedDir() {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function generatePdfFile(data, baseUrl) {
  ensureGeneratedDir();
  const folioNumber = nextFolioNumber();
  const policy = normalizePolicyInput(data, folioNumber, FOLIO_PREFIX, new Date());
  const pdf = buildPdfBuffer(policy);
  const filename = `${cleanFileName(policy.folio)}_${cleanFileName(policy.name)}.pdf`;
  const filepath = path.join(GENERATED_DIR, filename);
  fs.writeFileSync(filepath, pdf);
  return {
    policy,
    filename,
    filepath,
    mediaUrl: mediaUrlFor(baseUrl, filename)
  };
}

export async function handleTwilioMessage({ from, body, baseUrl }) {
  const sender = normalizePhone(from);
  const text = String(body || '').trim();

  if (!text) {
    return { body: `Manda ${KEYWORD} para iniciar emisión.` };
  }

  if (!isAllowed(from)) {
    return { body: 'Este número no está autorizado para emitir pólizas.' };
  }

  if (/^cancelar$/i.test(text)) {
    clearSession(sender);
    return { body: `Proceso cancelado. Para iniciar de nuevo manda ${KEYWORD}.` };
  }

  if (/^(ayuda|help|menu|menú)$/i.test(text)) {
    return { body: `Para emitir una póliza administrativa manda: ${KEYWORD}\n\nDurante la captura puedes responder CANCELAR para salir.` };
  }

  let session = getSession(sender);

  if (!session) {
    if (text.toUpperCase() !== KEYWORD) {
      return { body: `Para iniciar emisión manda la palabra clave: ${KEYWORD}` };
    }
    session = { stepIndex: 0, data: {} };
    setSession(sender, session);
    return {
      body: `Iniciamos emisión administrativa.\n\nCampos fijos:\nCobertura: ${FIXED.coverage}\nServicio: ${FIXED.service}\nCP: ${FIXED.cp}\nOficina: ${FIXED.office}\nSiniestros: ${FIXED.claimPhone}\n\n${steps[0].prompt}`
    };
  }

  if (session.awaitingConfirm) {
    if (/^confirmar$/i.test(text)) {
      const data = session.data;
      clearSession(sender);
      const result = generatePdfFile(data, baseUrl);
      return {
        body: `Listo. Folio emitido: ${result.policy.folio}\nEl contador ya subió +1.`,
        mediaUrl: result.mediaUrl,
        filename: result.filename
      };
    }
    return { body: 'Responde CONFIRMAR para emitir o CANCELAR para salir.' };
  }

  const step = steps[session.stepIndex];
  const value = normalizeAnswer(step.key, text);

  if (value === null || (value === '' && step.key !== 'plates')) {
    return { body: `Dato inválido. ${step.prompt}` };
  }

  session.data[step.key] = value;
  session.stepIndex += 1;

  if (session.stepIndex >= steps.length) {
    session.awaitingConfirm = true;
    setSession(sender, session);
    return { body: summary(session.data) };
  }

  setSession(sender, session);
  return { body: steps[session.stepIndex].prompt };
}
