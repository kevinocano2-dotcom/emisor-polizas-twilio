import crypto from 'node:crypto';
import {
  clearCarteraProSession,
  getCarteraProOnboarding,
  getCarteraProSession,
  normalizePhone,
  recordCarteraProLead,
  saveCarteraProOnboarding,
  setCarteraProSession
} from './state.js';

export const CARTERAPRO_LINKS = {
  site: process.env.CARTERAPRO_SITE_URL || 'https://carteraproautos.netlify.app/',
  demo: process.env.CARTERAPRO_DEMO_URL || 'https://carteraproautos.netlify.app/demo.html',
  portal: process.env.CARTERAPRO_PORTAL_URL || 'https://carteraproautos.netlify.app/portal.html',
  basicPay: process.env.CARTERAPRO_BASIC_PAY_URL || 'https://mpago.la/1aeVAtg',
  plusPay: process.env.CARTERAPRO_PLUS_PAY_URL || 'https://mpago.la/1edpYeR'
};

function stripAccents(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function cpNorm(value = '') {
  return stripAccents(value).trim().replace(/\s+/g, ' ').toUpperCase();
}
function isOneOf(x, ...items) { return items.some(v => x === v); }
function includesAny(x, words) { return words.some(w => x.includes(w)); }
function nowIso() { return new Date().toISOString(); }
function futureIso(days = 7) { const d = new Date(); d.setDate(d.getDate()+days); return d.toISOString(); }
function token() { return crypto.randomBytes(24).toString('hex'); }
const HUMAN_HANDOFF_MS = Math.max(60*60*1000, Number(process.env.CARTERAPRO_HUMAN_HANDOFF_HOURS || 12) * 60*60*1000);
function handoffUntilMs(session){
  const raw=session?.data?.humanHandoffUntil || session?.humanHandoffUntil || '';
  const ms=raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(ms)?ms:0;
}
function humanHandoffActive(session){ return handoffUntilMs(session) > Date.now(); }
function explicitBotResume(x){ return isOneOf(x,'BOT','BOT CARTERAPRO','MENU CARTERAPRO','MENÚ CARTERAPRO','INICIO CARTERAPRO','CARTERAPRO'); }
function humanIntent(x){ return includesAny(x,['HABLAR CON KEVIN','HABLAR CON ASESOR','QUIERO UN ASESOR','QUIERO HABLAR CON ALGUIEN','ASESOR HUMANO','PERSONA REAL','QUE ME CONTACTEN','CONTÁCTAME','CONTACTAME']); }
function simpleAck(x){ return isOneOf(x,'OK','OKEY','OKAY','GRACIAS','MUCHAS GRACIAS','PERFECTO','ENTERADO','VA','LISTO'); }
async function enterHumanHandoff(phone, session, reason='cliente', noticeSent=true){
  const base=session || {state:'menu',data:{},createdAt:nowIso()};
  const until=new Date(Date.now()+HUMAN_HANDOFF_MS).toISOString();
  const next={...base,state:'human_handoff',data:{...(base.data||{}),humanHandoffUntil:until,humanHandoffReason:reason,handoffNoticeSentAt:noticeSent?nowIso():(base.data?.handoffNoticeSentAt||'')}};
  await setCarteraProSession(phone,next);
  return next;
}

function adminReplyLink(phone,text=''){
  let p=String(phone||'').replace(/\D/g,'');
  if(p.length===10)p=`52${p}`;
  if(!p)return'';
  return `https://wa.me/${p}${text?`?text=${encodeURIComponent(text)}`:''}`;
}

function planFromText(x) {
  if (includesAny(x, ['PLUS','698'])) return 'plus';
  if (includesAny(x, ['BASICO','BÁSICO','499'])) return 'basic';
  return '';
}
function planName(plan) { return plan === 'plus' ? 'Plus' : 'Básico'; }
function planPrice(plan) { return plan === 'plus' ? 698 : 499; }
function paymentLink(plan) { return plan === 'plus' ? CARTERAPRO_LINKS.plusPay : CARTERAPRO_LINKS.basicPay; }

function intro() {
  return [
    '👋 *Hola, soy el asistente de CarteraPro.*',
    '',
    '*CarteraPro no es otro CRM para capturar datos.* Está pensado para que un agente convierta su cartera en acciones por WhatsApp.',
    '',
    '📄 Cargas la póliza PDF → CarteraPro guarda automáticamente los datos principales.',
    '💳 Cargas tu reporte de pagos AXA → cruza los recibos y actualiza la cobranza.',
    '📋 El sistema te dice a quién cobrar, renovar o contactar.',
    '💬 Presionas WhatsApp → el mensaje sale preparado con los datos de la póliza.',
    '',
    '🎁 *La carga inicial de tu cartera está incluida sin costo adicional.*',
    '',
    '1️⃣ Ver demo completa',
    '2️⃣ Ver cómo funciona',
    '3️⃣ Plan Básico · $499/mes',
    '4️⃣ Plan Plus · $698/mes',
    '5️⃣ Comparar planes',
    '6️⃣ Preguntas frecuentes',
    '7️⃣ Ya compré / cargar mi cartera',
    '',
    'También puedes escribir tu pregunta directamente.'
  ].join('\n');
}
function demoReply() {
  return [
    '🧪 *Demo práctica de CarteraPro*',
    '',
    CARTERAPRO_LINKS.demo,
    '',
    'No es solo una pantalla de CRM. En la demo puedes ver el flujo real:',
    '1) cómo una póliza PDF se convierte en datos;',
    '2) cómo los pagos cambian los pendientes;',
    '3) cómo aparecen cobros y renovaciones;',
    '4) y un botón que abre *WhatsApp de verdad* con un recordatorio listo para enviar.',
    '',
    'Los datos de la demo son ficticios. Si pruebas un PDF real, no se agrega a una cartera productiva.',
    '',
    'Cuando termines escribe *BASICO*, *PLUS* o *COMPARAR*.'
  ].join('\n');
}
function howItWorks() {
  return [
    '⚙️ *Así se usa CarteraPro en el trabajo diario*',
    '',
    '1. *Subes la póliza PDF.* El lector extrae cliente, póliza, VIN/serie, vigencia, total y otros datos disponibles del formato.',
    '2. *Actualizas pagos.* En AXA, al cargar el reporte de Prima pagada, CarteraPro cruza la información y actualiza recibos/pagos automáticamente.',
    '3. *Abres “A quién escribir”.* Ya no buscas cliente por cliente: ves cobranza, renovaciones y seguimientos priorizados.',
    '4. *Presionas WhatsApp.* El sistema prepara el mensaje con la información del cliente y registra el seguimiento.',
    '',
    'Eso es lo que buscamos automatizar: *menos captura y búsqueda; más seguimiento real.*',
    '',
    '🎁 Te ayudamos con la carga inicial de tu cartera sin costo adicional.',
    '',
    `Demo: ${CARTERAPRO_LINKS.demo}`
  ].join('\n');
}
function planReply(plan) {
  const plus = plan === 'plus';
  return [
    `${plus ? '✨' : '🔹'} *CarteraPro ${planName(plan)} · $${planPrice(plan)} MXN/mes*`,
    '',
    ...(plus ? [
      '✓ Todo lo incluido en Básico',
      '✓ Cobranza avanzada',
      '✓ Campañas manuales y seguimiento',
      '✓ Reportes, CSV, backups y análisis'
    ] : [
      '✓ Carga y organización de pólizas',
      '✓ Actualización de pagos AXA',
      '✓ A quién cobrar, renovar o contactar',
      '✓ Seguimiento por WhatsApp'
    ]),
    '✓ *Carga inicial de tu cartera sin costo adicional*',
    '',
    '💡 Dependiendo del valor de tus comisiones, recuperar 1 o 2 oportunidades que se habrían perdido puede cubrir la mensualidad. *No es una garantía de ingresos.*',
    '',
    `👉 Suscribirte: ${paymentLink(plan)}`,
    '',
    'Después del pago Mercado Pago te lleva al registro de tu cuenta.',
    '',
    'Para la carga inicial tendrás 2 opciones:',
    '1) Dar acceso temporal a tu portal de la compañía mediante un formulario privado.',
    '2) Subir un ZIP con los PDF de tus pólizas de los últimos 12 meses.',
    '',
    'Cuando hayas terminado tu compra escribe *YA PAGUÉ*.'
  ].join('\n');
}
function compareReply() {
  return [
    '📊 *Básico vs Plus*',
    '',
    '*Básico · $499/mes*',
    'Ideal para organizar cartera, pagos AXA, cobros, renovaciones, contactos y WhatsApp.',
    '',
    '*Plus · $698/mes*',
    'Incluye todo lo anterior + cobranza avanzada, campañas, reportes, CSV, backups y análisis.',
    '',
    'En ambos te ayudamos con la carga inicial sin costo adicional.',
    '',
    'Si solo quieres empezar a tener control, el *Básico* suele ser suficiente. Si quieres trabajar más seguimiento y análisis, elige *Plus*.',
    '',
    `Básico: ${CARTERAPRO_LINKS.basicPay}`,
    `Plus: ${CARTERAPRO_LINKS.plusPay}`
  ].join('\n');
}
function faqReply() {
  return [
    '❓ *Preguntas frecuentes*',
    '',
    '*¿Tengo que capturar toda mi cartera?*',
    'No. Te ayudamos con la carga inicial sin costo adicional.',
    '',
    '*¿Puedo manejar varias compañías?*',
    'Sí. Puedes seleccionar varias aseguradoras y una principal.',
    '',
    '*¿Qué pasa después de pagar?*',
    'Mercado Pago te envía al registro de tu cuenta. Después puedes iniciar la carga inicial.',
    '',
    '*¿Tengo que dar mi contraseña del portal?*',
    'Solo si eliges ese método. Por seguridad, nunca te la pediremos por WhatsApp: se captura en un formulario privado y cifrado.',
    '',
    '*¿Puedo evitar compartir acceso?*',
    'Sí. Puedes subir un ZIP con los PDF de todas tus pólizas de los últimos 12 meses.',
    '',
    `Demo: ${CARTERAPRO_LINKS.demo}`,
    `Página: ${CARTERAPRO_LINKS.site}`
  ].join('\n');
}
function trustReply() {
  return [
    '🛡️ *¿Por qué CarteraPro?*',
    '',
    'No nació como un software genérico. Fue creado por un agente de seguros con 16 años de experiencia, después de identificar un problema repetido: clientes que se pierden por falta de seguimiento.',
    '',
    'La herramienta primero se utilizó para ordenar una operación real y hoy ya la usan otros clientes como apoyo en su cartera.',
    '',
    `Puedes probar la demo antes de contratar: ${CARTERAPRO_LINKS.demo}`
  ].join('\n');
}

function facebookAdReply(adContext={}) {
  return [
    '👋 *Hola, llegaste desde nuestro anuncio de CarteraPro.*',
    '',
    '*Si eres agente de seguros, esto es lo importante:*',
    '',
    '📄 Subes tus pólizas PDF y CarteraPro guarda los datos principales.',
    '💳 Actualizas el archivo de pagos AXA y el sistema cruza la cobranza.',
    '📋 Te muestra a quién cobrar, renovar o contactar.',
    '💬 Presionas WhatsApp y tienes el mensaje del cliente listo.',
    '',
    '🧪 *Prueba el flujo completo aquí:*',
    CARTERAPRO_LINKS.demo,
    '',
    '🎁 La carga inicial de tu cartera está incluida.',
    '🔹 Básico · $499 MXN/mes',
    '✨ Plus · $698 MXN/mes',
    '',
    'Después de probarla escribe *BASICO*, *PLUS* o dime qué parte de tu cartera quieres automatizar.'
  ].join('\n');
}

function onboardingChoice(plan='') {
  return [
    '🎉 *Gracias por contratar CarteraPro.*',
    plan ? `Plan indicado: *${planName(plan)}*.` : '',
    '',
    'La carga inicial está incluida sin costo adicional. Elige cómo quieres proporcionarnos tu cartera:',
    '',
    '1️⃣ *Acceso temporal al portal de tu compañía*',
    'Te genero un formulario privado para usuario y contraseña. *No envíes tu contraseña por WhatsApp.*',
    '',
    '2️⃣ *ZIP con tus pólizas*',
    'Sube un solo archivo ZIP con los PDF de todas tus pólizas de los últimos *12 meses*.',
    '',
    'Responde *1* o *2*.'
  ].filter(Boolean).join('\n');
}

export function isEmitterSpecificCommand(body='') {
  const x = cpNorm(body);
  return isOneOf(x,
    'EMITIR AGS','/EMITIRYAFILIACION','/AFILIACION',
    'HELP EMISOR','AYUDA EMISOR','MENU EMISOR','MENÚ EMISOR'
  );
}
export function isGeneralHelp(body='') {
  const x = cpNorm(body);
  return isOneOf(x,'HELP','AYUDA','MENU','MENÚ','COMANDOS');
}
export function combinedHelp() {
  return [
    '📌 *Opciones de este WhatsApp*',
    '',
    '*CarteraPro*',
    'Escribe DEMO, BASICO, PLUS, COMPARAR, COMO FUNCIONA o YA PAGUE.',
    '',
    '*Emisor administrativo* — solo números autorizados',
    'EMITIR AGS',
    '/EMITIRYAFILIACION',
    '/AFILIACION',
    '',
    'Si ya estás dentro de una emisión puedes usar CANCELAR.'
  ].join('\n');
}

async function ensureSession(phone) {
  let s = await getCarteraProSession(phone);
  if (!s) {
    s = { state:'menu', data:{}, createdAt:nowIso() };
    await setCarteraProSession(phone,s);
  }
  return s;
}
async function createOnboarding(phone, plan, method, baseUrl) {
  const t = token();
  const record = await saveCarteraProOnboarding({
    token:t, phone, plan, method, status:'created',
    createdAt:nowIso(), expiresAt:futureIso(7)
  });
  const root = String(baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/,'');
  return {
    record,
    url: `${root}/carterapro/onboarding/${method === 'portal' ? 'acceso' : 'zip'}/${t}`
  };
}
function sessionExpired(s) {
  if (!s?.updatedAt) return false;
  return Date.now() - new Date(s.updatedAt).getTime() > 24*60*60*1000;
}

export async function handleCarteraProMessage({ from, body, baseUrl, notifyAdmin = async () => {}, adContext = null }) {
  const phone = normalizePhone(from);
  const x = cpNorm(body);
  let s = await getCarteraProSession(phone);
  if (s && sessionExpired(s)) { await clearCarteraProSession(phone); s = null; }

  const firstSalesContact = !s;
  const demoIntent = includesAny(x,['DEMO','PRUEBA','PROBAR','CONOCER COMO FUNCIONA']);
  const purchaseIntent = includesAny(x,['YA PAGUE','YA PAGUÉ','YA COMPRE','YA COMPRÉ','CONTRATE','CONTRATÉ','ACTIVAR MI CUENTA','CARGAR MI CARTERA']);
  const fromFacebookAd = Boolean(adContext?.ctwaClid || adContext?.sourceId);

  // Si Kevin ya tomó la conversación desde el Inbox, el bot queda en silencio.
  // Solo CARTERAPRO / MENU CARTERAPRO / BOT reactivan explícitamente la automatización.
  if (s && humanHandoffActive(s) && !explicitBotResume(x)) {
    return { body:'', source:'carterapro_human_handoff', silent:true };
  }
  if (s && explicitBotResume(x) && humanHandoffActive(s)) {
    s={state:'menu',data:{...(s.data||{}),humanHandoffUntil:'',humanHandoffReason:'',handoffNoticeSentAt:''},createdAt:s.createdAt||nowIso()};
    await setCarteraProSession(phone,s);
  }

  if (humanIntent(x)) {
    s=await enterHumanHandoff(phone,s,'cliente_solicita_persona',true);
    await notifyAdmin([
      '🙋 *Prospecto solicita atención personal*',
      `WhatsApp: ${phone || '-'}`,
      `Mensaje: ${String(body||'').trim().slice(0,220) || '-'}`,
      '',
      'El bot quedó en pausa para este prospecto.'
    ].join('\n'));
    return {body:'Perfecto. Ya dejé tu conversación para atención personal. Kevin puede continuar contigo directamente por aquí. 👍',source:'carterapro_sales'};
  }

  if (includesAny(x,['MENSAJE DE PRUEBA DE CARTERAPRO','MENSAJE PRUEBA CARTERAPRO','PRUEBA DE CARTERAPRO'])) {
    return {body:[
      '✅ *Prueba de WhatsApp recibida.*',
      '',
      'El mensaje que acabas de ver es un ejemplo de lo que CarteraPro prepara desde los datos de una póliza.',
      '',
      'En uso real eliges el pendiente en *A quién escribir*, presionas WhatsApp y el recordatorio se abre listo para tu cliente.',
      '',
      `Demo completa: ${CARTERAPRO_LINKS.demo}`,
      'Escribe *COMO FUNCIONA* si quieres ver el flujo paso a paso.'
    ].join('\n'),source:'carterapro_sales'};
  }

  if (firstSalesContact && fromFacebookAd) {
    const created=nowIso();
    await recordCarteraProLead({
      id:`facebook_ad_${phone}_${Date.now()}`,
      phone,
      type:'facebook_ad',
      status:'new',
      source:'facebook_ads',
      ctwaClid:String(adContext?.ctwaClid||''),
      referralSourceId:String(adContext?.sourceId||''),
      referralHeadline:String(adContext?.headline||''),
      referralBody:String(adContext?.body||''),
      note:`Anuncio: ${String(adContext?.headline||'').slice(0,120)} · Mensaje: ${String(body||'').slice(0,180)}`,
      createdAt:created,
      createdAtMs:Date.now()
    }).catch(()=>{});
    await setCarteraProSession(phone,{state:'menu',data:{origin:'facebook_ads',ctwaClid:String(adContext?.ctwaClid||'')},createdAt:created});
    await notifyAdmin([
      '📣 *Nuevo prospecto desde Facebook Ads*',
      `WhatsApp: ${phone || '-'}`,
      adContext?.headline ? `Anuncio: ${String(adContext.headline).slice(0,140)}` : '',
      adContext?.sourceId ? `ID anuncio: ${adContext.sourceId}` : '',
      '',
      '✅ El bot ya le envió automáticamente la demo y la información principal.',
      '',
      `💬 Responder ahora: ${adminReplyLink(phone,'Hola, soy Kevin de CarteraPro. Vi que llegaste desde nuestro anuncio. Si tienes alguna duda sobre la demo o los planes, te apoyo por aquí.')}`
    ].filter(Boolean).join('\n'));
    return {body:facebookAdReply(adContext),source:'carterapro_sales'};
  }

  if (firstSalesContact && !demoIntent && !purchaseIntent) {
    await recordCarteraProLead({
      id:`prospect_${phone}`,
      phone,
      type:includesAny(x,['VENGO DE LA PAGINA','VENGO DEL SITIO','PAGINA DE CARTERAPRO']) ? 'web' : 'prospect',
      source:includesAny(x,['VENGO DE LA PAGINA','VENGO DEL SITIO','PAGINA DE CARTERAPRO']) ? 'website' : 'whatsapp',
      status:'new',
      note:String(body||'').trim().slice(0,300),
      createdAt:nowIso(),
      createdAtMs:Date.now()
    }).catch(()=>{});
    await notifyAdmin([
      '🆕 *Nuevo prospecto CarteraPro*',
      `WhatsApp: ${phone || '-'}`,
      `Primer mensaje: ${String(body||'').trim().slice(0,180) || '-'}`,
      '',
      'El bot ya está atendiendo automáticamente.',
      '',
      `💬 Responder ahora: ${adminReplyLink(phone,'Hola, soy Kevin de CarteraPro. Vi tu mensaje. El asistente puede ayudarte con la demo y los planes, pero si necesitas algo específico también te apoyo por aquí.')}`
    ].join('\n'));
  }

  // Palabras de salida / reinicio comercial
  if (isOneOf(x,'CARTERAPRO','INICIO CARTERAPRO','VENTAS','INFO CARTERAPRO')) {
    await setCarteraProSession(phone,{state:'menu',data:{},createdAt:nowIso()});
    return { body:intro(), source:'carterapro_sales' };
  }
  if (isOneOf(x,'SALIR CARTERAPRO','CERRAR CARTERAPRO')) {
    await clearCarteraProSession(phone);
    return { body:'Listo. Cerré el flujo de CarteraPro. Escribe HELP para ver los comandos disponibles.', source:'carterapro_sales' };
  }

  // Si está eligiendo plan después de YA PAGUÉ
  if (s?.state === 'onboarding_plan') {
    const plan = planFromText(x) || (x === '1' ? 'basic' : x === '2' ? 'plus' : '');
    if (!plan) return { body:'Indica *1 Básico* o *2 Plus* para continuar.', source:'carterapro_sales' };
    s.state='onboarding_method'; s.data={...(s.data||{}),plan};
    await setCarteraProSession(phone,s);
    return { body:onboardingChoice(plan), source:'carterapro_sales' };
  }

  if (s?.state === 'onboarding_method') {
    const method = x === '1' || includesAny(x,['PORTAL','CLAVE','USUARIO','CONTRASENA','CONTRASEÑA']) ? 'portal' :
      x === '2' || includesAny(x,['ZIP','PDF','POLIZAS','PÓLIZAS']) ? 'zip' : '';
    if (!method) return { body:'Responde *1* para acceso temporal al portal o *2* para subir ZIP de pólizas.', source:'carterapro_sales' };
    const plan = s.data?.plan || '';
    const created = await createOnboarding(phone,plan,method,baseUrl);
    await recordCarteraProLead({
      id:`onboarding_${created.record.token}`, phone, plan, type:'onboarding',
      status:'awaiting_documents', note:method, createdAt:nowIso(), createdAtMs:Date.now()
    });
    await notifyAdmin([
      '📥 *Carga inicial CarteraPro iniciada*',
      `WhatsApp: ${phone || '-'}`,
      `Plan: ${plan ? planName(plan) : '-'}`,
      `Método: ${method === 'portal' ? 'Acceso temporal al portal' : 'ZIP de pólizas'}`,
      '',
      'El cliente ya recibió su enlace privado de carga.',
      '',
      `💬 Responder ahora: ${adminReplyLink(phone,'Hola, vi que ya iniciaste la carga de tu cartera en CarteraPro. Si tienes alguna dificultad con el acceso o los archivos, escríbeme por aquí.')}`
    ].join('\n'));
    s.state='menu'; s.data={plan}; await setCarteraProSession(phone,s);
    if (method === 'portal') {
      return { body:[
        '🔐 *Acceso temporal al portal*',
        '',
        'Por seguridad *no envíes tu contraseña por WhatsApp*.',
        'Abre este formulario privado:',
        created.url,
        '',
        'Ahí puedes indicar compañía, portal, usuario y contraseña temporal. La información sensible se guarda cifrada.',
        '',
        'Recomendación: utiliza una contraseña temporal y cámbiala cuando terminemos la carga inicial.'
      ].join('\n'), source:'carterapro_sales', onboarding:created.record };
    }
    return { body:[
      '📦 *Carga de pólizas por ZIP*',
      '',
      'Prepara un ZIP con los PDF de tus pólizas de los últimos *12 meses* y súbelo aquí:',
      created.url,
      '',
      'Puedes incluir pólizas de varias compañías. No necesitas enviarlas una por una por WhatsApp.',
      '',
      'Cuando termine la carga te confirmaré el registro de los archivos.'
    ].join('\n'), source:'carterapro_sales', onboarding:created.record };
  }

  // Demo: si llega desde el CTA público "solicitar demo", manda link sin preguntar nada.
  if (includesAny(x,['DEMO','PRUEBA','PROBAR','CONOCER COMO FUNCIONA'])) {
    await recordCarteraProLead({ phone, type:'demo', status:'demo_sent', createdAt:nowIso(), createdAtMs:Date.now() });
    await ensureSession(phone);
    await notifyAdmin([
      '🧪 *Demo CarteraPro enviada*',
      `WhatsApp: ${phone || '-'}`,
      'El prospecto recibió automáticamente el enlace de prueba.',
      '',
      'Siguiente señal importante: elección de plan o YA PAGUÉ.',
      '',
      `💬 Responder ahora: ${adminReplyLink(phone,'Hola, vi que ya recibiste la demo de CarteraPro. Si quieres te ayudo a elegir entre Básico y Plus según el manejo de tu cartera.')}`
    ].join('\n'));
    return { body:demoReply(), source:'carterapro_sales' };
  }
  if (includesAny(x,['COMO FUNCIONA','CÓMO FUNCIONA','FUNCIONA','QUE HACE','QUÉ HACE'])) {
    await ensureSession(phone); return { body:howItWorks(), source:'carterapro_sales' };
  }
  if (includesAny(x,['COMPARAR','DIFERENCIA','PLANES','PRECIO','PRECIOS','COSTO','CUANTO CUESTA','CUÁNTO CUESTA'])) {
    await ensureSession(phone); return { body:compareReply(), source:'carterapro_sales' };
  }
  if (includesAny(x,['BASICO','BÁSICO','499'])) {
    s=await ensureSession(phone); s.data={...(s.data||{}),plan:'basic'}; await setCarteraProSession(phone,s);
    return { body:planReply('basic'), source:'carterapro_sales' };
  }
  if (includesAny(x,['PLUS','698'])) {
    s=await ensureSession(phone); s.data={...(s.data||{}),plan:'plus'}; await setCarteraProSession(phone,s);
    return { body:planReply('plus'), source:'carterapro_sales' };
  }
  if (includesAny(x,['FAQ','PREGUNTA','DUDAS','FRECUENTES'])) {
    await ensureSession(phone); return { body:faqReply(), source:'carterapro_sales' };
  }
  if (includesAny(x,['SEGURO','CONFIANZA','QUIEN LO HIZO','QUIÉN LO HIZO','EXPERIENCIA','16 ANOS','16 AÑOS'])) {
    await ensureSession(phone); return { body:trustReply(), source:'carterapro_sales' };
  }
  if (includesAny(x,['CARGA INICIAL','CARGAR CARTERA','MIGRAR CARTERA'])) {
    await ensureSession(phone); return { body:[
      '🎁 *La carga inicial de tu cartera está incluida sin costo adicional.*',
      '',
      'Después de contratar puedes elegir:',
      '1) Acceso temporal a tu portal mediante formulario privado.',
      '2) Subir un ZIP con los PDF de los últimos 12 meses.',
      '',
      'Escribe *YA PAGUÉ* para iniciar el proceso.'
    ].join('\n'), source:'carterapro_sales' };
  }
  if (includesAny(x,['YA PAGUE','YA PAGUÉ','YA COMPRE','YA COMPRÉ','CONTRATE','CONTRATÉ','ACTIVAR MI CUENTA','CARGAR MI CARTERA'])) {
    s=await ensureSession(phone);
    const plan = planFromText(x) || s.data?.plan || '';
    await recordCarteraProLead({
      id:`purchase_reported_${phone}_${Date.now()}`,
      phone,
      plan,
      type:'purchase_reported',
      status:'pending_verification',
      note:'El cliente reportó compra/pago por WhatsApp. Falta verificar el pago.',
      createdAt:nowIso(),
      createdAtMs:Date.now()
    }).catch(()=>{});
    await notifyAdmin([
      '💳 *Cliente reporta compra/pago CarteraPro*',
      `WhatsApp: ${phone || '-'}`,
      `Plan indicado: ${plan ? planName(plan) : 'Aún no indicado'}`,
      '',
      '⚠️ Pago reportado por el cliente; verifica Mercado Pago antes de activar si todavía no hay confirmación.',
      '',
      `💬 Responder ahora: ${adminReplyLink(phone,'Hola, recibí tu aviso de pago de CarteraPro. Estoy verificándolo y te confirmo la activación por aquí.')}`
    ].join('\n'));
    if (!plan) {
      s.state='onboarding_plan'; await setCarteraProSession(phone,s);
      return { body:'🎉 Perfecto. ¿Qué plan compraste?\n\n1️⃣ Básico · $499\n2️⃣ Plus · $698', source:'carterapro_sales' };
    }
    s.state='onboarding_method'; s.data={...(s.data||{}),plan}; await setCarteraProSession(phone,s);
    return { body:onboardingChoice(plan), source:'carterapro_sales' };
  }
  if (includesAny(x,['LOGIN','ENTRAR','PORTAL CARTERAPRO','MI CUENTA'])) {
    return { body:`🔐 Portal CarteraPro:\n${CARTERAPRO_LINKS.portal}`, source:'carterapro_sales' };
  }
  if (includesAny(x,['RECUPERAR','VALE LA PENA','PAGARSE SOLO','PAGARSE SOLA','INVERSION','INVERSIÓN'])) {
    return { body:[
      '💡 *Pon el costo en perspectiva*',
      '',
      'CarteraPro cuesta desde $499 al mes. Dependiendo del valor de tus comisiones, recuperar 1 o 2 cobros, renovaciones u oportunidades que se habrían perdido puede cubrir la mensualidad.',
      '',
      '*No es una garantía de ingresos:* depende de tu cartera, comisiones y seguimiento.',
      '',
      `Demo: ${CARTERAPRO_LINKS.demo}`
    ].join('\n'), source:'carterapro_sales' };
  }

  // Menú numérico solo si ya existe una sesión comercial.
  if (s) {
    if (x === '1') return { body:demoReply(), source:'carterapro_sales' };
    if (x === '2') return { body:howItWorks(), source:'carterapro_sales' };
    if (x === '3') { s.data={...(s.data||{}),plan:'basic'}; await setCarteraProSession(phone,s); return { body:planReply('basic'), source:'carterapro_sales' }; }
    if (x === '4') { s.data={...(s.data||{}),plan:'plus'}; await setCarteraProSession(phone,s); return { body:planReply('plus'), source:'carterapro_sales' }; }
    if (x === '5') return { body:compareReply(), source:'carterapro_sales' };
    if (x === '6') return { body:faqReply(), source:'carterapro_sales' };
    if (x === '7') {
      const plan=s.data?.plan||'';
      if (!plan) { s.state='onboarding_plan'; await setCarteraProSession(phone,s); return { body:'¿Qué plan compraste?\n1️⃣ Básico\n2️⃣ Plus',source:'carterapro_sales' }; }
      s.state='onboarding_method'; await setCarteraProSession(phone,s); return { body:onboardingChoice(plan),source:'carterapro_sales' };
    }
  }

  // Conversación libre: NO repetir el menú cada vez que el prospecto escribe.
  // En el primer contacto sí presentamos CarteraPro una vez. Después, una pregunta no
  // reconocida pasa a atención humana y el bot queda en silencio para no interrumpir a Kevin.
  if (firstSalesContact) {
    await setCarteraProSession(phone,{state:'menu',data:{introSentAt:nowIso()},createdAt:nowIso()});
    return { body:intro(), source:'carterapro_sales' };
  }

  if (simpleAck(x)) {
    return { body:'', source:'carterapro_ack', silent:true };
  }

  const alreadyNotified=Boolean(s?.data?.handoffNoticeSentAt);
  await enterHumanHandoff(phone,s,'pregunta_libre',true);
  await notifyAdmin([
    '💬 *Pregunta libre · responder personalmente*',
    `WhatsApp: ${phone || '-'}`,
    `Mensaje: ${String(body||'').trim().slice(0,260) || '-'}`,
    '',
    'El bot quedó pausado 12 h para no repetir respuestas automáticas.'
  ].join('\n'));
  return alreadyNotified
    ? {body:'',source:'carterapro_human_handoff',silent:true}
    : {body:'Gracias por escribirnos. Para no repetirte respuestas automáticas, dejé tu conversación para atención personal. Kevin puede responderte directamente por aquí. Si quieres volver al menú automático, escribe *CARTERAPRO*.',source:'carterapro_sales'};
}

export async function validateOnboardingToken(t, expectedMethod='') {
  const record = await getCarteraProOnboarding(t);
  if (!record) return { ok:false, reason:'Solicitud no encontrada.' };
  if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) return { ok:false, reason:'El enlace expiró.' };
  if (expectedMethod && record.method !== expectedMethod) return { ok:false, reason:'El enlace no corresponde a este método.' };
  return { ok:true, record };
}

function encryptionKey() {
  const secret = String(process.env.CARTERAPRO_ONBOARDING_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}
export function onboardingEncryptionReady() { return Boolean(encryptionKey()); }
export function encryptCredentials(payload = {}) {
  const key = encryptionKey();
  if (!key) throw new Error('Falta CARTERAPRO_ONBOARDING_SECRET en Render');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
  const plaintext = Buffer.from(JSON.stringify(payload),'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv,tag,encrypted].map(x=>x.toString('base64url')).join('.');
}
export function decryptCredentials(value='') {
  const key = encryptionKey();
  if (!key) throw new Error('Falta CARTERAPRO_ONBOARDING_SECRET');
  const [ivB,tagB,dataB]=String(value).split('.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivB,'base64url'));
  decipher.setAuthTag(Buffer.from(tagB,'base64url'));
  const out=Buffer.concat([decipher.update(Buffer.from(dataB,'base64url')),decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
