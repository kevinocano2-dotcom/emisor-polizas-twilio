const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const CONFIG = require('./config');

const PORT = Number(CONFIG.PORT || 3000);
const PUBLIC_DIR = __dirname;
const FALLBACK_FILE = path.join(__dirname, 'leads-fallback.json');
const FUNNEL_FALLBACK_FILE = path.join(__dirname, 'funnel-fallback.json');
const FIXED_HERMOSILLO_CP = '83296';
let fixedLocationCache = null;
const AARCO_BASE = 'https://api.aarco.com.mx/AarcoAPICommon';

const FIXED_EMAIL = 'SEGUROYAFILIACION@GMAIL.COM';
const WHATSAPP = '526621989843';
const ANA_THIRD_PARTY_PRICE = 2700;

// Conversión provisional construida con 3 pares AARCO vs clave AXA directa.
// Se guarda la versión para poder recalibrarla conforme registres precios AXA reales.
const AXA_CONVERSION = {
  version: 'v0.1-3muestras-h19',
  factor: 1.31607,
  offset: -580.76,
  roundTo: 100
};

const AARCO_LOGIN = {
  User: CONFIG.AARCO.USER || '',
  Password: CONFIG.AARCO.PASSWORD || '',
  Origin: CONFIG.AARCO.ORIGIN || 'Cotizamatico',
  Device: CONFIG.AARCO.LOGIN_DEVICE || '',
  IdAplication: Number(CONFIG.AARCO.ID_APPLICATION || 2)
};
let aarcoPasswordSource = 'config.js';

const SESSION_SEED = {"cotizacion": {"iIdCotizacion": 0, "FechaInicioVigencia": null, "Domicilio": {}, "Persona": {}, "Credencial": {"IdCredential": 34772, "IdProfile": 85}, "SubRamo": {"iIdSubRamo": 1, "sSubramo": "AUTOS"}, "Sucursal": {"iIdSucursal": 114, "sSucursal": null}, "Asociado": {"iIdAsociado": 20824, "sClaveAsociado": "HM5812"}, "Vehiculo": {}, "PaqueteCoberturas": null, "Compania": {"sNombre": "AARCO", "sConexionCotizamatico": "Cotizamaticos", "sConexionDatosComunes": "AARCODatosComunes", "sConexion3030Net": "AARCO3030DotNet", "sCatalogoService": "http://192.168.211.5/AARCOCommon_PCC/CatalogoService.svc", "sCotizacionService": "http://192.168.211.5/AARCOCommon_PCC/CotizacionService.svc", "sPersonaService": "http://192.168.211.5/AARCOCommon_PCC/PersonaService.svc", "sEquivalenciaService": "http://192.168.211.5/AARCOCommon_PCC/EquivalenciaService.svc", "sLoggingService": "http://192.168.211.5/AARCOCommon_PCC/LoggingService.svc"}, "sXmls": {"XMLRSA": "C:\\inetpub\\wwwroot\\AarcoAPICommon\\XmlCotizacionEmision\\xmlCotizacionRsa.xml"}, "iIva": 1.16, "iIdAseguradora": 0, "iDescuento": 0, "iTipoDispositivo": 13, "iTipoCotizacion": 0, "bAsistencias": false, "sCotizacionTemporal": null, "Documento3030": null}, "idEncabezadoSolicitud": 0, "bSiNoTemporal": 0, "FiltrosCoberturasAPI": null, "Valor": null, "User": "JOCAÑO", "Device": "149bbab9bd4f828e1410e7f701d91a0c", "Token": "", "Captcha": "", "IdDocumentoRenovacion": 0, "CodPromo": ""};

const INSURERS = {
  1:'AXA', 2:'CHUBB', 4:'SURA', 5:'ZURICH', 6:'MAPFRE',
  26:'QUALITAS', 27:'BANORTE', 450:'ANA', 494:'AFIRME', 553:'HDI'
};

let aarcoSession = {
  token: '',
  user: AARCO_LOGIN.User,
  device: CONFIG.AARCO.SESSION_DEVICE || (SESSION_SEED.Device || ''),
  template: JSON.parse(JSON.stringify(SESSION_SEED)),
  lastLoginAt: 0,
  lastCheckAt: 0,
  state: 'checking',
  message: 'Comprobando acceso AARCO…'
};

let dbState = {
  state: 'checking',
  message: 'Comprobando Supabase…',
  lastCheckAt: 0
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function safeText(v, max=300) {
  return String(v ?? '').trim().slice(0, max);
}

function normalizeMexicanPhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Solicitud demasiado grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function classifyAarcoError(msg) {
  const s = String(msg || '').toLowerCase();
  if (/contrase|password|usuario|credencial|autent|login|acceso|token/.test(s)) return 'auth_error';
  return 'error';
}

async function aarcoPost(endpoint, payload, timeoutMs=45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(AARCO_BASE + endpoint, {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        'Accept':'application/json, text/plain, */*',
        'Origin':'https://www.cotizamatico.com.mx',
        'Referer':'https://www.cotizamatico.com.mx/'
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`AARCO respondió HTTP ${r.status} sin JSON.`); }
    if (!r.ok) throw new Error(`AARCO HTTP ${r.status}.`);
    if (body && body.Error) {
      const d = typeof body.Error === 'string' ? body.Error : body.Error.Descripcion;
      if (d) throw new Error(d);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}


async function encryptAarcoPassword(plainPassword) {
  // Cotizamático cifra la contraseña antes de llamar /api/login.
  // Reproducimos ese mismo paso para que desde el panel puedas escribir
  // la nueva contraseña normal y el servidor guarde sólo el valor cifrado.
  const tokenUrl = AARCO_BASE + '/api/encripta/token?user=cotizamatico&password=' + encodeURIComponent('Temporal1.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const tr = await fetch(tokenUrl, {
      method:'POST',
      headers:{
        'Accept':'application/json, text/plain, */*',
        'Origin':'https://www.cotizamatico.com.mx',
        'Referer':'https://www.cotizamatico.com.mx/'
      },
      signal:ctrl.signal
    });
    if (!tr.ok) throw new Error('No se pudo preparar el cifrado de AARCO.');
  } finally {
    clearTimeout(timer);
  }

  const enc = await aarcoPost('/api/encripta', {sTexto:String(plainPassword)}, 30000);
  let value = enc?.valor;
  if (!value) throw new Error('AARCO no devolvió la contraseña cifrada.');

  // En el flujo real valor puede venir como un string que contiene comillas JSON.
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') value = parsed;
    } catch {}
  }
  return String(value).replace(/^"+|"+$/g,'');
}

function parseCatalog(data) {
  if (!data || !data.CatalogoJsonString) return [];
  return typeof data.CatalogoJsonString === 'string'
    ? JSON.parse(data.CatalogoJsonString)
    : data.CatalogoJsonString;
}

async function loginAarco(force=false) {
  const now = Date.now();
  if (!force && aarcoSession.token && now - aarcoSession.lastLoginAt < 40 * 60 * 1000) {
    return aarcoSession;
  }
  if (!AARCO_LOGIN.User || !AARCO_LOGIN.Password || !AARCO_LOGIN.Device) {
    aarcoSession.state = 'auth_error';
    aarcoSession.message = 'Faltan variables de acceso AARCO en Render.';
    throw new Error(aarcoSession.message);
  }

  try {
    const login = await aarcoPost('/api/login', AARCO_LOGIN, 45000);
    if (!login || !login.Token) throw new Error('AARCO no devolvió token de sesión.');

    const template = clone(SESSION_SEED);
    template.User = AARCO_LOGIN.User;
    template.Device = aarcoSession.device;
    template.Token = login.Token;

    template.cotizacion = template.cotizacion || {};
    template.cotizacion.Credencial = template.cotizacion.Credencial || {};
    template.cotizacion.Asociado = template.cotizacion.Asociado || {};

    if (login.IdCredential) template.cotizacion.Credencial.IdCredential = login.IdCredential;
    const app = (login.Aplicaciones || []).find(x => Number(x.IdApplication) === Number(AARCO_LOGIN.IdAplication));
    if (app?.Profile?.IdProfile) template.cotizacion.Credencial.IdProfile = app.Profile.IdProfile;
    if (login.IdAsociado) template.cotizacion.Asociado.iIdAsociado = login.IdAsociado;
    if (login.ClaveAsociado) template.cotizacion.Asociado.sClaveAsociado = login.ClaveAsociado;

    aarcoSession = {
      ...aarcoSession,
      token: login.Token,
      template,
      lastLoginAt: now,
      lastCheckAt: now,
      state:'ok',
      message:'AARCO conectado y sesión activa.'
    };
    return aarcoSession;
  } catch (e) {
    aarcoSession.token = '';
    aarcoSession.lastCheckAt = now;
    aarcoSession.state = classifyAarcoError(e.message);
    aarcoSession.message = aarcoSession.state === 'auth_error'
      ? 'AARCO rechazó el acceso. Revisar usuario/contraseña o vigencia de la cuenta.'
      : 'AARCO no respondió correctamente.';
    throw e;
  }
}

async function checkAarco(force=false) {
  const now = Date.now();
  if (!force && now - aarcoSession.lastCheckAt < 5 * 60 * 1000 && aarcoSession.state !== 'checking') {
    return aarcoSession;
  }
  try {
    await loginAarco(force);
    // además verificamos que el servicio de catálogo responda.
    const cat = await aarcoPost('/api/catalogo', {NombreCatalogo:'Modelos', IdAplication:2}, 25000);
    const rows = parseCatalog(cat);
    if (!rows.length) throw new Error('Catálogo de AARCO vacío.');
    aarcoSession.lastCheckAt = Date.now();
    aarcoSession.state = 'ok';
    aarcoSession.message = 'AARCO conectado y cotizador disponible.';
  } catch (e) {
    if (aarcoSession.state !== 'auth_error') {
      aarcoSession.state = classifyAarcoError(e.message);
      aarcoSession.message = aarcoSession.state === 'auth_error'
        ? 'AARCO: acceso rechazado. Revisar contraseña.'
        : 'AARCO: servicio temporalmente no disponible.';
    }
    aarcoSession.lastCheckAt = Date.now();
  }
  return aarcoSession;
}

function supabaseConfigured() {
  return Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest(method, tablePath, body) {
  if (!supabaseConfigured()) throw new Error('Supabase no configurado.');
  const base = CONFIG.SUPABASE_URL.replace(/\/$/, '');
  const key = CONFIG.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': key,
    'Content-Type':'application/json',
    'Accept':'application/json'
  };
  if (!String(key).startsWith('sb_secret_')) {
    headers['Authorization'] = 'Bearer ' + key;
  }
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';
  const r = await fetch(base + '/rest/v1/' + tablePath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${typeof parsed === 'string' ? parsed.slice(0,220) : JSON.stringify(parsed).slice(0,220)}`);
  return parsed;
}

async function checkDb(force=false) {
  const now = Date.now();
  if (!force && now - dbState.lastCheckAt < 60 * 1000 && dbState.state !== 'checking') return dbState;
  if (!supabaseConfigured()) {
    dbState = {state:'fallback', message:'Supabase pendiente de configurar; usando respaldo local del servidor.', lastCheckAt:now};
    return dbState;
  }
  try {
    await supabaseRequest('GET', 'leads?select=id&limit=1');
    dbState = {state:'ok', message:'Supabase conectado.', lastCheckAt:now};
    await syncFallbackLeads().catch(()=>{});
    await flushFunnelQueue().catch(()=>{});
    const pending = readFallback().length + readFunnelFallback().length;
    dbState.message = pending
      ? `Supabase conectado. Pendientes por sincronizar: ${pending}.`
      : 'Supabase conectado. Sin pendientes.';
  } catch (e) {
    const pending = readFallback().length + readFunnelFallback().length;
    dbState = {
      state:'fallback',
      message:`Supabase no disponible. Respaldo activo${pending ? ` · ${pending} pendientes` : ''}.`,
      lastCheckAt:now
    };
  }
  return dbState;
}

async function getSetting(key) {
  if (!supabaseConfigured()) return null;
  try {
    const rows = await supabaseRequest('GET', `app_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0].value : null;
  } catch {
    return null;
  }
}

async function setSetting(key, value) {
  if (!supabaseConfigured()) throw new Error('Supabase no está configurado.');
  const existing = await supabaseRequest('GET', `app_settings?select=key&key=eq.${encodeURIComponent(key)}&limit=1`);
  if (Array.isArray(existing) && existing[0]) {
    return await supabaseRequest('PATCH', `app_settings?key=eq.${encodeURIComponent(key)}`, {
      value, updated_at:new Date().toISOString()
    });
  }
  return await supabaseRequest('POST', 'app_settings', {
    key, value, updated_at:new Date().toISOString()
  });
}

async function loadStoredAarcoPassword() {
  const saved = await getSetting('aarco_password');
  if (saved) {
    AARCO_LOGIN.Password = String(saved);
    aarcoPasswordSource = 'Supabase';
  } else {
    AARCO_LOGIN.Password = CONFIG.AARCO.PASSWORD || '';
    aarcoPasswordSource = 'config.js';
  }
  aarcoSession.token = '';
  aarcoSession.lastLoginAt = 0;
}

function ensureFallbackFile() {
  if (!fs.existsSync(path.dirname(FALLBACK_FILE))) fs.mkdirSync(path.dirname(FALLBACK_FILE), {recursive:true});
  if (!fs.existsSync(FALLBACK_FILE)) fs.writeFileSync(FALLBACK_FILE, '[]');
}
function readFallback() {
  ensureFallbackFile();
  try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); }
  catch { return []; }
}
function writeFallback(rows) {
  ensureFallbackFile();
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(rows, null, 2));
}

function ensureFunnelFallbackFile() {
  if (!fs.existsSync(FUNNEL_FALLBACK_FILE)) fs.writeFileSync(FUNNEL_FALLBACK_FILE, '[]');
}
function readFunnelFallback() {
  ensureFunnelFallbackFile();
  try { return JSON.parse(fs.readFileSync(FUNNEL_FALLBACK_FILE, 'utf8')); }
  catch { return []; }
}
function writeFunnelFallback(rows) {
  ensureFunnelFallbackFile();
  fs.writeFileSync(FUNNEL_FALLBACK_FILE, JSON.stringify(rows.slice(-10000), null, 2));
}
function queueFunnelOperation(op) {
  const rows = readFunnelFallback();
  rows.push({...op, queued_at:new Date().toISOString()});
  writeFunnelFallback(rows);
}

async function upsertSupabaseRow(table, conflictColumn, payload) {
  const keyValue = payload[conflictColumn];
  if (keyValue === undefined || keyValue === null || keyValue === '') throw new Error('Falta llave de upsert.');
  const existing = await supabaseRequest(
    'GET',
    `${table}?select=${encodeURIComponent(conflictColumn)}&${conflictColumn}=eq.${encodeURIComponent(keyValue)}&limit=1`
  );
  if (Array.isArray(existing) && existing[0]) {
    return await supabaseRequest(
      'PATCH',
      `${table}?${conflictColumn}=eq.${encodeURIComponent(keyValue)}`,
      payload
    );
  }
  return await supabaseRequest('POST', table, payload);
}

async function syncFallbackLeads() {
  if (!supabaseConfigured()) return 0;
  const pending = readFallback();
  if (!pending.length) return 0;
  const keep = [];
  let synced = 0;

  for (const raw of pending) {
    const row = {...raw};
    delete row.storage;
    try {
      await upsertSupabaseRow('leads', 'id', row);
      synced++;
    } catch {
      keep.push(raw);
    }
  }
  writeFallback(keep);
  return synced;
}

async function flushFunnelQueue() {
  if (!supabaseConfigured()) return 0;
  const pending = readFunnelFallback();
  if (!pending.length) return 0;
  const keep = [];
  let synced = 0;

  for (const op of pending) {
    try {
      if (op.type === 'session') {
        await upsertSupabaseRow('visitor_sessions', 'session_id', op.payload);
      } else if (op.type === 'event') {
        await upsertSupabaseRow('funnel_events', 'id', op.payload);
      }
      synced++;
    } catch {
      keep.push(op);
    }
  }
  writeFunnelFallback(keep);
  return synced;
}

function funnelStateClean(d={}) {
  const s = d.state || {};
  return {
    session_id:safeText(d.session_id || s.session_id,80),
    updated_at:new Date().toISOString(),
    source_params:d.source_params || s.source_params || {},
    last_step:safeText(d.event || s.last_step,80),
    vehicle_origin:safeText(s.vehicle_origin,30),
    vehicle_type:safeText(s.vehicle_type,30),
    vehicle_year:s.vehicle_year ? Number(s.vehicle_year) : null,
    vehicle_make:safeText(s.vehicle_make,100),
    vehicle_model:safeText(s.vehicle_model,160),
    vehicle_version:safeText(s.vehicle_version,220),
    vehicle_notes:safeText(s.vehicle_notes,1000),
    age:s.age ? Number(s.age) : null,
    sex:safeText(s.sex,20),
    whatsapp:normalizeMexicanPhone(s.whatsapp),
    quote_started:Boolean(s.quote_started),
    axa_shown:Boolean(s.axa_shown),
    whatsapp_clicked:Boolean(s.whatsapp_clicked),
    axa_estimated_price:s.axa_estimated_price ? Number(s.axa_estimated_price) : null,
    aarco_quote_id:s.aarco_quote_id ? Number(s.aarco_quote_id) : null,
    lead_id:s.lead_id || null
  };
}

async function saveFunnelEvent(d) {
  const session = funnelStateClean(d);
  if (!session.session_id) throw new Error('Falta session_id.');
  const now = new Date().toISOString();
  const event = {
    id:crypto.randomUUID(),
    session_id:session.session_id,
    event_name:safeText(d.event || 'evento',80),
    event_data:d.data || {},
    created_at:now
  };

  if (event.event_name === 'quote_started') session.quote_started = true;
  if (event.event_name === 'axa_shown') session.axa_shown = true;
  if (event.event_name.startsWith('whatsapp_')) session.whatsapp_clicked = true;

  const sessionPayload = {...session, created_at:d.created_at || now};

  try {
    if (!supabaseConfigured()) throw new Error('Supabase no configurado.');
    await upsertSupabaseRow('visitor_sessions','session_id',sessionPayload);
    await upsertSupabaseRow('funnel_events','id',event);
    return {ok:true,storage:'supabase'};
  } catch {
    queueFunnelOperation({type:'session',payload:sessionPayload});
    queueFunnelOperation({type:'event',payload:event});
    dbState = {
      state:'fallback',
      message:`Supabase no disponible. Respaldo activo · ${readFallback().length + readFunnelFallback().length} pendientes.`,
      lastCheckAt:Date.now()
    };
    return {ok:true,storage:'fallback'};
  }
}

async function getFunnelReport(days=7) {
  const since = new Date(Date.now() - Math.max(1, Number(days)||7)*86400000).toISOString();
  let events = [];
  let sessions = [];

  if (supabaseConfigured()) {
    try {
      events = await supabaseRequest('GET', `funnel_events?select=*&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=10000`) || [];
      sessions = await supabaseRequest('GET', `visitor_sessions?select=*&created_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=1000`) || [];
    } catch {}
  }

  const stages = [
    ['page_view','Visitas'],
    ['origin_selected','Origen elegido'],
    ['vehicle_type_selected','Tipo de vehículo'],
    ['vehicle_step_completed','Vehículo / descripción'],
    ['phone_saved','WhatsApp capturado'],
    ['personal_complete','Edad y sexo'],
    ['quote_started','Cotización iniciada'],
    ['axa_shown','AXA mostrado'],
    ['whatsapp_click','WhatsApp']
  ];

  const uniqueFor = matcher => {
    const set = new Set();
    for (const e of events) {
      const name = String(e.event_name || '');
      if (matcher(name)) set.add(e.session_id);
    }
    return set.size;
  };

  const counts = {};
  for (const [key] of stages) {
    counts[key] = key === 'whatsapp_click'
      ? uniqueFor(n => n.startsWith('whatsapp_'))
      : uniqueFor(n => n === key);
  }

  const incomplete = sessions
    .filter(s => !s.axa_shown && !s.whatsapp_clicked)
    .slice(0,100);

  return {
    days:Number(days)||7,
    counts,
    stages:stages.map(([key,label])=>({key,label,count:counts[key]})),
    incomplete,
    pending_sync:readFallback().length + readFunnelFallback().length
  };
}

async function getFixedHermosilloLocation(force=false) {
  if (!force && fixedLocationCache) return fixedLocationCache;
  await loginAarco(false);
  const d = await aarcoPost('/api/CatalogoDatosSepomex', {
    User:aarcoSession.user,
    Device:aarcoSession.device,
    Token:aarcoSession.token,
    sCodigoPostal:FIXED_HERMOSILLO_CP
  }, 30000);

  const ubicaciones = Array.isArray(d.Ubicaciones) ? d.Ubicaciones : [];
  const ub = ubicaciones.find(x => /NUEVO HERMOSILLO/i.test(String(x.sUbicacion||''))) || ubicaciones[0];
  if (!ub) throw new Error('No se pudo resolver la ubicación fija de Hermosillo.');

  fixedLocationCache = {
    cp:FIXED_HERMOSILLO_CP,
    ubicacion_id:ub.iIdUbicacion,
    ubicacion_text:ub.sUbicacion,
    municipio_id:d.iIdMunicipio,
    municipio_text:d.sMunicipio || 'Hermosillo',
    estado_id:d.iIdEstado,
    estado_text:d.sEstado || 'Sonora'
  };
  return fixedLocationCache;
}

async function saveLead(payload, leadId=null) {
  const now = new Date().toISOString();
  const clean = {
    updated_at: now,
    session_id: safeText(payload.session_id, 80),
    source: safeText(payload.source || 'web'),
    status: safeText(payload.status || 'nuevo', 40),
    name: safeText(payload.name, 120),
    whatsapp: normalizeMexicanPhone(payload.whatsapp),
    vehicle_origin: safeText(payload.vehicle_origin, 30),
    vehicle_type: safeText(payload.vehicle_type, 30),
    vehicle_year: payload.vehicle_year ? Number(payload.vehicle_year) : null,
    vehicle_make: safeText(payload.vehicle_make, 100),
    vehicle_model: safeText(payload.vehicle_model, 160),
    vehicle_version: safeText(payload.vehicle_version, 220),
    vehicle_notes: safeText(payload.vehicle_notes, 1000),
    postal_code: safeText(payload.postal_code, 10),
    colony: safeText(payload.colony, 160),
    age: payload.age ? Number(payload.age) : null,
    sex: safeText(payload.sex, 20),
    fixed_email: FIXED_EMAIL,
    ana_third_party_price: payload.ana_third_party_price ? Number(payload.ana_third_party_price) : null,
    customer_choice: safeText(payload.customer_choice, 60),
    source_params: payload.source_params ?? null,
    last_error: safeText(payload.last_error, 500),
    last_event: safeText(payload.last_event, 80)
  };

  if ('aarco_quote_id' in payload) clean.aarco_quote_id = payload.aarco_quote_id ? Number(payload.aarco_quote_id) : null;
  if ('axa_aarco_price' in payload) clean.axa_aarco_price = payload.axa_aarco_price ? Number(payload.axa_aarco_price) : null;
  if ('axa_estimated_price' in payload) clean.axa_estimated_price = payload.axa_estimated_price ? Number(payload.axa_estimated_price) : null;
  if ('axa_actual_price' in payload) clean.axa_actual_price = payload.axa_actual_price ? Number(payload.axa_actual_price) : null;
  if ('conversion_version' in payload) clean.conversion_version = safeText(payload.conversion_version, 80);
  if ('all_quotes' in payload) clean.all_quotes = payload.all_quotes ?? null;

  try {
    if (supabaseConfigured()) {
      if (leadId) {
        const rows = await supabaseRequest('PATCH', `leads?id=eq.${encodeURIComponent(leadId)}`, clean);
        if (Array.isArray(rows) && rows[0]) return {...rows[0], storage:'supabase'};
      }
      const inserted = await supabaseRequest('POST', 'leads', {...clean, created_at:now});
      if (Array.isArray(inserted) && inserted[0]) return {...inserted[0], storage:'supabase'};
    }
  } catch (e) {
    dbState = {state:'fallback', message:'Supabase falló; guardando respaldo local.', lastCheckAt:Date.now()};
  }

  // Respaldo para no perder el lead si Supabase está momentáneamente fuera.
  const rows = readFallback();
  const id = leadId || crypto.randomUUID();
  const idx = rows.findIndex(x => x.id === id);
  const row = {...(idx >= 0 ? rows[idx] : {id, created_at:now}), ...clean, id, storage:'fallback'};
  if (idx >= 0) rows[idx] = row; else rows.unshift(row);
  writeFallback(rows.slice(0, 5000));
  return row;
}

async function listLeads(limit=100) {
  if (supabaseConfigured()) {
    try {
      const rows = await supabaseRequest('GET', `leads?select=*&order=created_at.desc&limit=${Math.min(Number(limit)||100,500)}`);
      if (Array.isArray(rows)) return rows;
    } catch {}
  }
  return readFallback().slice(0, Math.min(Number(limit)||100,500));
}

async function updateLeadAdmin(id, patch) {
  const allowed = {};
  for (const k of ['status','axa_actual_price','customer_choice','last_event']) {
    if (k in patch) allowed[k] = patch[k];
  }

  if ('comments' in patch) allowed.comments = safeText(patch.comments, 5000);

  const messageFlags = [
    'msg_axa_sent',
    'msg_ana_sent',
    'msg_other_options_sent',
    'msg_followup_sent'
  ];

  for (const k of messageFlags) {
    if (k in patch) {
      allowed[k] = Boolean(patch[k]);
      allowed[k + '_at'] = allowed[k] ? new Date().toISOString() : null;
    }
  }

  if ('axa_actual_price' in allowed && allowed.axa_actual_price) allowed.axa_actual_price = Number(allowed.axa_actual_price);
  allowed.updated_at = new Date().toISOString();

  if (supabaseConfigured()) {
    try {
      const rows = await supabaseRequest('PATCH', `leads?id=eq.${encodeURIComponent(id)}`, allowed);
      if (Array.isArray(rows) && rows[0]) return rows[0];
    } catch {}
  }

  const rows = readFallback();
  const idx = rows.findIndex(x => x.id === id);
  if (idx < 0) throw new Error('Lead no encontrado.');
  rows[idx] = {...rows[idx], ...allowed};
  writeFallback(rows);
  return rows[idx];
}


async function patchLeadFields(id, fields) {
  const clean = {...fields, updated_at:new Date().toISOString()};
  if (supabaseConfigured()) {
    try {
      const rows = await supabaseRequest('PATCH', `leads?id=eq.${encodeURIComponent(id)}`, clean);
      if (Array.isArray(rows) && rows[0]) return rows[0];
    } catch {}
  }

  const rows = readFallback();
  const idx = rows.findIndex(x => x.id === id);
  if (idx >= 0) {
    rows[idx] = {...rows[idx], ...clean};
    writeFallback(rows);
    return rows[idx];
  }
  return null;
}


function approximateDob(age) {
  const a = Number(age);
  if (!Number.isInteger(a) || a < 18 || a > 95) throw new Error('Edad inválida.');
  const year = new Date().getFullYear() - a;
  return `${year}-01-01`;
}

function currentVigencia() {
  const d = new Date();
  const z = n => String(n).padStart(2,'0');
  return `${z(d.getDate())}/${z(d.getMonth()+1)}/${d.getFullYear()}, ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

function convertAxa(aarcoPrice) {
  const raw = Number(aarcoPrice) * AXA_CONVERSION.factor + AXA_CONVERSION.offset;
  const rounded = Math.round(raw / AXA_CONVERSION.roundTo) * AXA_CONVERSION.roundTo;
  return Math.max(0, rounded);
}

function normalizeQuote(item) {
  const id = Number(item.IdAseguradora);
  return {
    id,
    insurer: INSURERS[id] || `Aseguradora ${id}`,
    annual: {
      amplia: Number(item.PrimaAmplia || 0),
      amplia_plus: Number(item.PrimaAmpliaPlus || 0),
      limitada: Number(item.PrimaLimitada || 0),
      basica: Number(item.PrimaBasica || 0)
    }
  };
}

function validateMexicanQuoteBody(d) {
  const required = [
    'modelo_id','modelo_text','marca_id','marca_text',
    'submarca_id','submarca_text','version_id','version_text',
    'age','sex'
  ];
  const missing = required.filter(k => d[k] === undefined || d[k] === null || String(d[k]).trim() === '');
  if (missing.length) throw new Error('Faltan datos para cotizar: ' + missing.join(', '));
}

function buildQuoteRequest(d) {
  validateMexicanQuoteBody(d);
  const s = clone(aarcoSession.template);
  s.User = aarcoSession.user;
  s.Device = aarcoSession.device;
  s.Token = aarcoSession.token;
  s.Captcha = '';
  s.idEncabezadoSolicitud = 0;
  s.bSiNoTemporal = 0;
  s.FiltrosCoberturasAPI = null;
  s.Valor = null;
  s.IdDocumentoRenovacion = 0;
  s.CodPromo = '';

  const c = s.cotizacion;
  c.iIdCotizacion = 0;
  c.FechaInicioVigencia = currentVigencia();
  c.PaqueteCoberturas = null;

  c.Domicilio = {
    iIdUbicacion:Number(d.ubicacion_id),
    sCodigoPostal:String(d.cp),
    iIdMunicipio:Number(d.municipio_id),
    sUbicacion:String(d.ubicacion_text),
    sMunicipio:String(d.municipio_text),
    iIdEstado:Number(d.estado_id),
    iEstadoPais:0,
    iClaveEstadoCepomex:0,
    sEstado:String(d.estado_text),
    sCalle:null, sNumeroExterior:null, sNumeroInterior:null
  };

  c.Persona = {
    IdPersona:null,
    sNombre:safeText(d.name,120) || 'CLIENTE WEB',
    sApellidoPaterno:'CLIENTE',
    sApellidoMaterno:null,
    sFechaNacimiento:approximateDob(Number(d.age)),
    sRfc:null, sCurp:null,
    iEdad:String(Number(d.age)),
    iSexo:String(d.sex === 'mujer' ? 2 : 1),
    bSiNoFuma:false,
    sEmail:FIXED_EMAIL,
    sTelefono:safeText(d.whatsapp,20) || '6620000000',
    iIdPais:0, sNacionalidad:null, iIdOcupacion:0, bSiNoPersonaMoral:false
  };

  c.Vehiculo = {
    iIdVehiculoCotizacion:null, iValorUnidad:0, iValorFactura:0, iIdTipoCarga:0,
    sTipoCarga:'', FechaFactura:null,
    Marca:{iIdMarca:Number(d.marca_id),sMarca:String(d.marca_text)},
    SubMarca:{iIdMarcaSubramo:Number(d.submarca_id),sSubMarca:String(d.submarca_text)},
    Modelo:{iIdModelo:Number(d.modelo_id),sModelo:String(d.modelo_text)},
    DescripcionModelo:{
      iIdDescripcionModelo:Number(d.version_id),
      iIdModeloSubmarca:Number(d.submarca_id),
      iIdMostrar:0,
      sDescripcion:String(d.version_text),
      bSiNoCotizamatico:null, bSiNoFlotillas:null
    },
    iValorPolizaMultiAnual:0
  };
  return s;
}

async function startAarcoQuote(d) {
  await loginAarco(false);
  const fixedLocation = await getFixedHermosilloLocation(false);
  const quoteData = {...d, ...fixedLocation};
  let body = buildQuoteRequest(quoteData);
  let init;
  try {
    init = await aarcoPost('/api/Recotizacion', body, 65000);
  } catch (e) {
    await loginAarco(true);
    fixedLocationCache = null;
    const retryLocation = await getFixedHermosilloLocation(true);
    body = buildQuoteRequest({...d, ...retryLocation});
    init = await aarcoPost('/api/Recotizacion', body, 65000);
  }

  const petition = init.IdPeticionCotizacion;
  if (!petition) throw new Error('AARCO no devolvió IdPeticionCotizacion.');
  return {petition};
}

async function pollAarcoPetition(petition) {
  return await aarcoPost('/api/Peticion', {
    User:aarcoSession.user,
    Device:aarcoSession.device,
    Token:aarcoSession.token,
    IdPeticion:petition
  }, 40000);
}

function mergePollQuotes(byCompany, poll) {
  for (const raw of poll.JsonCotizacion || []) {
    try {
      const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (item && item.IdAseguradora != null) byCompany.set(Number(item.IdAseguradora), item);
    } catch {}
  }
}

async function getAxaAsSoonAsAvailable(d) {
  const {petition} = await startAarcoQuote(d);
  const byCompany = new Map();
  let idCotizacion = 0;
  let finalStatus = 1;

  for (let i=0; i<24; i++) {
    await sleep(i === 0 ? 1200 : 2200);
    const poll = await pollAarcoPetition(petition);
    mergePollQuotes(byCompany, poll);
    idCotizacion = poll.IdCotizacion || idCotizacion;
    finalStatus = Number(poll.Estatus || 1);

    const axaRaw = byCompany.get(1);
    if (axaRaw && Number(axaRaw.PrimaAmplia || 0) > 0) {
      return {petition, byCompany, idCotizacion, finalStatus, axaRaw};
    }
    if (finalStatus === 2) break;
  }

  return {petition, byCompany, idCotizacion, finalStatus, axaRaw:byCompany.get(1) || null};
}

async function finishQuoteInBackground(ctx, d, leadId, thirdPartyEligible) {
  const byCompany = ctx.byCompany;
  let idCotizacion = ctx.idCotizacion || 0;
  let finalStatus = ctx.finalStatus || 1;

  try {
    if (finalStatus !== 2) {
      for (let i=0; i<22; i++) {
        await sleep(2200);
        const poll = await pollAarcoPetition(ctx.petition);
        mergePollQuotes(byCompany, poll);
        idCotizacion = poll.IdCotizacion || idCotizacion;
        finalStatus = Number(poll.Estatus || 1);
        if (finalStatus === 2) break;
      }
    }

    const all = [...byCompany.values()].map(normalizeQuote);
    const axa = all.find(x => x.id === 1);
    const aarcoAxa = Number(axa?.annual?.amplia || 0);
    const estimated = aarcoAxa > 0 ? convertAxa(aarcoAxa) : 0;

    await patchLeadFields(leadId, {
      aarco_quote_id:idCotizacion || null,
      axa_aarco_price:aarcoAxa || null,
      axa_estimated_price:estimated || null,
      conversion_version:AXA_CONVERSION.version,
      all_quotes:all,
      last_error:aarcoAxa ? '' : 'AXA no devolvió prima amplia',
      last_event:'otras_companias_guardadas'
    });
  } catch (e) {
    try {
      await patchLeadFields(leadId, {
        last_error:'Segundo plano AARCO: ' + e.message
      });
    } catch {}
  }
}

function sourceParams(u) {
  const keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'];
  const out = {};
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v) out[k] = v.slice(0,300);
  }
  return out;
}

async function apiRouter(req, res, u) {
  if (req.method === 'GET' && u.pathname === '/api/health') {
    await Promise.all([checkAarco(false), checkDb(false)]);
    return json(res, 200, {
      page: {state:'ok', message:'Página en línea.'},
      aarco: {state:aarcoSession.state, message:aarcoSession.message, lastCheckAt:aarcoSession.lastCheckAt},
      database: {...dbState, pending_sync:readFallback().length + readFunnelFallback().length},
      whatsapp: {state:'ok', message:'WhatsApp disponible.'},
      now: new Date().toISOString()
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/health/recheck') {
    await Promise.all([checkAarco(true), checkDb(true)]);
    return json(res, 200, {
      aarco: {state:aarcoSession.state, message:aarcoSession.message},
      database: dbState
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/catalog/modelos') {
    try {
      const d = await aarcoPost('/api/catalogo', {NombreCatalogo:'Modelos',IdAplication:2}, 30000);
      return json(res,200,parseCatalog(d));
    } catch(e) { return json(res,502,{error:e.message}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/catalog/marcas') {
    try {
      const modelo = safeText(u.searchParams.get('modelo'),20);
      const d = await aarcoPost('/api/catalogo', {NombreCatalogo:'MarcaPorModelo',Filtro:'1',Filtro1:modelo,IdAplication:2}, 30000);
      return json(res,200,parseCatalog(d));
    } catch(e) { return json(res,502,{error:e.message}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/catalog/submarcas') {
    try {
      const modelo = safeText(u.searchParams.get('modelo'),20);
      const marca = safeText(u.searchParams.get('marca'),20);
      const d = await aarcoPost('/api/catalogo', {NombreCatalogo:'SubmarcaPorModelo',Filtro:marca,Filtro1:modelo,IdAplication:2}, 30000);
      return json(res,200,parseCatalog(d));
    } catch(e) { return json(res,502,{error:e.message}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/catalog/versiones') {
    try {
      const submarca = safeText(u.searchParams.get('submarca'),30);
      const d = await aarcoPost('/api/catalogo', {NombreCatalogo:'DescripcionModelo',Filtro:submarca,IdAplication:2}, 30000);
      return json(res,200,parseCatalog(d));
    } catch(e) { return json(res,502,{error:e.message}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/cp') {
    try {
      await loginAarco(false);
      const cp = safeText(u.searchParams.get('cp'),5);
      const d = await aarcoPost('/api/CatalogoDatosSepomex', {
        User:aarcoSession.user, Device:aarcoSession.device, Token:aarcoSession.token, sCodigoPostal:cp
      },30000);
      return json(res,200,d);
    } catch(e) {
      try {
        await loginAarco(true);
        const cp = safeText(u.searchParams.get('cp'),5);
        const d = await aarcoPost('/api/CatalogoDatosSepomex', {
          User:aarcoSession.user, Device:aarcoSession.device, Token:aarcoSession.token, sCodigoPostal:cp
        },30000);
        return json(res,200,d);
      } catch(e2) {
        return json(res,502,{error:e2.message});
      }
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/funnel/event') {
    try {
      const d = await readJson(req);
      const result = await saveFunnelEvent(d);
      return json(res,200,result);
    } catch(e) {
      return json(res,200,{ok:false,error:e.message});
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/leads/save') {
    try {
      const d = await readJson(req);
      const row = await saveLead({
        ...d,
        source:'web',
        source_params:d.source_params || {},
        ana_third_party_price: (['sedan','pickup'].includes(d.vehicle_type) ? ANA_THIRD_PARTY_PRICE : null)
      }, d.lead_id || null);
      return json(res,200,{ok:true,lead_id:row.id,storage:row.storage||'supabase'});
    } catch(e) {
      return json(res,500,{ok:false,error:e.message});
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/leads/beacon') {
    try {
      const d = await readJson(req);
      const row = await saveLead({...d,source:'web',last_event:'salida_pagina'}, d.lead_id || null);
      return json(res,200,{ok:true,lead_id:row.id});
    } catch(e) {
      return json(res,200,{ok:false});
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/leads/event') {
    try {
      const d = await readJson(req);
      if (!d.lead_id) return json(res,400,{error:'Falta lead_id'});
      const row = await saveLead({
        ...d,
        status:d.status || 'interesado',
        last_event:d.event || 'whatsapp',
        customer_choice:d.choice || ''
      }, d.lead_id);
      return json(res,200,{ok:true,lead_id:row.id});
    } catch(e) {
      return json(res,500,{error:e.message});
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/quote') {
    let d;
    try { d = await readJson(req); }
    catch(e) { return json(res,400,{error:e.message}); }

    const phone = normalizeMexicanPhone(d.whatsapp);
    if (!phone) return json(res,400,{error:'Escribe un WhatsApp válido con al menos 10 dígitos.'});
    d.whatsapp = phone;

    const thirdPartyEligible = ['sedan','pickup'].includes(String(d.vehicle_type||''));
    let leadId = d.lead_id || null;

    try {
      const saved = await saveLead({
        ...d,
        source:'web',
        postal_code:FIXED_HERMOSILLO_CP,
        colony:'Hermosillo',
        status:'cotizando',
        ana_third_party_price:thirdPartyEligible ? ANA_THIRD_PARTY_PRICE : null
      }, leadId);
      leadId = saved.id;
    } catch {}

    const exactMexicanVehicle =
      d.vehicle_origin === 'mexicano' &&
      d.modelo_id && d.marca_id && d.submarca_id && d.version_id &&
      d.age && d.sex;

    // Si el cliente sólo dejó su teléfono o no encontró el auto exacto,
    // conservamos el prospecto y no bloqueamos el flujo.
    if (d.vehicle_origin !== 'americano' && !exactMexicanVehicle) {
      try {
        const saved = await saveLead({
          ...d,
          source:'web',
          status:'datos_incompletos',
          postal_code:FIXED_HERMOSILLO_CP,
          colony:'Hermosillo',
          last_event:'solicitud_manual',
          ana_third_party_price:thirdPartyEligible ? ANA_THIRD_PARTY_PRICE : null
        }, leadId);
        leadId = saved.id;
      } catch {}

      return json(res,200,{
        ok:true,
        lead_id:leadId,
        type:'manual',
        axa:null,
        third_party:thirdPartyEligible ? {insurer:'ANA',price:ANA_THIRD_PARTY_PRICE} : null,
        manual:true
      });
    }

    // Americano: sólo terceros, no AXA.
    if (d.vehicle_origin === 'americano') {
      try {
        await saveLead({
          ...d,
          status:'cotizado',
          customer_choice:'',
          ana_third_party_price:thirdPartyEligible ? ANA_THIRD_PARTY_PRICE : null
        }, leadId);
      } catch {}
      return json(res,200,{
        ok:true,
        lead_id:leadId,
        type:'american',
        axa:null,
        third_party: thirdPartyEligible ? {insurer:'ANA',price:ANA_THIRD_PARTY_PRICE} : null
      });
    }

    try {
      const started = Date.now();
      const q = await getAxaAsSoonAsAvailable(d);
      const aarcoAxa = Number(q.axaRaw?.PrimaAmplia || 0);
      const estimated = aarcoAxa > 0 ? convertAxa(aarcoAxa) : 0;
      const partialQuotes = [...q.byCompany.values()].map(normalizeQuote);

      await saveLead({
        ...d,
        status:'cotizado',
        aarco_quote_id:q.idCotizacion || null,
        axa_aarco_price:aarcoAxa || null,
        axa_estimated_price:estimated || null,
        conversion_version:AXA_CONVERSION.version,
        ana_third_party_price:thirdPartyEligible ? ANA_THIRD_PARTY_PRICE : null,
        all_quotes:partialQuotes,
        last_error:aarcoAxa ? '' : 'AXA no devolvió prima amplia',
        last_event:'axa_mostrada'
      }, leadId);

      finishQuoteInBackground(q, d, leadId, thirdPartyEligible).catch(()=>{});

      if (d.session_id) {
        saveFunnelEvent({
          session_id:d.session_id,
          event:'axa_shown',
          state:{
            ...d,
            session_id:d.session_id,
            axa_shown:true,
            axa_estimated_price:estimated || null,
            aarco_quote_id:q.idCotizacion || null,
            lead_id:leadId
          },
          data:{price:estimated || null, quote_id:q.idCotizacion || null}
        }).catch(()=>{});
      }

      return json(res,200,{
        ok:true,
        lead_id:leadId,
        type:'mexican',
        quote_id:q.idCotizacion || null,
        seconds:Math.round((Date.now()-started)/100)/10,
        axa: estimated ? {
          insurer:'AXA',
          estimated_price:estimated,
          coverage:'Amplia',
          conversion_version:AXA_CONVERSION.version
        } : null,
        third_party: thirdPartyEligible ? {insurer:'ANA',price:ANA_THIRD_PARTY_PRICE} : null,
        aarco_state: aarcoSession.state
      });
    } catch(e) {
      aarcoSession.state = classifyAarcoError(e.message);
      aarcoSession.message = aarcoSession.state === 'auth_error'
        ? 'AARCO rechazó el acceso. Revisar contraseña.'
        : 'AARCO no pudo completar la cotización.';
      aarcoSession.lastCheckAt = Date.now();

      try {
        await saveLead({
          ...d,
          status:'error_cotizador',
          ana_third_party_price:thirdPartyEligible ? ANA_THIRD_PARTY_PRICE : null,
          last_error:e.message
        }, leadId);
      } catch {}

      return json(res,503,{
        ok:false,
        lead_id:leadId,
        error:'No pudimos obtener AXA en este momento.',
        aarco_state:aarcoSession.state,
        third_party: thirdPartyEligible ? {insurer:'ANA',price:ANA_THIRD_PARTY_PRICE} : null
      });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/admin/funnel') {
    try {
      const report = await getFunnelReport(u.searchParams.get('days') || 7);
      return json(res,200,report);
    } catch(e) {
      return json(res,500,{error:e.message});
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/admin/leads') {
    try {
      const rows = await listLeads(u.searchParams.get('limit') || 150);
      return json(res,200,rows);
    } catch(e) { return json(res,500,{error:e.message}); }
  }

  if (req.method === 'POST' && u.pathname.startsWith('/api/admin/leads/')) {
    const parts = u.pathname.split('/');
    const id = parts[4];
    try {
      const d = await readJson(req);
      const row = await updateLeadAdmin(id,d);
      return json(res,200,row);
    } catch(e) { return json(res,500,{error:e.message}); }
  }

  if (req.method === 'GET' && u.pathname === '/api/admin/aarco') {
    return json(res,200,{
      user:AARCO_LOGIN.User,
      state:aarcoSession.state,
      message:aarcoSession.message,
      password_source:aarcoPasswordSource,
      last_check_at:aarcoSession.lastCheckAt || null
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/admin/aarco/password') {
    try {
      const d = await readJson(req);
      const password = safeText(d.password, 200);
      if (password.length < 3) return json(res,400,{error:'Escribe la nueva contraseña.'});

      const encryptedPassword = await encryptAarcoPassword(password);
      await setSetting('aarco_password', encryptedPassword);
      AARCO_LOGIN.Password = encryptedPassword;
      aarcoPasswordSource = 'Supabase';
      aarcoSession.token = '';
      aarcoSession.lastLoginAt = 0;

      await checkAarco(true);
      return json(res,200,{
        ok:aarcoSession.state === 'ok',
        state:aarcoSession.state,
        message:aarcoSession.message,
        password_source:aarcoPasswordSource
      });
    } catch(e) {
      return json(res,500,{ok:false,error:e.message});
    }
  }

  return json(res,404,{error:'Ruta API no encontrada'});
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html':'text/html; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.json':'application/json; charset=utf-8',
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.svg':'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function serveStatic(req,res,u) {
  let fileName = null;
  if (u.pathname === '/' || u.pathname === '/index.html') fileName = 'index.html';
  if (u.pathname === '/panel' || u.pathname === '/panel.html') fileName = 'panel.html';
  if (!fileName) {
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
    return res.end('Not found');
  }
  const file = path.join(PUBLIC_DIR, fileName);
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
    res.end(data);
  });
}

const server = http.createServer(async (req,res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) return await apiRouter(req,res,u);
    return serveStatic(req,res,u);
  } catch(e) {
    console.error(e);
    return json(res,500,{error:'Error interno'});
  }
});

server.listen(PORT, () => {
  console.log(`Cotizador listo en http://localhost:${PORT}`);
  (async () => {
    await checkDb(true).catch(()=>{});
    await loadStoredAarcoPassword().catch(()=>{});
    await checkAarco(true).catch(()=>{});
    setInterval(()=>checkDb(true).catch(()=>{}), 60 * 1000);
  })();
});
