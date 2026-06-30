import fs from 'node:fs';
import path from 'node:path';
import { buildAffiliationPdfBuffer, normalizeAffiliationInput } from './affiliation_generator.js';
import { buildPdfBuffer, cleanFileName, normalizePolicyInput } from './pdf_generator.js';
import {
  clearSession,
  getPolicyStatsForPhone,
  getSession,
  isUserAllowed,
  nextFolioNumber,
  normalizePhone,
  recordAffiliation,
  recordPolicy,
  setSession
} from './state.js';

const COMMANDS = {
  'EMITIR AGS': 'policy',
  '/EMITIRYAFILIACION': 'policy_affiliation',
  '/AFILIACION': 'affiliation'
};

const HELP_HINT_TEXT = 'Escribe HELP para ver las opciones disponibles.';
const INVALID_COMMAND_TEXT = `Comando incorrecto. ${HELP_HINT_TEXT}`;
const FOLIO_PREFIX = process.env.FOLIO_PREFIX || 'SANTM 2-';
const GENERATED_DIR = path.join(process.cwd(), 'generated');
const HELLO_TEXT = 'Hola, soy su asistente virtual, ¿en qué le puedo apoyar?';

const policySteps = [
  { key: 'name', prompt: 'Nombre completo del asegurado:' },
  { key: 'address', prompt: 'Domicilio del asegurado: ej. Musaro 63' },
  { key: 'auto', prompt: 'Automóvil / descripción del vehículo. Ejemplo: VOLKSWAGEN GOLF GLS:' },
  { key: 'body', prompt: 'Carrocería. Ejemplo: HATCHBACK 4D, PICK UP, SEDAN:' },
  { key: 'modelYear', prompt: 'Modelo / año del vehículo:' },
  { key: 'vin', prompt: 'No. de serie / VIN:' }
];

const combinedExtraSteps = [
  { key: 'plates', prompt: 'Número de placa / EXP para la hoja de afiliación:' },
  { key: 'customerPhone', prompt: 'Número del cliente / teléfono. Este dato se guarda en base de datos, no se imprime en el PDF:' },
  { key: 'affiliateNames', prompt: 'Nombre(s) para la hoja de afiliación separados por comas, máximo 3. Ejemplo: JUAN PEREZ, MARIA LOPEZ, PEDRO GOMEZ. Si solo es el asegurado de la póliza, escribe MISMO:' },
  { key: 'color', prompt: 'Color del vehículo para la hoja de afiliación:' }
];

const affiliationOnlySteps = [
  { key: 'plates', prompt: 'Número de placa / EXP:' },
  { key: 'customerPhone', prompt: 'Número del cliente / teléfono. Este dato se guarda en base de datos, no se imprime en el PDF:' },
  { key: 'affiliateNames', prompt: 'Nombre(s) de cliente separados por comas, máximo 3. El primero va en el campo superior y hasta dos adicionales van abajo. Ejemplo: JUAN PEREZ, MARIA LOPEZ, PEDRO GOMEZ:' },
  { key: 'auto', prompt: 'Marca / vehículo. Ejemplo: NISSAN SENTRA:' },
  { key: 'body', prompt: 'Tipo. Ejemplo: SEDAN, PICKUP, CAMIONETA:' },
  { key: 'modelYear', prompt: 'Modelo / año. Ejemplo: 2015:' },
  { key: 'vin', prompt: 'Serie / VIN del carro:' },
  { key: 'color', prompt: 'Color del vehículo:' }
];

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeCommand(value) {
  const text = String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (text.startsWith('/')) {
    return `/${text.slice(1).replace(/[^A-Z0-9]/g, '')}`;
  }

  return text.replace(/[^A-Z0-9]+/g, ' ').trim();
}

function commandFor(value) {
  return COMMANDS[normalizeCommand(value)] || '';
}

function isGreeting(value) {
  const cmd = normalizeCommand(value);
  return !cmd || /^(HOLA|BUENAS|BUENOSDIAS|BUENASTARDES|BUENASNOCHES|INFO|INICIO)$/i.test(cmd);
}

function isLikelyCommandAttempt(value) {
  const cmd = normalizeCommand(value);
  if (!cmd) return false;
  if (String(value || '').trim().startsWith('/')) return true;
  return /^(EMITIR|EMITIR AGS|EMITIR ADMINISTRATIVO|EMITIRYAFILIACION|EMITIRAFILIACION|POLIZAYAFILIACION|AFILIACION|MYR|POLIZA|SEGURO)$/.test(cmd);
}

function stepsForMode(mode) {
  if (mode === 'policy') return policySteps;
  if (mode === 'policy_affiliation') return [...policySteps, ...combinedExtraSteps];
  if (mode === 'affiliation') return affiliationOnlySteps;
  return [];
}

function modeTitle(mode) {
  if (mode === 'policy') return 'emisión administrativa';
  if (mode === 'policy_affiliation') return 'emisión administrativa + hoja de afiliación';
  if (mode === 'affiliation') return 'hoja de afiliación';
  return 'proceso';
}

function normalizeNamesAnswer(raw, session) {
  const text = upper(raw);
  if (!text) return null;

  if (session?.mode === 'policy_affiliation' && /^MISMO$/.test(text)) {
    return [upper(session.data?.name)].filter(Boolean);
  }

  const names = text
    .split(',')
    .map(v => upper(v).replace(/\s+/g, ' '))
    .filter(Boolean);

  if (!names.length || names.length > 3) return null;
  return names;
}

function normalizeAnswer(stepKey, raw, session) {
  const text = upper(raw);
  if (!text) return null;

  if (stepKey === 'modelYear') return text.replace(/\s+/g, ' ');
  if (stepKey === 'vin') return text.replace(/[^A-Z0-9]/g, '');
  if (stepKey === 'plates') return text.replace(/[^A-Z0-9-]/g, '');
  if (stepKey === 'customerPhone') {
    const phone = String(raw || '').replace(/\D/g, '');
    return phone.length >= 7 ? phone : null;
  }
  if (stepKey === 'affiliateNames') return normalizeNamesAnswer(raw, session);

  return text.replace(/\s+/g, ' ');
}

function publicBaseUrlFrom(baseUrl) {
  return String(process.env.PUBLIC_BASE_URL || baseUrl || '').replace(/\/$/, '');
}

function mediaUrlFor(baseUrl, filename) {
  const token = process.env.MEDIA_ROUTE_TOKEN || 'cambia_este_token_largo';
  return `${publicBaseUrlFrom(baseUrl)}/media/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
}

function errorSummary(err) {
  const msg = String(err?.details || err?.message || err || 'Error desconocido');
  if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg) || err?.code === 8) {
    return 'Firestore/Firebase sin cuota: Quota exceeded';
  }
  return msg.slice(0, 240);
}

function localBackupWarning(record, label) {
  if (!record || record.storedIn !== 'local_backup') return '';
  return `${label} generado, pero NO se guardó en Firebase. Quedó en respaldo local temporal. Error: ${record.firebaseSaveError || 'Firebase no disponible'}`;
}

function policyRecoveryFromResult(result = {}, sender = '') {
  const policy = result.policy || {};
  return {
    phone: sender,
    folio: policy.folio,
    insuredName: policy.name,
    address: policy.address,
    auto: policy.auto,
    body: policy.body,
    modelYear: policy.modelYear,
    vin: policy.vin,
    filename: result.filename,
    mediaUrl: result.mediaUrl,
    date: policy.date,
    nextDate: policy.nextDate,
    total: policy.total,
    qrPayload: policy.qrPayload
  };
}

function affiliationRecoveryFromResult(result = {}, sender = '', policyFolio = '') {
  const affiliation = result.affiliation || {};
  return {
    phone: sender,
    ...affiliation,
    filename: result.filename,
    mediaUrl: result.mediaUrl,
    policyFolio: policyFolio || affiliation.policyFolio || ''
  };
}

async function safePolicyStats(sender) {
  try {
    return await getPolicyStatsForPhone(sender);
  } catch (err) {
    console.error('No se pudo calcular pendientes, se continúa con PDF:', err?.message || err);
    return {
      phone: sender,
      totalIssued: 0,
      pendingCount: 0,
      paidCount: 0,
      pendingFolios: [],
      allFolios: []
    };
  }
}

function ensureGeneratedDir() {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function affiliationDataFrom(data) {
  return {
    plates: data.plates,
    exp: data.plates,
    customerPhone: data.customerPhone,
    names: Array.isArray(data.affiliateNames) && data.affiliateNames.length
      ? data.affiliateNames
      : [data.name].filter(Boolean),
    auto: data.auto,
    body: data.body,
    modelYear: data.modelYear,
    vin: data.vin,
    color: data.color
  };
}

function policySummary(data) {
  return `Revisa la información de la póliza:\n\n` +
    `Nombre: ${data.name}\n` +
    `Domicilio: ${data.address}\n` +
    `Auto: ${data.auto}\n` +
    `Carrocería: ${data.body}\n` +
    `Modelo: ${data.modelYear}\n` +
    `Serie/VIN: ${data.vin}`;
}

function affiliationSummary(data) {
  const aff = normalizeAffiliationInput(affiliationDataFrom(data));
  return `Revisa la hoja de afiliación:\n\n` +
    `Estado: ${aff.estado}\n` +
    `Municipio: ${aff.municipio}\n` +
    `EXP / Placa: ${aff.exp}\n` +
    `Fecha: ${aff.date}\n` +
    `Teléfono cliente guardado: ${aff.customerPhone || '-'}\n` +
    `Nombre campo superior: ${aff.nombre1 || '-'}\n` +
    `Nombre campo inferior: ${aff.nombre2 || '-'}\n` +
    `Marca / vehículo: ${aff.auto}\n` +
    `Tipo: ${aff.body}\n` +
    `Modelo: ${aff.modelYear}\n` +
    `Serie: ${aff.vin}\n` +
    `Color: ${aff.color}`;
}

function summaryForSession(session) {
  if (session.mode === 'policy') {
    return `${policySummary(session.data)}\n\nResponde CONFIRMAR para emitir o CANCELAR para reiniciar.`;
  }

  if (session.mode === 'affiliation') {
    return `${affiliationSummary(session.data)}\n\nResponde CONFIRMAR para generar la afiliación o CANCELAR para reiniciar.`;
  }

  return `${policySummary(session.data)}\n\n${affiliationSummary(session.data)}\n\nResponde CONFIRMAR para emitir ambos PDFs o CANCELAR para reiniciar.`;
}

async function generatePolicyPdfFile(data, baseUrl, sender) {
  ensureGeneratedDir();

  const folioNumber = await nextFolioNumber();
  const policy = normalizePolicyInput({ ...data, plates: '' }, folioNumber, FOLIO_PREFIX, new Date());

  const pdf = buildPdfBuffer(policy);
  const filename = `${cleanFileName(policy.folio)}_${cleanFileName(policy.name)}.pdf`;
  const filepath = path.join(GENERATED_DIR, filename);
  const mediaUrl = mediaUrlFor(baseUrl, filename);

  fs.writeFileSync(filepath, pdf);

  let savedRecord = null;
  try {
    savedRecord = await recordPolicy({
      phone: sender,
      filename,
      policy,
      inputData: data
    });
  } catch (err) {
    err.recoveryPolicy = {
      phone: sender,
      folio: policy.folio,
      insuredName: policy.name,
      address: policy.address,
      auto: policy.auto,
      body: policy.body,
      modelYear: policy.modelYear,
      vin: policy.vin,
      filename,
      mediaUrl,
      date: policy.date,
      nextDate: policy.nextDate,
      total: policy.total,
      qrPayload: policy.qrPayload
    };
    throw err;
  }

  return {
    policy,
    filename,
    filepath,
    mediaUrl,
    savedRecord,
    storageWarning: localBackupWarning(savedRecord, 'Póliza')
  };
}

async function generateAffiliationPdfFile(data, baseUrl, sender, extra = {}) {
  ensureGeneratedDir();

  const affiliation = normalizeAffiliationInput(affiliationDataFrom(data), new Date());
  const pdf = await buildAffiliationPdfBuffer(affiliation);
  const filename = `AFILIACION_${cleanFileName(affiliation.exp || 'SIN_EXP')}_${cleanFileName(affiliation.nombre1 || 'CLIENTE')}.pdf`;
  const filepath = path.join(GENERATED_DIR, filename);
  const mediaUrl = mediaUrlFor(baseUrl, filename);

  fs.writeFileSync(filepath, pdf);

  let savedRecord = null;
  try {
    savedRecord = await recordAffiliation({
      phone: sender,
      type: extra.type || 'afiliacion',
      policyFolio: extra.policyFolio || '',
      filename,
      mediaUrl,
      affiliation,
      inputData: data
    });
  } catch (err) {
    err.recoveryAffiliation = {
      phone: sender,
      ...affiliation,
      filename,
      mediaUrl,
      policyFolio: extra.policyFolio || ''
    };
    throw err;
  }

  return {
    affiliation,
    filename,
    filepath,
    mediaUrl,
    savedRecord,
    storageWarning: localBackupWarning(savedRecord, 'Afiliación')
  };
}

export async function handleTwilioMessage({ from, body, baseUrl }) {
  const sender = normalizePhone(from);
  const text = String(body || '').trim();
  const upperText = upper(text);

  // CANCELAR debe funcionar siempre, aunque el formulario esté trabado.
  if (/^CANCELAR$/i.test(text)) {
    await clearSession(sender);
    return { body: `Proceso cancelado y formulario reiniciado. ${HELP_HINT_TEXT}` };
  }

  if (!(await isUserAllowed(sender))) {
    return { body: 'Este número no está autorizado o se encuentra bloqueado. Comunícate con administración.' };
  }

  if (/^(AYUDA|HELP|MENU|MENÚ)$/i.test(upperText)) {
    return { body: `Opciones disponibles:\n- EMITIR AGS: solo póliza administrativa\n- /EMITIRYAFILIACION: póliza + hoja de afiliación MYR\n- /AFILIACION: solo hoja MYR\n\nDurante la captura puedes responder CANCELAR para reiniciar.` };
  }

  let session = await getSession(sender);
  const mode = commandFor(text);

  // Si manda una palabra clave en cualquier momento, reinicia el formulario desde cero.
  if (mode) {
    const steps = stepsForMode(mode);
    session = { mode, stepIndex: 0, data: {} };
    await setSession(sender, session);
    return { body: `Iniciamos ${modeTitle(mode)}.\n\n${steps[0].prompt}` };
  }

  if (!session) {
    if (isGreeting(text)) {
      return { body: HELLO_TEXT };
    }

    if (isLikelyCommandAttempt(text)) {
      return { body: INVALID_COMMAND_TEXT };
    }

    return { body: HELLO_TEXT };
  }

  if (isGreeting(text)) {
    return { body: `Ya hay un formulario de ${modeTitle(session.mode)} en proceso. Responde el dato solicitado, CONFIRMAR o CANCELAR.` };
  }

  if (session.awaitingConfirm) {
    if (/^CONFIRMAR$/i.test(text)) {
      const data = session.data || {};
      const confirmedMode = session.mode;

      try {
        // Se limpia antes para que no quede atorado aunque falle algo.
        await clearSession(sender);

        if (confirmedMode === 'policy') {
          const result = await generatePolicyPdfFile(data, baseUrl, sender);
          const stats = await safePolicyStats(sender);

          const pendingText = stats.pendingCount === 1
            ? '1 póliza pendiente de pagar'
            : `${stats.pendingCount} pólizas pendientes de pagar`;

          const warningText = result.storageWarning
            ? `

Aviso: Firebase no guardó la póliza. Ya envié respaldo de datos a administración por WhatsApp.`
            : '';

          return {
            body: `Listo. Folio emitido: ${result.policy.folio}
Pendientes de pagar de este usuario: ${pendingText}.${warningText}`,
            mediaUrl: result.mediaUrl,
            filename: result.filename,
            adminNotification: result.storageWarning ? {
              kind: 'emit_error_backup',
              phone: sender,
              error: result.storageWarning,
              capturedData: data,
              recoveryPolicy: policyRecoveryFromResult(result, sender)
            } : {
              phone: sender,
              folio: result.policy.folio,
              insuredName: result.policy.name,
              auto: result.policy.auto,
              vin: result.policy.vin,
              pendingCount: stats.pendingCount,
              pendingFolios: stats.pendingFolios
            }
          };
        }

        if (confirmedMode === 'affiliation') {
          const affResult = await generateAffiliationPdfFile(data, baseUrl, sender, { type: 'afiliacion' });
          const warningText = affResult.storageWarning
            ? `

Aviso: Firebase no guardó la afiliación. Ya envié respaldo de datos a administración por WhatsApp.`
            : '';

          return {
            body: `Listo. Hoja de afiliación generada.
EXP / Placa: ${affResult.affiliation.exp}${warningText}`,
            mediaUrl: affResult.mediaUrl,
            mediaUrls: [affResult.mediaUrl],
            filename: affResult.filename,
            adminNotification: affResult.storageWarning ? {
              kind: 'emit_error_backup',
              phone: sender,
              error: affResult.storageWarning,
              capturedData: data,
              recoveryAffiliation: affiliationRecoveryFromResult(affResult, sender)
            } : {
              kind: 'affiliation_generated',
              phone: sender,
              affiliation: affResult.affiliation,
              mediaUrl: affResult.mediaUrl
            }
          };
        }

        const policyResult = await generatePolicyPdfFile(data, baseUrl, sender);
        const affResult = await generateAffiliationPdfFile(data, baseUrl, sender, {
          type: 'emitir_y_afiliacion',
          policyFolio: policyResult.policy.folio
        });
        const stats = await safePolicyStats(sender);
        const pendingText = stats.pendingCount === 1
          ? '1 póliza pendiente de pagar'
          : `${stats.pendingCount} pólizas pendientes de pagar`;

        const storageWarnings = [policyResult.storageWarning, affResult.storageWarning].filter(Boolean);
        const warningText = storageWarnings.length
          ? `\n\nAviso: Firebase no guardó uno o más registros. Ya envié respaldo de datos a administración por WhatsApp.`
          : '';

        return {
          body: `Listo. Se generó la póliza y la hoja de afiliación.\nFolio póliza: ${policyResult.policy.folio}\nEXP / Placa: ${affResult.affiliation.exp}\nPendientes de pagar de este usuario: ${pendingText}.${warningText}`,
          messages: [
            {
              body: `Listo. Se generó la póliza y la hoja de afiliación.\nFolio póliza: ${policyResult.policy.folio}\nPendientes de pagar de este usuario: ${pendingText}.${warningText}\n\nPDF 1 de 2: póliza administrativa.`,
              mediaUrl: policyResult.mediaUrl
            },
            {
              body: `PDF 2 de 2: hoja de afiliación MYR.\nEXP / Placa: ${affResult.affiliation.exp}`,
              mediaUrl: affResult.mediaUrl
            }
          ],
          mediaUrl: policyResult.mediaUrl,
          mediaUrls: [policyResult.mediaUrl, affResult.mediaUrl],
          filename: `${policyResult.filename}, ${affResult.filename}`,
          adminNotification: storageWarnings.length ? {
            kind: 'emit_error_backup',
            phone: sender,
            error: storageWarnings.join(' | '),
            capturedData: data,
            recoveryPolicy: policyRecoveryFromResult(policyResult, sender),
            recoveryAffiliation: affiliationRecoveryFromResult(affResult, sender, policyResult.policy.folio)
          } : {
            kind: 'policy_affiliation_generated',
            phone: sender,
            folio: policyResult.policy.folio,
            insuredName: policyResult.policy.name,
            auto: policyResult.policy.auto,
            vin: policyResult.policy.vin,
            pendingCount: stats.pendingCount,
            pendingFolios: stats.pendingFolios,
            affiliation: affResult.affiliation,
            affiliationMediaUrl: affResult.mediaUrl
          }
        };
      } catch (err) {
        console.error('Error generando documento:', err);

        // Asegura que el formulario quede reiniciado.
        await clearSession(sender).catch(() => {});

        const recovered = err.recoveryPolicy || {};
        const recoveredAffiliation = err.recoveryAffiliation || {};
        const errorText = errorSummary(err);

        return {
          body: `No se pudo guardar/emitir correctamente por error del sistema.\nError: ${errorText}\n\nYa envié un respaldo de los datos a administración para capturarlos cuando se solucione.\n${HELP_HINT_TEXT}`,
          adminNotification: {
            kind: 'emit_error_backup',
            phone: sender,
            error: errorText,
            capturedData: data,
            recoveryPolicy: recovered,
            recoveryAffiliation: recoveredAffiliation
          }
        };
      }
    }

    return { body: 'Responde CONFIRMAR para generar o CANCELAR para reiniciar.' };
  }

  const steps = stepsForMode(session.mode);
  const step = steps[session.stepIndex];

  if (!step) {
    await clearSession(sender);
    return { body: `El formulario estaba incompleto o dañado. Se reinició. ${HELP_HINT_TEXT}` };
  }

  const value = normalizeAnswer(step.key, text, session);

  if (value === null || value === '') {
    return { body: `Dato inválido. ${step.prompt}` };
  }

  session.data[step.key] = value;
  session.stepIndex += 1;

  if (session.stepIndex >= steps.length) {
    session.awaitingConfirm = true;
    await setSession(sender, session);
    return { body: summaryForSession(session) };
  }

  await setSession(sender, session);
  return { body: steps[session.stepIndex].prompt };
}
