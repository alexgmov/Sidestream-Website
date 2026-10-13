import type { IncomingMessage, ServerResponse } from "node:http";
import { readCustomerAdminJson } from "./_lib/customer-admin.js";
import { resolveLicenseEnvironment } from "./_lib/license-environment.js";
import { getPostgresPool } from "./_lib/postgres.js";
import { consumeRateLimit } from "./_lib/rate-limit.js";
import { isLikelyScanner } from "./_lib/installer-referral.js";
import { UGC_CREATORS } from "./_lib/ugc-report.js";
export function parseUgcArrival(body: unknown) {
  if (!body || typeof body!=="object" || Array.isArray(body)) throw new Error("invalid_arrival");
  const b=body as Record<string,unknown>;
  if (Object.keys(b).sort().join(',')!=="campaign,eventId,medium,source" || typeof b.eventId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.eventId) || !UGC_CREATORS.some(c=>c.campaign===b.campaign)) throw new Error("invalid_arrival");
  const placement=b.source==='instagram' && b.medium==='social' ? 'bio' : b.source==='manychat-instagram' && b.medium==='dm' ? 'manychat' : null;
  if (!placement) throw new Error("invalid_arrival");
  return {eventId:b.eventId,campaign:String(b.campaign),placement};
}
export function createUgcVisitHandler(overrides: Partial<{record:(request:IncomingMessage,arrival:ReturnType<typeof parseUgcArrival>)=>Promise<void>}>={}) {
  const record=overrides.record || (async (request,arrival)=>{
    if (isLikelyScanner(request)) return;
    const env=resolveLicenseEnvironment({serverEnv:process.env});
    if (!env) throw new Error("tracking_unavailable");
    const pool=getPostgresPool({connectionString:env.database.connectionString,environmentVariable:env.database.environmentVariable,pooled:true});
    const ip=String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0,128);
    const limit=await consumeRateLimit({scope:`ugc-arrival-${env.namespace}`,dimensions:[{name:'ip',value:ip,limit:120}],windowSeconds:60,runner:pool});
    if (!limit.allowed) return;
    await pool.query('insert into public.sidestream_ugc_link_arrivals(license_namespace,event_id,campaign,placement) values($1,$2,$3,$4) on conflict do nothing',[env.namespace,arrival.eventId,arrival.campaign,arrival.placement]);
  });
  return async (request:IncomingMessage,response:ServerResponse)=>{
    response.setHeader('Cache-Control','no-store'); response.setHeader('X-Content-Type-Options','nosniff');
    const end=(status:number)=>{response.statusCode=status;response.end();};
    if (request.method!=='POST') {response.setHeader('Allow','POST');return end(405);}
    const origin=request.headers.origin;
    // Match the existing public site, never permit arbitrary browser origins.
    if (origin!=='https://sidestream.tv' && origin!=='https://www.sidestream.tv') return end(403);
    if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) return end(415);
    let arrival;
    try {arrival=parseUgcArrival(await readCustomerAdminJson(request));} catch {return end(400);}
    try {await record(request,arrival);} catch {console.warn('UGC arrival tracking unavailable');}
    return end(204);
  };
}
export default createUgcVisitHandler();
