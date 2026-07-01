import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

const AFFILIATION_TIMEZONE = process.env.POLICY_TIMEZONE || process.env.AFFILIATION_TIMEZONE || 'America/Hermosillo';
const DEFAULT_TEMPLATE_PATH = path.join(process.cwd(), 'templates', 'MYR-799-79.pdf');

function cleanUpper(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFC')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function cleanPdfText(value) {
  const s = cleanUpper(value);
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // Las fuentes estándar de pdf-lib usan WinAnsi; dejamos solo caracteres seguros.
    out += code <= 255 ? ch : '?';
  }
  return out;
}

function cleanVin(value) {
  return cleanUpper(value).replace(/[^A-Z0-9]/g, '');
}

function cleanPlate(value) {
  return cleanUpper(value).replace(/[^A-Z0-9-]/g, '');
}

function cleanPhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function dateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AFFILIATION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

export function parseAffiliationNames(rawNames, fallbackName = '') {
  if (Array.isArray(rawNames)) {
    return rawNames.map(cleanUpper).filter(Boolean).slice(0, 3);
  }

  const text = String(rawNames ?? '').trim();
  if (!text && fallbackName) return [cleanUpper(fallbackName)].filter(Boolean);

  return text
    .split(',')
    .map(cleanUpper)
    .filter(Boolean)
    .slice(0, 3);
}

export function normalizeAffiliationInput(input = {}, now = new Date()) {
  const names = parseAffiliationNames(input.names || input.affiliateNames, input.name || input.nombre1);
  const firstName = names[0] || '';
  const otherNames = names.slice(1, 3);

  return {
    estado: 'SONORA',
    municipio: 'HERMOSILLO',
    exp: cleanPlate(input.exp || input.plates || input.placa),
    plates: cleanPlate(input.plates || input.exp || input.placa),
    date: dateString(now),
    customerPhone: cleanPhone(input.customerPhone || input.phone || input.telefono),
    names,
    nombre1: firstName,
    nombre2: otherNames.join(', '),
    auto: cleanUpper(input.auto || input.marca),
    body: cleanUpper(input.body || input.tipo || input.lista),
    modelYear: cleanUpper(input.modelYear || input.modelo),
    vin: cleanVin(input.vin || input.serie),
    color: cleanUpper(input.color)
  };
}

function drawFitText(page, text, x, y, maxWidth, options = {}) {
  const value = cleanPdfText(text);
  if (!value) return;

  const font = options.font;
  let size = Number(options.size || 10);
  const minSize = Number(options.minSize || 7);
  const color = options.color || rgb(0, 0, 0);

  while (size > minSize && font.widthOfTextAtSize(value, size) > maxWidth) {
    size -= 0.35;
  }

  page.drawText(value, { x, y, size, font, color });
}

function whiteOut(page) {
  // Elimina visualmente el botón ENVIAR y cualquier borde/resto de widgets cercanos.
  page.drawRectangle({ x: 506, y: 258, width: 82, height: 27, color: rgb(1, 1, 1), borderWidth: 0 });
}

export async function buildAffiliationPdfBuffer(affiliationInput, options = {}) {
  const templatePath = options.templatePath || process.env.MYR_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH;

  if (!fs.existsSync(templatePath)) {
    throw new Error(`No se encontró la plantilla MYR en: ${templatePath}`);
  }

  const affiliation = normalizeAffiliationInput(affiliationInput, options.now || new Date());
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  const [page] = pdfDoc.getPages();

  // Quita todos los campos/anotaciones del PDF para que no aparezca fondo azul,
  // controles editables ni el botón ENVIAR. Luego escribimos los datos como texto fijo.
  try {
    page.node.delete(PDFName.of('Annots'));
    pdfDoc.catalog.delete(PDFName.of('AcroForm'));
  } catch {
    // Si la plantilla cambia y no trae anotaciones, seguimos generando el PDF.
  }

  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  whiteOut(page);

  // Campos superiores
  drawFitText(page, affiliation.estado, 461, 745, 108, { font, size: 10 });
  drawFitText(page, affiliation.exp, 441, 730, 132, { font, size: 10 });
  drawFitText(page, affiliation.date, 452, 711, 130, { font, size: 10 });
  drawFitText(page, affiliation.municipio, 475, 699, 96, { font, size: 10 });

  // Nombres. Arriba siempre va el primer nombre; abajo hasta dos nombres adicionales.
  drawFitText(page, affiliation.nombre1, 412, 476, 145, { font, size: 9.6, minSize: 6.7 });
  drawFitText(page, affiliation.nombre2, 247, 449, 226, { font, size: 9.6, minSize: 6.7 });

  // Vehículo
  drawFitText(page, affiliation.auto, 329, 374, 151, { font, size: 10, minSize: 7 });
  drawFitText(page, affiliation.body, 329, 345, 151, { font, size: 10, minSize: 7 });
  drawFitText(page, affiliation.modelYear, 328, 318, 150, { font, size: 10, minSize: 7 });
  drawFitText(page, affiliation.vin, 329, 290, 151, { font, size: 8.6, minSize: 6.4 });
  drawFitText(page, affiliation.color, 325, 262, 151, { font, size: 10, minSize: 7 });

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}
