import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const DATA_DIR = path.join(process.cwd(), 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'carterapro_messages_backup.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'carterapro_conversations_backup.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'carterapro_sales_sessions.json');
const LEADS_FILE = path.join(DATA_DIR, 'carterapro_leads.json');
const ONBOARDING_FILE = path.join(DATA_DIR, 'carterapro_onboarding.json');

let firebaseDb = null;
let firebaseReady = false;
let firebaseDisabledReason = '';
let firebaseLastErrorAt = '';

function ensureData(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function readJson(file,fallback){ ensureData(); try{return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback}catch{return fallback} }
function writeJson(file,value){ ensureData(); fs.writeFileSync(file,JSON.stringify(value,null,2)); }
function nowIso(){ return new Date().toISOString(); }
function toIso(value){ if(!value)return''; const d=value instanceof Date?value:new Date(value); return Number.isNaN(d.getTime())?'':d.toISOString(); }
function errText(err){ return String(err?.message||err||'Error Firebase').slice(0,350); }
function noteError(err,action='Realtime Database'){ firebaseDisabledReason=`${action}: ${errText(err)}`; firebaseLastErrorAt=nowIso(); console.error(firebaseDisabledReason); }
function noteSuccess(){ firebaseDisabledReason=''; firebaseLastErrorAt=''; }

export function normalizePhone(value=''){ return String(value||'').replace(/^whatsapp:/i,'').replace(/\D/g,''); }
function safeKey(value=''){ return String(value||'').replace(/[.#$\[\]\/]/g,'_').slice(0,240); }

function initFirebase(){
  if(firebaseReady) return Boolean(firebaseDb);
  firebaseReady=true;
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON||process.env.FIREBASE_CONFIG_JSON||'';
  if(!raw){ firebaseDisabledReason='FIREBASE_SERVICE_ACCOUNT_JSON no configurado'; return false; }
  try{
    const parsed=JSON.parse(raw); if(parsed.private_key) parsed.private_key=parsed.private_key.replace(/\\n/g,'\n');
    const databaseURL=process.env.FIREBASE_DATABASE_URL||process.env.FIREBASE_REALTIME_DATABASE_URL||process.env.REALTIME_DATABASE_URL||(parsed.project_id?`https://${parsed.project_id}-default-rtdb.firebaseio.com`:'');
    if(!databaseURL) throw new Error('FIREBASE_DATABASE_URL no configurado');
    if(!admin.apps.length){
      const storageBucket=String(process.env.FIREBASE_STORAGE_BUCKET||'').trim();
      admin.initializeApp({credential:admin.credential.cert(parsed),databaseURL,...(storageBucket?{storageBucket}:{})});
    }
    firebaseDb=admin.database(); noteSuccess(); console.log(`CarteraPro RTDB conectado: ${databaseURL}`); return true;
  }catch(err){ firebaseDb=null; noteError(err,'Inicio RTDB'); return false; }
}
function useFirebase(){ return initFirebase()&&Boolean(firebaseDb); }

export function firebaseStatus(){ return {firebaseReady:Boolean(firebaseDb),firebaseBackend:firebaseDb?'realtime':'local',firebaseDisabledReason,firebaseLastErrorAt,dataBackend:firebaseDb?'realtime':'local'}; }
export function storageMode(){ return useFirebase()?'firebase_realtime_database':'local_backup'; }

function normalizeMessage(m={}){
  const createdAtMs=Number(m.createdAtMs||0)||Date.now();
  return {id:String(m.id||`${createdAtMs}_${Math.random().toString(16).slice(2)}`),phone:normalizePhone(m.phone),direction:String(m.direction||'inbound'),source:String(m.source||''),body:String(m.body||''),from:String(m.from||''),to:String(m.to||''),sid:String(m.sid||''),mediaUrl:String(m.mediaUrl||''),status:String(m.status||''),referral:m.referral&&typeof m.referral==='object'?m.referral:null,createdAt:toIso(m.createdAt)||new Date(createdAtMs).toISOString(),createdAtMs};
}
function normalizeConversation(c={}){
  const phone=normalizePhone(c.phone||c.id); const lastAtMs=Number(c.lastAtMs||c.updatedAtMs||Date.now());
  return {phone,area:'carterapro',firstAt:toIso(c.firstAt)||toIso(c.lastAt)||new Date(lastAtMs).toISOString(),firstAtMs:Number(c.firstAtMs||lastAtMs),lastAt:toIso(c.lastAt)||new Date(lastAtMs).toISOString(),lastAtMs,lastBody:String(c.lastBody||''),lastDirection:String(c.lastDirection||''),lastSource:String(c.lastSource||''),totalMessages:Number(c.totalMessages||0),inboundCount:Number(c.inboundCount||0),outboundCount:Number(c.outboundCount||0),unreadCount:Number(c.unreadCount||0),lastInboundAt:toIso(c.lastInboundAt)||null,lastInboundAtMs:Number(c.lastInboundAtMs||0),lastOutboundAt:toIso(c.lastOutboundAt)||null,lastOutboundAtMs:Number(c.lastOutboundAtMs||0),readAt:toIso(c.readAt)||null,referralCtwaClid:String(c.referralCtwaClid||''),referralSourceId:String(c.referralSourceId||''),referralSourceUrl:String(c.referralSourceUrl||''),referralHeadline:String(c.referralHeadline||''),referralBody:String(c.referralBody||''),origin:String(c.origin||''),updatedAt:toIso(c.updatedAt)||nowIso(),updatedAtMs:Number(c.updatedAtMs||lastAtMs)};
}
async function findUnsided(phone,{direction,body,createdAtMs}){
  if(!useFirebase())return null;
  try{
    const snap=await firebaseDb.ref(`chat_messages/${safeKey(phone)}`).orderByChild('createdAtMs').limitToLast(25).once('value');
    const target=String(body||'').trim();
    let best=null;
    for(const [id,v] of Object.entries(snap.val()||{})){
      if(v?.sid)continue; if(String(v?.direction||'')!==String(direction||''))continue; if(String(v?.body||'').trim()!==target)continue;
      const delta=Math.abs(Number(v?.createdAtMs||0)-Number(createdAtMs||0));
      if(delta<=45000&&(!best||delta<best.delta))best={id,...v,delta};
    }
    return best;
  }catch{return null;}
}
async function updateConversation(record){
  const phone=normalizePhone(record.phone); if(!phone)return null;
  if(useFirebase()){
    try{
      const ref=firebaseDb.ref(`conversations/${safeKey(phone)}`);
      const tx=await ref.transaction(raw=>{
        const prev=normalizeConversation({phone,...(raw||{})});
        const had=Number(prev.totalMessages||0)>0; const ms=Number(record.createdAtMs||Date.now()); const inbound=record.direction==='inbound'; const outbound=record.direction==='outbound';
        const latest=!had||ms>=Number(prev.lastAtMs||0); const earliest=!had||ms<Number(prev.firstAtMs||ms); const readMs=prev.readAt?new Date(prev.readAt).getTime():0;
        return normalizeConversation({...prev,phone,area:'carterapro',firstAt:earliest?record.createdAt:prev.firstAt,firstAtMs:earliest?ms:prev.firstAtMs,lastAt:latest?record.createdAt:prev.lastAt,lastAtMs:latest?ms:prev.lastAtMs,lastBody:latest?record.body:prev.lastBody,lastDirection:latest?record.direction:prev.lastDirection,lastSource:latest?record.source:prev.lastSource,totalMessages:Number(prev.totalMessages||0)+1,inboundCount:Number(prev.inboundCount||0)+(inbound?1:0),outboundCount:Number(prev.outboundCount||0)+(outbound?1:0),unreadCount:Number(prev.unreadCount||0)+(inbound&&(!readMs||ms>readMs)?1:0),lastInboundAt:inbound&&ms>=Number(prev.lastInboundAtMs||0)?record.createdAt:prev.lastInboundAt,lastInboundAtMs:inbound&&ms>=Number(prev.lastInboundAtMs||0)?ms:prev.lastInboundAtMs,lastOutboundAt:outbound&&ms>=Number(prev.lastOutboundAtMs||0)?record.createdAt:prev.lastOutboundAt,lastOutboundAtMs:outbound&&ms>=Number(prev.lastOutboundAtMs||0)?ms:prev.lastOutboundAtMs,referralCtwaClid:record.referral?.ctwaClid||prev.referralCtwaClid,referralSourceId:record.referral?.sourceId||prev.referralSourceId,referralSourceUrl:record.referral?.sourceUrl||prev.referralSourceUrl,referralHeadline:record.referral?.headline||prev.referralHeadline,referralBody:record.referral?.body||prev.referralBody,origin:record.referral?.ctwaClid||record.referral?.sourceId?'facebook_ads':prev.origin,updatedAt:nowIso(),updatedAtMs:Date.now()});
      },undefined,false);
      noteSuccess(); return normalizeConversation({phone,...(tx.snapshot.val()||{})});
    }catch(err){ noteError(err,'Actualizar conversación RTDB'); }
  }
  const all=readJson(CONVERSATIONS_FILE,{}); const prev=normalizeConversation(all[phone]||{phone}); const ms=record.createdAtMs; const inbound=record.direction==='inbound'; const latest=!prev.totalMessages||ms>=prev.lastAtMs;
  all[phone]=normalizeConversation({...prev,phone,lastAt:latest?record.createdAt:prev.lastAt,lastAtMs:latest?ms:prev.lastAtMs,lastBody:latest?record.body:prev.lastBody,lastDirection:latest?record.direction:prev.lastDirection,lastSource:latest?record.source:prev.lastSource,totalMessages:prev.totalMessages+1,inboundCount:prev.inboundCount+(inbound?1:0),outboundCount:prev.outboundCount+(inbound?0:1),unreadCount:prev.unreadCount+(inbound?1:0),updatedAt:nowIso(),updatedAtMs:Date.now()}); writeJson(CONVERSATIONS_FILE,all); return all[phone];
}

export async function recordMessage(input={}){
  const clean=normalizePhone(input.phone||input.from||input.to); if(!clean)return {...normalizeMessage(input),storedIn:'ignored_no_phone'};
  const sid=String(input.sid||'');
  if(sid&&useFirebase()){
    try{ const idx=await firebaseDb.ref(`message_sid_index/${safeKey(sid)}`).once('value'); if(idx.exists())return {phone:clean,sid,duplicate:true,storedIn:'firebase_realtime_database'}; }catch(err){noteError(err,'Consulta SID RTDB');}
  }
  const createdAtMs=Number(input.createdAtMs||0)||Date.now(); const createdAt=toIso(input.createdAt)||new Date(createdAtMs).toISOString();
  if(sid&&useFirebase()){
    const match=await findUnsided(clean,{direction:input.direction,body:input.body,createdAtMs});
    if(match){ try{ await firebaseDb.ref(`chat_messages/${safeKey(clean)}/${safeKey(match.id)}`).update({sid,status:String(input.status||match.status||'')}); await firebaseDb.ref(`message_sid_index/${safeKey(sid)}`).set(`${clean}|${match.id}`); return {...match,phone:clean,sid,duplicate:true,linkedSid:true,storedIn:'firebase_realtime_database'}; }catch{} }
  }
  const id=sid?`sid_${sid}`:`msg_${createdAtMs}_${Math.random().toString(16).slice(2,10)}`;
  const record=normalizeMessage({...input,id,phone:clean,createdAt,createdAtMs});
  let storedIn='local_backup';
  if(useFirebase()){
    try{ await firebaseDb.ref(`chat_messages/${safeKey(clean)}/${safeKey(id)}`).set(record); if(sid)await firebaseDb.ref(`message_sid_index/${safeKey(sid)}`).set(`${clean}|${id}`); noteSuccess(); storedIn='firebase_realtime_database'; }catch(err){noteError(err,'Guardar mensaje RTDB'); record.firebaseSaveError=errText(err);}
  }
  if(storedIn!=='firebase_realtime_database'){ const arr=readJson(MESSAGES_FILE,[]); if(!arr.some(x=>(sid&&x.sid===sid)||x.id===id)){arr.push(record);writeJson(MESSAGES_FILE,arr.slice(-15000));} }
  await updateConversation(record).catch(()=>{}); return {...record,storedIn};
}

export async function loadMessages({phone='',limit=200}={}){
  const clean=normalizePhone(phone); const max=Math.max(1,Math.min(Number(limit||200),5000)); let remote=[];
  if(useFirebase()){
    try{
      if(clean){ const snap=await firebaseDb.ref(`chat_messages/${safeKey(clean)}`).orderByChild('createdAtMs').limitToLast(max).once('value'); remote=Object.entries(snap.val()||{}).map(([id,v])=>normalizeMessage({id,phone:clean,...v})); }
      else { const snap=await firebaseDb.ref('chat_messages').once('value'); for(const [p,msgs] of Object.entries(snap.val()||{}))for(const [id,v] of Object.entries(msgs||{}))remote.push(normalizeMessage({id,phone:p,...v})); }
      noteSuccess();
    }catch(err){noteError(err,'Leer mensajes RTDB');}
  }
  const local=readJson(MESSAGES_FILE,[]).map(normalizeMessage).filter(m=>!clean||m.phone===clean); const map=new Map();
  for(const m of [...remote,...local]){ const k=m.sid||m.id; if(!map.has(k))map.set(k,m); }
  return [...map.values()].sort((a,b)=>b.createdAtMs-a.createdAtMs).slice(0,max);
}
export async function loadConversationIndex({limit=2000}={}){
  const max=Math.max(1,Math.min(Number(limit||2000),5000));
  if(useFirebase())try{ const snap=await firebaseDb.ref('conversations').once('value'); return Object.entries(snap.val()||{}).map(([phone,v])=>normalizeConversation({phone,...v})).filter(x=>x.phone).sort((a,b)=>b.lastAtMs-a.lastAtMs).slice(0,max); }catch(err){noteError(err,'Leer conversaciones RTDB');}
  return Object.values(readJson(CONVERSATIONS_FILE,{})).map(normalizeConversation).sort((a,b)=>b.lastAtMs-a.lastAtMs).slice(0,max);
}
export async function markConversationRead(phone){ const clean=normalizePhone(phone); if(!clean)return null; const patch={unreadCount:0,readAt:nowIso(),updatedAt:nowIso(),updatedAtMs:Date.now(),area:'carterapro'}; if(useFirebase())try{await firebaseDb.ref(`conversations/${safeKey(clean)}`).update(patch);const s=await firebaseDb.ref(`conversations/${safeKey(clean)}`).once('value');return normalizeConversation({phone:clean,...s.val()});}catch(err){noteError(err,'Marcar leído RTDB');} const all=readJson(CONVERSATIONS_FILE,{});all[clean]=normalizeConversation({...all[clean],phone:clean,...patch});writeJson(CONVERSATIONS_FILE,all);return all[clean]; }
export async function rebuildConversationIndex({limit=5000}={}){ const messages=(await loadMessages({limit})).slice().sort((a,b)=>a.createdAtMs-b.createdAtMs); const map=new Map(); for(const m of messages){const p=m.phone;if(!p)continue;const prev=map.get(p)||normalizeConversation({phone:p,firstAt:m.createdAt,firstAtMs:m.createdAtMs,lastAt:m.createdAt,lastAtMs:m.createdAtMs,totalMessages:0,unreadCount:0});const inbound=m.direction==='inbound';map.set(p,normalizeConversation({...prev,phone:p,firstAt:prev.totalMessages?prev.firstAt:m.createdAt,firstAtMs:prev.totalMessages?prev.firstAtMs:m.createdAtMs,lastAt:m.createdAt,lastAtMs:m.createdAtMs,lastBody:m.body,lastDirection:m.direction,lastSource:m.source,totalMessages:prev.totalMessages+1,inboundCount:prev.inboundCount+(inbound?1:0),outboundCount:prev.outboundCount+(inbound?0:1),unreadCount:prev.unreadCount+(inbound?1:0),lastInboundAt:inbound?m.createdAt:prev.lastInboundAt,lastInboundAtMs:inbound?m.createdAtMs:prev.lastInboundAtMs,lastOutboundAt:inbound?prev.lastOutboundAt:m.createdAt,lastOutboundAtMs:inbound?prev.lastOutboundAtMs:m.createdAtMs,origin:m.referral?.ctwaClid||m.referral?.sourceId?'facebook_ads':prev.origin,referralHeadline:m.referral?.headline||prev.referralHeadline,referralSourceId:m.referral?.sourceId||prev.referralSourceId,updatedAt:nowIso(),updatedAtMs:Date.now()}));}
  if(useFirebase())for(const [p,c] of map)await firebaseDb.ref(`conversations/${safeKey(p)}`).set(c); const local={};for(const [p,c] of map)local[p]=c;writeJson(CONVERSATIONS_FILE,local);return [...map.values()].sort((a,b)=>b.lastAtMs-a.lastAtMs); }

function normalizeSession(v={}){ return {...v,updatedAt:nowIso()}; }
export async function getCarteraProSession(phone){const p=normalizePhone(phone);if(!p)return null;if(useFirebase())try{const s=await firebaseDb.ref(`carterapro_sales_sessions/${safeKey(p)}`).once('value');return s.val()||null}catch{}return readJson(SESSIONS_FILE,{})[p]||null;}
export async function setCarteraProSession(phone,value={}){const p=normalizePhone(phone);const v=normalizeSession(value);if(useFirebase())try{await firebaseDb.ref(`carterapro_sales_sessions/${safeKey(p)}`).set(v);return v}catch(err){noteError(err,'Guardar sesión CarteraPro');}const all=readJson(SESSIONS_FILE,{});all[p]=v;writeJson(SESSIONS_FILE,all);return v;}
export async function clearCarteraProSession(phone){const p=normalizePhone(phone);if(useFirebase())try{await firebaseDb.ref(`carterapro_sales_sessions/${safeKey(p)}`).remove();return}catch{}const all=readJson(SESSIONS_FILE,{});delete all[p];writeJson(SESSIONS_FILE,all);}

function normalizeLead(v={}){const ms=Number(v.createdAtMs||0)||new Date(v.createdAt||Date.now()).getTime();return {...v,id:String(v.id||`lead_${ms}`),phone:normalizePhone(v.phone),createdAt:toIso(v.createdAt)||new Date(ms).toISOString(),createdAtMs:ms};}
export async function recordCarteraProLead(v={}){const x=normalizeLead(v);if(useFirebase())try{await firebaseDb.ref(`carterapro_leads/${safeKey(x.id)}`).set(x);return {...x,storedIn:'firebase_realtime_database'}}catch(err){noteError(err,'Guardar lead RTDB');}const arr=readJson(LEADS_FILE,[]).filter(y=>y.id!==x.id);arr.push(x);writeJson(LEADS_FILE,arr.slice(-5000));return {...x,storedIn:'local_backup'};}
export async function loadCarteraProLeads({limit=1000}={}){let arr=[];if(useFirebase())try{const s=await firebaseDb.ref('carterapro_leads').once('value');arr=Object.entries(s.val()||{}).map(([id,v])=>normalizeLead({id,...v}));}catch(err){noteError(err,'Leer leads RTDB');}arr=[...arr,...readJson(LEADS_FILE,[]).map(normalizeLead)];const m=new Map();for(const x of arr)m.set(x.id,x);return [...m.values()].sort((a,b)=>b.createdAtMs-a.createdAtMs).slice(0,Math.min(Number(limit||1000),5000));}

function normalizeOnboarding(v={}){const ms=Number(v.createdAtMs||0)||new Date(v.createdAt||Date.now()).getTime();return {...v,token:String(v.token||''),phone:normalizePhone(v.phone),createdAt:toIso(v.createdAt)||new Date(ms).toISOString(),createdAtMs:ms,updatedAt:nowIso()};}
export async function getCarteraProOnboarding(token){const t=safeKey(token);if(!t)return null;if(useFirebase())try{const s=await firebaseDb.ref(`carterapro_onboarding/${t}`).once('value');return s.val()?normalizeOnboarding(s.val()):null}catch{}return readJson(ONBOARDING_FILE,[]).find(x=>x.token===token)||null;}
export async function saveCarteraProOnboarding(v={}){const existing=v.token?await getCarteraProOnboarding(v.token):null;const x=normalizeOnboarding({...existing,...v,createdAt:existing?.createdAt||v.createdAt||nowIso(),createdAtMs:existing?.createdAtMs||v.createdAtMs||Date.now()});if(!x.token)throw new Error('Token onboarding requerido');if(useFirebase())try{await firebaseDb.ref(`carterapro_onboarding/${safeKey(x.token)}`).set(x);return {...x,storedIn:'firebase_realtime_database'}}catch(err){noteError(err,'Guardar onboarding RTDB');}const arr=readJson(ONBOARDING_FILE,[]).filter(y=>y.token!==x.token);arr.push(x);writeJson(ONBOARDING_FILE,arr.slice(-3000));return {...x,storedIn:'local_backup'};}
export async function loadCarteraProOnboarding({limit=1000}={}){let arr=[];if(useFirebase())try{const s=await firebaseDb.ref('carterapro_onboarding').once('value');arr=Object.values(s.val()||{}).map(normalizeOnboarding);}catch(err){noteError(err,'Leer onboarding RTDB');}arr=[...arr,...readJson(ONBOARDING_FILE,[]).map(normalizeOnboarding)];const m=new Map();for(const x of arr)m.set(x.token,x);return [...m.values()].sort((a,b)=>b.createdAtMs-a.createdAtMs).slice(0,Math.min(Number(limit||1000),5000));}

export function getFirebaseStorageBucketName(){return String(process.env.FIREBASE_STORAGE_BUCKET||'').trim();}
export async function storeCarteraProUpload({token,localPath,filename,contentType='application/octet-stream',size=0}){const bucketName=getFirebaseStorageBucketName();if(bucketName&&useFirebase())try{const safe=(filename||'archivo').replace(/[^a-zA-Z0-9._-]+/g,'_');const storagePath=`carterapro_uploads/${safeKey(token)}/${Date.now()}_${safe}`;const bucket=admin.storage().bucket(bucketName);await bucket.upload(localPath,{destination:storagePath,metadata:{contentType}});try{fs.unlinkSync(localPath)}catch{}return {storedIn:'firebase_storage',storagePath,filename,size,contentType};}catch(err){console.error('Firebase Storage falló, se conserva archivo local:',err?.message||err);}return {storedIn:'render_local_ephemeral',localPath,filename,size,contentType};}
