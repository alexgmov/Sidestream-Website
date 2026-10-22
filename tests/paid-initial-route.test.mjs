import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import test from 'node:test';
import {loadInjectedHandler} from './helpers/handler-loader.mjs';

async function fixture({enabled=true,namespace='production'}={}) {
  const calls=[];
  const sendJson=(r,status,body)=>{r.status=status;r.body=body;};
  const handler=await loadInjectedHandler(new URL('../api/paid-acquisition/initial-authorization.ts',import.meta.url),{
    '../_lib/account.js':{hashPrivateIdentifier:()=> 'device-hash',methodNotAllowed:r=>sendJson(r,405,{}),
      resolveRequestLicenseEnvironment:()=>({namespace}),sendJson},
    '../_lib/postgres.js':{withPostgresTransaction:async fn=>fn({transactionFixture:true})},
    '../_lib/rate-limit.js':{applyRateLimitHeaders:()=>{},consumeRateLimit:async()=>({allowed:true})},
    '../_lib/paid-initial-authorization.js':{initialHash:()=> 'credential-hash',
      loadInitialAuthority:()=>{if(!enabled)throw Error('disabled');return {fixture:true};},
      issueInitialAuthorization:async(client,body,authority,credential)=>{calls.push({client,body,authority,credential});return {payload:'signed',signature:'proof'};}}
  });
  async function request(body,{method='POST',url='/api/paid-acquisition/initial-authorization',type='application/json'}={}) {
    const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
    req.method=method;req.url=url;req.headers={'content-type':type};
    const response={headers:{},setHeader(name,value){this.headers[name]=value;}};
    await handler(req,response);return response;
  }
  return {request,calls};
}
test('initial route stays disabled or namespace-isolated before reading a credential',async()=>{
  for(const settings of [{enabled:false},{namespace:'test'}]) {
    const f=await fixture(settings);assert.equal((await f.request('malformed')).status,503);assert.equal(f.calls.length,0);
  }
});
test('initial route accepts only bounded body-only credentials and exact request fields',async()=>{
  const f=await fixture(),body={licenseToken:'credential-canary',deviceId:'device-canary',initial:{fixture:true}};
  const response=await f.request(body);assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');
  assert.deepEqual(f.calls[0].credential,{tokenHash:'credential-hash',deviceIdHash:'device-hash'});
  assert.doesNotMatch(JSON.stringify(f.calls),/credential-canary|device-canary/);
  for(const [payload,options,status] of [
    [body,{method:'GET'},405],[body,{url:'/api/paid-acquisition/initial-authorization?identity=canary'},400],
    [body,{type:'text/plain'},400],[{...body,account:'chosen-account'},{},400],
    [{...body,licenseToken:''},{},400],['x'.repeat(96*1024+1),{},413]
  ])assert.equal((await f.request(payload,options)).status,status);
  assert.equal(f.calls.length,1);
});
