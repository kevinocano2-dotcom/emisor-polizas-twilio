import fs from 'node:fs';
import path from 'node:path';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import { clearSession, getSession, isUserAllowed, nextFolioNumber, normalizePhone, recordPolicy, setSession } from './state.js';

const KEYWORDS = ['EMITIR'];
const KEYWORD_LABEL = KEYWORDS.join(' o ');
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');

const steps = [
  { key: 'name', prompt: 'Nombre completo del asegurado:' },
  { key: 'address', prompt: 'Domicilio del asegurado: ej. Musaro 63' },
  { key: 'auto', prompt: 'Automóvil / descripción del vehículo. Ejemplo: VOLKSWAGEN GOLF GLS:' },
  { key: 'body', prompt: 'Carrocería. Ejemplo: HATCHBACK 4D, PICK UP, SEDAN:' },
  { key: 'modelYear', prompt: 'Modelo / año del vehículo:' },
  { key: 'vin', prompt: 'No. de serie / VIN:' }
];

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function isKeyword(value) {
  return KEYWORDS.includes(upper(value));
}

function normalizeAnswer(stepKey, raw) {
  const text = upper(raw);
  if (!text) return null;
  if (stepKey === 'modelYear') return text.replace(/\s+/g, ' ');
  if (stepKey === 'vin') return text.replace(/\s+/g, '');
  return text;
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

function summary(data) {
  return `Revisa la información:\n\n` +
    `Nombre: ${data.name}\n` +
    `Domicilio: ${data.address}\n` +
    `Auto: ${data.auto}\n` +
    `Carrocería: ${data.body}\n` +
    `Modelo: ${data.modelYear}\n` +
    `Serie/VIN: ${data.vin}\n\n` +
    `Responde CONFIRMAR para emitir o CANCELAR para reiniciar.`;
}

async function generatePdfFile(data, baseUrl, sender) {
  ensureGeneratedDir();

  const folioNumber = await nextFolioNumber();
  const policy = normalizePolicyInput({ ...data, plates: '' }, folioNumber, FOLIO_PREFIX, new Date());

  const pdf = buildPdfBuffer(policy);
  const filename = `${cleanFileName(policy.folio)}_${cleanFileName(policy.name)}.pdf`;
  const filepath = path.join(GENERATED_DIR, filename);

  fs.writeFileSync(filepath, pdf);

  await recordPolicy({
    phone: sender,
    folio: policy.folio,
    insuredName: policy.name,
    auto: policy.auto,
    vin: policy.vin,
    filename
  });

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
  const upperText = upper(text);

  // CANCELAR debe funcionar siempre, aunque el formulario esté trabado.
  if (/^CANCELAR$/i.test(text)) {
    await clearSession(sender);
    return { body: `Proceso cancelado y formulario reiniciado. Para iniciar de nuevo manda ${KEYWORD_LABEL}.` };
  }

  if (!text) {
    return { body: `Para iniciar emisión manda ${KEYWORD_LABEL}.` };
  }

  if (!(await isUserAllowed(sender))) {
    return { body: 'Este número no está autorizado o se encuentra bloqueado. Comunícate con administración.' };
  }

  if (/^(AYUDA|HELP|MENU|MENÚ)$/i.test(upperText)) {
    return { body: `Para emitir una póliza administrativa manda: ${KEYWORD_LABEL}\n\nDurante la captura puedes responder CANCELAR para reiniciar.` };
  }

  let session = await getSession(sender);

  // Si manda la palabra clave en cualquier momento, reinicia el formulario desde cero.
  if (isKeyword(upperText)) {
    session = { stepIndex: 0, data: {} };
    await setSession(sender, session);
    return { body: `Iniciamos emisión administrativa.\n\n${steps[0].prompt}` };
  }

  if (!session) {
    return { body: `Para iniciar emisión manda la palabra clave: ${KEYWORD_LABEL}` };
  }

  if (session.awaitingConfirm) {
    if (/^CONFIRMAR$/i.test(text)) {
      try {
        const data = session.data;

        // Se limpia antes para que no quede atorado aunque falle algo.
        await clearSession(sender);

        const result = await generatePdfFile(data, baseUrl, sender);

        return {
          body: `Listo. Folio emitido: ${result.policy.folio}`,
          mediaUrl: result.mediaUrl,
          filename: result.filename
        };
      } catch (err) {
        console.error('Error generando póliza:', err);

        // Asegura que el formulario quede reiniciado.
        await clearSession(sender);

        return {
          body: `Ocurrió un error generando la póliza. El formulario se reinició. Para intentar de nuevo manda ${KEYWORD_LABEL}.`
        };
      }
    }

    return { body: 'Responde CONFIRMAR para emitir o CANCELAR para reiniciar.' };
  }

  const step = steps[session.stepIndex];

  if (!step) {
    await clearSession(sender);
    return { body: `El formulario estaba incompleto o dañado. Se reinició. Para iniciar de nuevo manda ${KEYWORD_LABEL}.` };
  }

  const value = normalizeAnswer(step.key, text);

  if (value === null) {
    return { body: `Dato inválido. ${step.prompt}` };
  }

  session.data[step.key] = value;
  session.stepIndex += 1;

  if (session.stepIndex >= steps.length) {
    session.awaitingConfirm = true;
    await setSession(sender, session);
    return { body: summary(session.data) };
  }

  await setSession(sender, session);
  return { body: steps[session.stepIndex].prompt };
}
