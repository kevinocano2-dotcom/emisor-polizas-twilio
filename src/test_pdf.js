import fs from 'node:fs';
import path from 'node:path';
import { buildPdfBuffer, normalizePolicyInput } from './pdf_generator.js';

const outDir = path.join(process.cwd(), 'generated');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const policy = normalizePolicyInput({
  name: 'NUBIA LUZ NAVARRO ROMERO',
  address: 'CDA EL PARAJE 15, FRACC GALA RESIDENCIAL',
  auto: 'CHEVROLET S14',
  plates: '',
  body: 'PICK UP',
  modelYear: '2000',
  vin: '1GCCS19WXY8253800',
  prima: 360,
  gastos: 135.69
}, 982, process.env.FOLIO_PREFIX || 'SANTM 2-', new Date());

const pdf = buildPdfBuffer(policy);
const file = path.join(outDir, 'prueba_twilio_982.pdf');
fs.writeFileSync(file, pdf);
console.log(file);
