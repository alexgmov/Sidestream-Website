import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
const channels = await loadInjectedModule(new URL('../api/_lib/channel-report.ts', import.meta.url), { './postgres.js': {withPostgresTransaction:async()=>{throw Error('unexpected database')}} });
const reportModule = await loadInjectedModule(new URL('../api/_lib/ugc-report.ts', import.meta.url), { './postgres.js': {withPostgresTransaction:async()=>{throw Error('unexpected database')}}, './channel-report.js': channels });
const admin = await loadInjectedModule(new URL('../api/_lib/customer-admin.ts', import.meta.url), {});
const route = await loadInjectedModule(new URL('../api/internal/ugc-report.ts', import.meta.url), { '../_lib/customer-admin.js': admin, '../_lib/channel-report.js': channels, '../_lib/ugc-report.js': reportModule });
const visit = await loadInjectedModule(new URL('../api/ugc-visit.ts', import.meta.url), { './_lib/customer-admin.js': admin, './_lib/license-environment.js': {resolveLicenseEnvironment:()=>null}, './_lib/postgres.js': {getPostgresPool:()=>null}, './_lib/rate-limit.js': {consumeRateLimit:async()=>({allowed:false})}, './_lib/installer-referral.js': {isLikelyScanner:()=>false}, './_lib/ugc-report.js': reportModule });
const input = { licenseNamespace: 'production', from: '2026-08-01T00:00:00.000Z', through: '2026-08-03T12:00:00.000Z', asOf: '2026-08-04T00:00:00.000Z' };
const row = { campaign:'ugc-instagram-01', placement:'bio', day:'2026-08-02', visits:'2' };
test('first visits and new arrivals are separate, zero-filled; money preserves currency and refunds', () => {
  const report = reportModule.buildUgcReport(input, [row], [{...row,placement:'manychat',visits:'5'}], [{...row,currency:'usd',purchases:'1',gross:'1999',refunds:'999',disputes:'0',net:'1000'}, {...row,currency:'eur',purchases:'1',gross:'1000',refunds:'0',disputes:'0',net:'1000'}], '2026-08-02T12:00:00.000Z');
  assert.equal(report.creators.length,2);
  assert.equal(report.creators[0].daily.length,3);
  assert.equal(report.creators[0].daily[0].firstVisits.total,0);
  assert.equal(report.creators[0].firstVisits.bio,2);
  assert.equal(report.creators[0].arrivals.manychat,5);
  assert.equal(report.creators[0].money.length,2);
  assert.equal(report.creators[1].money.length,0);
  for(const bad of [{...row,visits:'9007199254740992'},{...row,campaign:'bio'},{...row,placement:'guess'}]) assert.throws(()=>reportModule.buildUgcReport(input,[bad],[],[],null));
});
async function call(handler, {headers={}, method='POST', body=input}={}) {
  const req={method,headers,rawHeaders:Object.entries(headers).flat(),body};
  const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(body){this.body=body;}};
  await handler(req,res);return res;
}
test('report is authenticated POST-only, no-store, browser-forbidden and redacts internal failures', async()=>{
  const secret='ugc-admin-secret-long-enough';
  const handler=route.createUgcReportHandler({getAdminSecret:()=>secret,queryReport:async body=>reportModule.buildUgcReport(channels.parseChannelReportRequest(body),[],[],[],null)});
  assert.equal((await call(handler)).statusCode,401);
  assert.equal((await call(handler,{method:'GET'})).statusCode,405);
  assert.equal((await call(handler,{headers:{authorization:`Bearer ${secret}`,origin:'https://sidestream.tv'}})).statusCode,403);
  const success=await call(handler,{headers:{authorization:`Bearer ${secret}`}});
  assert.equal(success.statusCode,200);assert.match(success.headers['cache-control'],/no-store/);
  assert.equal((await call(handler,{headers:{authorization:`Bearer ${secret}`},body:{...input,profileId:'private'}})).statusCode,400);
  const failure=await call(route.createUgcReportHandler({getAdminSecret:()=>secret,queryReport:async()=>{throw Error('private database detail');}}),{headers:{authorization:`Bearer ${secret}`}});
  assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/private database detail/);
});
const arrival={eventId:'4ec9d7f7-3b7b-4bf1-9334-e68191848b97',campaign:'ugc-instagram-02',source:'instagram',medium:'social'};
test('arrival collector accepts only exact registered placements and public site origins', async()=>{
  const recorded=[];
  const handler=visit.createUgcVisitHandler({record:async(_,data)=>recorded.push(data)});
  const headers={origin:'https://sidestream.tv','content-type':'application/json'};
  assert.equal((await call(handler,{headers,body:arrival})).statusCode,204);
  assert.deepEqual(recorded,[{eventId:arrival.eventId,campaign:arrival.campaign,placement:'bio'}]);
  assert.equal((await call(handler,{headers:{...headers,origin:'https://attacker.example'},body:arrival})).statusCode,403);
  for(const changed of [{licenseNamespace:'test'}, {email:'private'}, {campaign:'sidestream.tv'}, {source:'manychat-instagram'}, {eventId:'not-a-uuid'}]) assert.equal((await call(handler,{headers,body:{...arrival,...changed}})).statusCode,400);
  assert.equal((await call(handler,{headers,body:{...arrival,source:'manychat-instagram',medium:'dm'}})).statusCode,204);
  assert.equal(recorded.at(-1).placement,'manychat');
  assert.equal((await call(handler,{method:'GET'})).statusCode,405);
  assert.equal((await call(handler,{headers:{origin:headers.origin},body:arrival})).statusCode,415);
});
test('page counter records one event after visibility, ignores unknown and duplicate tags, and does not use cookies',async()=>{
  const script=await readFile(new URL('../public/ugc-arrival.js',import.meta.url),'utf8');
  async function run(query,visible=true){
    const calls=[],listeners=new Map();
    const document={visibilityState:visible?'visible':'hidden',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
    vm.runInNewContext(script,{URLSearchParams,document,window:{location:{search:query},crypto:{randomUUID:()=>arrival.eventId}},fetch:async(...args)=>calls.push(args)});
    return {calls,show(){document.visibilityState='visible';listeners.get('visibilitychange')?.();}};
  }
  const query='?utm_source=instagram&utm_medium=social&utm_campaign=ugc-instagram-02';
  const runResult=await run(query,false);assert.equal(runResult.calls.length,0);runResult.show();runResult.show();assert.equal(runResult.calls.length,1);
  assert.equal(runResult.calls[0][1].credentials,'omit');assert.equal(JSON.parse(runResult.calls[0][1].body).eventId,arrival.eventId);
  assert.equal((await run(query+'&utm_source=other')).calls.length,0);
  assert.equal((await run('?utm_source=instagram&utm_medium=social')).calls.length,0);
});
