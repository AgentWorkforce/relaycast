// Review regressions: actual HTTP admission, native Node transactions and workerd D1 batches.
// Actual HTTP engine + native Node transactions and local workerd D1 batch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createNodeRuntime } from '../dist/adapters/node/index.js';
import { createEngine, schema } from '../dist/index.js';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import Database from 'better-sqlite3';
import { sweepPendingA2aEgress, cleanupA2aEgress } from '../dist/engine/a2aEgress.js';

import { sweepPendingEvents } from '../dist/engine/eventQueue.js';
import { deliverEvent } from '../dist/engine/eventDelivery.js';
import { listWorkspaceEvents } from '../dist/engine/workspaceEvents.js';
import { sweepDueNodeDeliveries } from '../dist/routes/deliveryRouting.js';

const results = [];
const hash = x => createHash('sha256').update(x).digest('hex');
// These fixtures drive recovery explicitly. Keep earlier Node runtimes from
// asynchronously sending their pending rows into a later case's fetch stub.
// Production's automatic recovery/non-overlap has its own a2a-recovery unit test.
function createManualRecoveryRuntime(options) {
  const originalSetInterval = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args); timers.push(timer); return timer;
  };
  try { return createNodeRuntime(options); }
  finally { globalThis.setInterval = originalSetInterval; for (const timer of timers) clearInterval(timer); }
}
const runtimes = [':memory:', `/tmp/finn-capacity-${randomUUID()}.sqlite`].map(dbPath => createManualRecoveryRuntime({
  dbPath, baseUrl:'http://localhost:0',fileDir:`/tmp/finn-capacity-files-${randomUUID()}`,
  config:{environment:'test'},presence:{sweepIntervalMs:0},eventQueue:{pollIntervalMs:0},
}));
for(const r of runtimes){r.webhookQueue.stop();r.presence.stop();}
const mf = new Miniflare({workers:[{modules:true,script:'export default { fetch() { return new Response("fixture") } }', compatibilityDate:'2026-05-11', d1Databases:['DB','UPGRADE']}]});
const originalFetch = globalThis.fetch;
try {
 const d1=await mf.getD1Database('DB');
 const d1Metrics=[];
 const measuredD1=new Proxy(d1,{get(target,key){if(key==='batch')return async statements=>{const result=await target.batch(statements);d1Metrics.push(...result.map(row=>row.meta));return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const sqlite=runtimes[0].handle.sqlite;
 const shadow=new Set(sqlite.prepare('PRAGMA table_list').all().filter(r=>r.type==='shadow').map(r=>r.name));
 for(const row of sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all()){
  if(!shadow.has(row.name))await d1.prepare(row.sql).run();
 }
 if (!process.env.REVIEW_SKIP_UPGRADE) {
  const upgradeD1=await mf.getD1Database('UPGRADE');
  const upgradeSqlite=new Database(':memory:');
  upgradeSqlite.pragma('foreign_keys = ON');
  try {
    const baseline=sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all()
      .filter(row=>!shadow.has(row.name)&&row.name!=='a2a_egress_context'&&!row.name.startsWith('idx_a2a_egress_context_'));
    for(const row of baseline){upgradeSqlite.exec(row.sql);await upgradeD1.prepare(row.sql).run();}
    const migration=readFileSync(new URL('../src/db/migrations/0058_a2a_egress_context.sql',import.meta.url),'utf8');
    for(const [adapter,exec,query] of [
      ['node',async sql=>upgradeSqlite.exec(sql),async sql=>upgradeSqlite.prepare(sql).all()],
      ['workerd-d1',async sql=>upgradeD1.prepare(sql).run(),async sql=>(await upgradeD1.prepare(sql).all()).results],
    ]){
      const seed=[
        "INSERT INTO workspaces(id,name,api_key_hash) VALUES('upgrade','upgrade','upgrade')",
        "INSERT INTO agents(id,workspace_id,name,token_hash) VALUES('sender','upgrade','sender','sender')",
        "INSERT INTO channels(id,workspace_id,name) VALUES('channel','upgrade','channel')",
        "INSERT INTO messages(id,workspace_id,agent_id,channel_id,body) VALUES('message','upgrade','sender','channel','preserved')",
        "INSERT INTO a2a_egress(id,workspace_id,message_id,target_id,external_url,fingerprint,status) VALUES('intent','upgrade','message','target','https://example.com/a2a','original','sent')",
      ];
      for(const statement of seed)await exec(statement);
      const before=await query('SELECT * FROM a2a_egress');
      for(let repeat=0;repeat<2;repeat++)for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await exec(statement);
      assert.deepEqual(await query('SELECT * FROM a2a_egress'),before);
      assert.equal((await query('PRAGMA table_info(a2a_egress_context)')).length,3);
      await exec("INSERT INTO a2a_egress_context(id,message_id,response) VALUES('intent','message','{}')");
      await exec("DELETE FROM messages WHERE id='message'");
      assert.equal((await query('SELECT * FROM a2a_egress_context')).length,0);
      assert.equal((await query('SELECT * FROM a2a_egress')).length,1,'source deletion keeps egress tombstone');
      await exec(seed[3]);await exec("INSERT INTO a2a_egress_context(id,message_id,response) VALUES('intent','message','{}')");
      await exec("DELETE FROM a2a_egress WHERE id='intent'");
      assert.equal((await query('SELECT * FROM a2a_egress_context')).length,0);
      assert.deepEqual(await query('PRAGMA foreign_key_check'),[]);
      results.push({adapter,test:'0058 applies twice without changing accepted identity; source/egress cleanup cascades response context'});
    }
  } finally {upgradeSqlite.close();}
 }
 for(const adapter of ['node-memory','node-file','workerd-d1'].filter(a=>!process.env.REVIEW_ADAPTER||a===process.env.REVIEW_ADAPTER)){
  const runtime=runtimes[adapter==='node-file'?1:0];
  const db=adapter==='workerd-d1'?drizzle(measuredD1,{schema}):runtime.deps.db;
  const run=async(sql,...args)=>adapter==='workerd-d1'?d1.prepare(sql).bind(...args).run():runtime.handle.sqlite.prepare(sql).run(...args);
  const rows=async(sql,...args)=>adapter==='workerd-d1'?(await d1.prepare(sql).bind(...args).all()).results:runtime.handle.sqlite.prepare(sql).all(...args);
  const scalar=async(sql,...args)=>Object.values((await rows(sql,...args))[0])[0];
  const policies=new Map();let resolves=0;let resolverDown=false;const background=[];
  const kvMap=new Map();
  const deps={...runtime.deps,db,
    config:{environment:'test',relayfileInboundSecret:'fixture-only',workspaceDelivery:{resolve:async workspace=>{await Promise.resolve();resolves++;if(resolverDown)throw Error('injected policy resolver unavailable');assert.equal(workspace.plan,'enterprise');return policies.get(workspace.id);}}},
    kv:{get:async k=>kvMap.get(k)??null,put:async(k,v)=>{kvMap.set(k,v);},delete:async k=>{kvMap.delete(k);}},
    rateLimiter:{check:async()=>({allowed:true,remaining:10000,resetAt:Date.now()+1000})},
    webhookQueue:{send:async()=>{}},
  };
  const app=createEngine(deps);
  const request=async(ws,path,body,{key,token=`at_live_${ws}sender`,headers={},engineApp=app}={})=>{
    const response=await engineApp.fetch(new Request('http://fixture'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...(key?{'Idempotency-Key':key}:{}),...headers},body:JSON.stringify(body)}),{}, {waitUntil:p=>background.push(p),passThroughOnException(){}});
    const json=await response.json();
    return {status:response.status,body:json,retry:response.headers.get('Retry-After')};
  };
  const expectStatus=(r,status)=>assert.equal(r.status,status,JSON.stringify(r));
  async function seed(label,n=1,policy={cap:n,reserve:0}){
    const ws=adapter+'-'+label; policies.set(ws,policy);
    await run("INSERT INTO workspaces(id,name,api_key_hash,plan) VALUES(?,?,?,'enterprise')",ws,ws,hash('rk_live_'+ws));
    for(let i=0;i<=(n>10?0:n);i++){
      const suffix=i?'r'+i:'sender';
      await run("INSERT INTO agents(id,workspace_id,name,token_hash,status) VALUES(?,?,?,?,'offline')",ws+suffix,ws,i?'recipient-'+i:'sender',hash('at_live_'+ws+suffix));
    }
    if(n>10)await run("WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < ?) INSERT INTO agents(id,workspace_id,name,token_hash,status) SELECT ?||n,?,'recipient-'||n,?||n,'offline' FROM nums",n,ws+'r',ws,ws+'unused-token-');
    await run("INSERT INTO channels(id,workspace_id,name) VALUES(?,?,'general')",ws+'ch',ws);
    await run('INSERT INTO channel_members(channel_id,agent_id) SELECT ?,id FROM agents WHERE workspace_id=?',ws+'ch',ws);
    return ws;
  }
  const record=(test,details={})=>{results.push({adapter,test,...details});console.log('PASS',adapter,test,JSON.stringify(details));};

  const targetUrl='https://example.com/a2a';
  async function setup(label, {node=false, attachment=false}={}) {
    const ws=await seed(label,1,{cap:100});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card,auth_scheme,auth_credential) VALUES(?,?,?,?,?,?,?)',ws+'a2a',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}),'bearer','fixture-old');
    const localReceipts={webhooks:[],deliveries:[]};
    if(node){
      expectStatus(await request(ws,'/v1/nodes',{name:'receiver',kind:'http_push',delivery:{url:'https://example.com/node',ack_mode:'on_2xx',auth:{type:'none'}}},{token:'rk_live_'+ws}),201);
      expectStatus(await request(ws,'/v1/nodes/receiver/agents',{agent_name:'recipient-1'},{token:'rk_live_'+ws}),201);
    }
    const noKv=createEngine({...deps,kv:undefined,...(node?{
      realtime:{...deps.realtime,publishToWorkspaceStream:async()=>{throw Error('lost live observer fast path');}},
      webhookQueue:{send:async()=>{throw Error('lost queue fast path');}},
    }:{})});
    await run("INSERT INTO event_subscriptions(id,workspace_id,events,url) VALUES(?,?,?,?)",ws+'subscription',ws,JSON.stringify(['dm.received']),'https://example.com/hook');
    if(attachment) await run("INSERT INTO files(id,workspace_id,uploaded_by,filename,content_type,size_bytes,storage_key,status) VALUES(?,?,?,'original.txt','text/plain',12,?,'complete')",ws+'file',ws,ws+'sender',ws+'storage');
    const body={to:'recipient-1',text:'bounded payload',...(attachment?{attachments:[ws+'file']}:{})};
    const retry=()=>request(ws,'/v1/dm',body,{key:'accepted',engineApp:noKv});
    let calls=0;let healthy=false;const captures=[];
    globalThis.fetch=async(url,init)=>{
      if(String(url)==='https://example.com/hook'){assert.ok(healthy);localReceipts.webhooks.push(JSON.parse(init.body));return new Response('',{status:200});}
      if(String(url)==='https://example.com/node'){
        const payload=JSON.parse(init.body);
        if(payload.type==='dm.received' && payload.delivery_id){
          if(!healthy)return new Response('local unavailable',{status:503});
          localReceipts.deliveries.push(payload);
        }
        return new Response('',{status:200});
      }
      assert.equal(String(url),targetUrl);calls++;captures.push({url:String(url),auth:init.headers.authorization,idempotencyKey:init.headers['Idempotency-Key'],payload:JSON.parse(init.body)});if(!healthy)throw Error('fixture-old transport outage');return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const unavailable=await retry();expectStatus(unavailable,502);assert.equal(unavailable.body.error.code,'a2a_transport_unavailable');
    const intent=()=>rows('SELECT * FROM a2a_egress WHERE workspace_id=?',ws).then(r=>r[0]);
    assert.ok(!(await intent()).last_error.includes('fixture-old'));
    return {ws,retry,intent,captures,localReceipts,calls:()=>calls,healthy:()=>{healthy=true;}};
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='legacy-kv') {
    const captured=JSON.parse(readFileSync(new URL('./fixtures/a2a-inbound-published-8.9.1.json',import.meta.url),'utf8'));
    assert.equal(captured.provenance.archive_sha256,'9ddd817c410c02a75cca1c2af82b6a0697599e3f9b730be23076dd8213465854');
    assert.equal(captured.kvWrites.find(w=>!w.key.endsWith(':lock')).options.expirationTtl,86400);
    for(const mode of ['retained','near-expiry','pruned','read-failure','delete-failure','bad-auth','mismatch','malformed','source-mismatch','missing-fingerprint','partial-legacy','unknown-completion']) {
      const f=structuredClone(captured),ws=f.workspaceId;
      const age=mode==='near-expiry'?86340:3600;
      const created=Math.floor(Date.now()/1000)-age;
      // Rebase the captured fixture's clock, preserving the original response,
      // source identity, plaintext fingerprint and measured 24-hour KV TTL.
      f.tables.messages[0].created_at=created;
      const [cacheKey,raw]=f.kvEntries[0];const cache=JSON.parse(raw);
      cache.data.created_at=new Date(created*1000).toISOString();
      if(mode==='malformed')cache.data.message.id='unverified-id';
      if(mode==='source-mismatch')f.tables.messages[0].created_at=created-1;
      if(mode==='missing-fingerprint')delete cache.fingerprint;
      if(mode==='partial-legacy')cache.data={id:cache.data.id};
      if(mode==='unknown-completion'){cache.data={id:cache.data.id,unknown:true};cache.fingerprint=hash(cache.fingerprint);}
      for(const [table,records] of Object.entries(f.tables))for(const row of records){
        await run(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row));
      }
      const cacheMap=new Map([[cacheKey,JSON.stringify(cache)]]),writes=[];
      let readFailure=mode==='read-failure';
      const legacyKv={get:async k=>{if(readFailure)throw Error('legacy KV unavailable');return cacheMap.get(k)??null;},put:async(k,v,o)=>{writes.push({k,v,o});cacheMap.set(k,v);},delete:async k=>{if(mode==='delete-failure')throw Error('KV cleanup unavailable');cacheMap.delete(k);}};
      const legacyApp=createEngine({...deps,config:{environment:'test'},kv:legacyKv});
      const emit=(payload=f.payload,token='at_live_'+f.actorId)=>request(ws,'/a2a/rpc',payload,{token,engineApp:legacyApp});
      const effects=async()=>{
        const state={};for(const table of ['messages','deliveries','message_logs','pending_events'])state[table]=await scalar(`SELECT count(*) FROM ${table} WHERE workspace_id=?`,ws);
        state.dmEvents=await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws);
        state.counter=await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws);return state;
      };
      if(mode==='pruned')await run('DELETE FROM messages WHERE workspace_id=?',ws);
      const before=await effects();
      const changed=structuredClone(f.payload);changed.params.message.parts[0].text='mismatched legacy body';
      const result=await emit(mode==='mismatch'?changed:f.payload,mode==='bad-auth'?'at_live_invalid':'at_live_'+f.actorId);
      if(['retained','near-expiry','delete-failure'].includes(mode)){
        expectStatus(result,200);assert.deepEqual(result.body,f.response.body);
        const [identity]=await rows('SELECT * FROM a2a_inbound WHERE workspace_id=?',ws);
        assert.equal(identity.message_id,f.tables.messages[0].id);assert.equal(identity.created_at,created,'upgrade never restarts original deadline');
        assert.ok(!JSON.stringify(identity).includes('at_live_'));
        readFailure=true;expectStatus(await emit(),200);assert.deepEqual((await emit()).body,f.response.body);
        expectStatus(await emit(changed),409);expectStatus(await emit(f.payload,'at_live_invalid'),401);
        assert.deepEqual(await effects(),before);
        await run('DELETE FROM messages WHERE workspace_id=?',ws);const pruned=await effects();
        expectStatus(await emit(),410);assert.deepEqual(await effects(),pruned);
        assert.deepEqual((await rows('SELECT message_id,response FROM a2a_inbound WHERE workspace_id=?',ws))[0],{message_id:null,response:null});
      }else{
        const status={pruned:410,'read-failure':503,'bad-auth':401,mismatch:409,malformed:503,'source-mismatch':503,'missing-fingerprint':409,'partial-legacy':410,'unknown-completion':410}[mode];expectStatus(result,status);
        assert.deepEqual(await effects(),before);
        if(mode==='read-failure'){readFailure=false;expectStatus(await emit(),200);assert.deepEqual(await effects(),before);}
        if(mode==='pruned'){readFailure=true;expectStatus(await emit(),410);assert.deepEqual(await effects(),before);}
      }
      if(['retained','near-expiry','pruned','read-failure'].includes(mode))assert.equal(cacheMap.has(cacheKey),false,'verified legacy content removed without renewed TTL');
      else assert.equal(cacheMap.has(cacheKey),true,'unverified or failed cleanup retains only original bounded cache');
      assert.ok(writes.every(w=>!w.v.includes('published legacy accepted body')),'new KV writes never store plaintext body');
      record('actual published8.9.1 completed KV fixture upgrade '+mode+' preserves identity/effects/auth and original source deadline');
      await Promise.allSettled(background.splice(0));
      await run('DELETE FROM workspaces WHERE id=?',ws);
      await run('DELETE FROM workspace_events WHERE workspace_id=?',ws);
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='completion-expiry') {
    for(const endpoint of ['rpc','webhook'])for(const source of ['retained','pruned'])for(const changed of (process.env.REVIEW_EXPIRED_CHANGED==='1'?[true]:[false,true])) {
      const ws=await seed('completion-expiry-'+endpoint+'-'+source+'-'+changed,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
      const payload={jsonrpc:'2.0',id:42,method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'expiry-key',role:'agent',parts:[{kind:'text',text:'original accepted body'}]}}};
      const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
      const writes=[];let kvDown=false;
      const cache={...deps.kv,get:async k=>{if(kvDown)throw Error('completion cache outage');return kvMap.get(k)??null;},put:async(k,v,o)=>{writes.push({k,v,o});kvMap.set(k,v);}};
      const receiving=createEngine({...deps,kv:cache});const send=p=>request(ws,path,p??payload,{engineApp:receiving});
      const first=await send();expectStatus(first,200);await Promise.allSettled(background.splice(0));
      const originalId=first.body.result.task.id;
      const completion=writes.find(w=>!w.k.endsWith(':lock'));assert.ok(completion);assert.deepEqual(JSON.parse(completion.v).data,{id:originalId});
      assert.equal(JSON.parse(completion.v).status,endpoint==='rpc'?200:201);assert.match(JSON.parse(completion.v).fingerprint,/^[a-f0-9]{64}$/);assert.equal(completion.o.expirationTtl,86400);
      const mismatch=structuredClone(payload);mismatch.params.message.parts[0].text='new body under expired key';
      expectStatus(await send(),200);expectStatus(await send(mismatch),409);
      assert.equal(writes.filter(w=>!w.k.endsWith(':lock')).length,1,'replays never extend completion TTL');
      if(source==='pruned')await run('DELETE FROM messages WHERE workspace_id=?',ws);
      kvDown=true;expectStatus(await send(),source==='pruned'?410:200);expectStatus(await send(mismatch),409);kvDown=false;
      const before=async()=>({messages:await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),counter:await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),outbox:await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',ws),events:await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws)});
      const pre=await before();
      await run('UPDATE a2a_inbound SET created_at=unixepoch()-86401 WHERE workspace_id=?',ws);
      await sweepPendingA2aEgress(db,20);
      assert.equal(await scalar('SELECT count(*) FROM a2a_inbound WHERE workspace_id=?',ws),0,'real bounded cleanup removed expired SQL identity');
      assert.equal(kvMap.get(completion.k),completion.v,'completion survives SQL expiry exactly as a delayed KV write can');
      kvDown=true;expectStatus(await send(changed?mismatch:payload),503);assert.deepEqual(await before(),pre);kvDown=false;
      const fresh=await send(changed?mismatch:payload);expectStatus(fresh,200);assert.notEqual(fresh.body.result.task.id,originalId);
      const post=await before();assert.equal(post.messages,pre.messages+1);assert.equal(post.counter,pre.counter+1);assert.equal(post.outbox,pre.outbox+1);assert.equal(post.events,pre.events+1);
      const again=await send(changed?mismatch:payload);expectStatus(again,200);assert.deepEqual(again.body,fresh.body);assert.deepEqual(await before(),post);
      assert.ok(writes.filter(w=>!w.k.endsWith(':lock')).every(w=>!w.v.includes('accepted body')&&!w.v.includes('new body')&&w.o.expirationTtl===86400));
      // A retained expired SQL row also authorizes fresh admission during a KV
      // outage; absent SQL + unreadable KV above must remain fail-closed.
      await run('UPDATE a2a_inbound SET created_at=unixepoch()-86401 WHERE workspace_id=?',ws);
      kvDown=true;const expiredWithoutCleanup=await send(changed?mismatch:payload);expectStatus(expiredWithoutCleanup,200);
      assert.notEqual(expiredWithoutCleanup.body.result.task.id,fresh.body.result.task.id);
      assert.equal((await before()).counter,post.counter+1);kvDown=false;
      record(endpoint+' SQL expiry cleanup with '+source+' source and stale KV allows '+(changed?'different':'same')+' payload; within-window replay/prune/conflict and KV outage fail closed');
      await Promise.allSettled(background.splice(0));await run('DELETE FROM workspaces WHERE id=?',ws);
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='webhook-response-id') {
    for(const shape of ['message','task'])for(const outcome of ['accepted','capacity','missing-target']){
      const ws=await seed('response-id-'+shape+'-'+outcome,1,{cap:100});
      // A retained outgoing message supplies the original sender for a response.
      const original=await request(ws,'/v1/dm',{to:'sender',text:'original request'},{token:'at_live_'+ws+'r1'});expectStatus(original,201);
      const originalId=original.body.data.message.id;
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
      const correlation=outcome==='missing-target'?'unknown-original':originalId;
      const message={message_id:correlation,role:'agent',parts:[{kind:'text',text:'response body'}]};
      const payload={jsonrpc:'2.0',result:shape==='message'?{message}:{task:{id:correlation,status:{state:'completed'},history:[message]}}};
      if(outcome==='capacity')policies.set(ws,{cap:1});
      const result=await request(ws,`/a2a/webhook/${ws}/sender`,payload);
      expectStatus(result,outcome==='accepted'?200:outcome==='capacity'?429:400);
      assert.equal(result.body.id,correlation,'missing response ID must use original message/task correlation');
      if(outcome==='accepted'){
        const replay=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(replay,200);assert.deepEqual(replay.body,result.body);
        await run('DELETE FROM messages WHERE id=?',result.body.result.task.id);
        const pruned=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(pruned,410);assert.equal(pruned.body.id,correlation);
      }
      // Explicit response IDs retain type and precedence even when the embedded
      // message/task has a valid fallback; unresolvable IDs remain a 400.
      for(const id of [0,42,'explicit-response-id']){
        const explicit=await request(ws,`/a2a/webhook/${ws}/sender`,{...payload,id});expectStatus(explicit,400);assert.equal(explicit.body.id,id);
      }
      await Promise.allSettled(background.splice(0));await run('DELETE FROM workspaces WHERE id=?',ws);
      record('webhook '+shape+' response correlation '+outcome+'; explicit typed ID precedence');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='webhook-required-message') {
    for(const missing of ['absent','null'])for(const id of [0,42,'string-id',undefined]){
      const ws=await seed('required-message-'+missing+'-'+String(id),1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
      const effects=async()=>({
        messages:await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),
        counter:await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),
        inbound:await scalar('SELECT count(*) FROM a2a_inbound WHERE workspace_id=?',ws),
        deliveries:await scalar('SELECT count(*) FROM deliveries WHERE workspace_id=?',ws),
        outbox:await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',ws),
        events:await scalar('SELECT count(*) FROM workspace_events WHERE workspace_id=?',ws),
      });
      const empty={messages:0,counter:0,inbound:0,deliveries:0,outbox:0,events:0};assert.deepEqual(await effects(),empty);
      const payload={jsonrpc:'2.0',...(id===undefined?{}:{id}),method:'message/send',params:{target_agent:'recipient-1',...(missing==='null'?{message:null}:{})}};
      const result=await request(ws,`/a2a/webhook/${ws}/sender`,payload);
      expectStatus(result,400);assert.equal(result.body.id,id);assert.equal(Object.hasOwn(result.body,'id'),id!==undefined);
      assert.deepEqual(result.body.error,{code:-32602,message:'message is required'});
      await Promise.allSettled(background.splice(0));assert.deepEqual(await effects(),empty,'invalid request must have zero admission effects');
      record('webhook message/send '+missing+' message with '+String(id)+' ID refuses400 before all effects');
      await run('DELETE FROM workspaces WHERE id=?',ws);
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='webhook-request-id') {
    const ws=await seed('webhook-request-id',1,{cap:100});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
    for(const id of [0,42,'string-id',undefined])for(const target of ['recipient-1',undefined]){
      const messageId='request-'+String(id)+'-'+String(target);
      const payload={jsonrpc:'2.0',...(id===undefined?{}:{id}),method:'message/send',params:{...(target?{target_agent:target}:{}),message:{message_id:messageId,role:'agent',parts:[{kind:'text',text:'request body'}]}}};
      const result=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(result,target?200:400);assert.equal(result.body.id,id??messageId);
      if(id===undefined){
        const rpc=await request(ws,'/a2a/rpc',payload);expectStatus(rpc,target?200:400);assert.equal(Object.hasOwn(rpc.body,'id'),false,'RPC absent ID contract stays unchanged');
      }
    }
    // A valid request message requires message_id; the positive cases above
    // omit only the optional JSON-RPC ID, not the required message.
    const effectsBefore=await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws);
    for(const payload of [
      {jsonrpc:'2.0',id:null,method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'null-request',role:'agent',parts:[{kind:'text',text:'must refuse'}]}}},
      {jsonrpc:'2.0',id:null,result:{task:{id:'null-response',status:{state:'completed'}}}},
      {jsonrpc:'2.0',result:{}},
    ]){
      const result=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(result,400);assert.equal(Object.hasOwn(result.body,'id'),false);
    }
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),effectsBefore,'null IDs and uncorrelated response cannot admit');
    await Promise.allSettled(background.splice(0));await run('DELETE FROM workspaces WHERE id=?',ws);
    record('webhook request 200/400 missing-ID fallback and numeric0/42/string; absent all correlation and RPC contracts');
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='webhook-error-id') {
    const ws=await seed('webhook-error-id',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'fill capacity'}),201);
    for(const id of [0,42,'string-id',undefined]){
      const payload={jsonrpc:'2.0',...(id===undefined?{}:{id}),method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'id-'+String(id),role:'agent',parts:[{kind:'text',text:'capacity refusal'}]}}};
      const result=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(result,429);
      assert.equal(result.body.id,id??'id-undefined');assert.ok(Object.hasOwn(result.body,'id'));
    }
    record('webhook capacity errors preserve numeric0/42,string and missing-ID message correlation');await run('DELETE FROM workspaces WHERE id=?',ws);
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='inbound-rejection') {
    for(const endpoint of ['rpc','webhook']){
      const ws=await seed('inbound-rejection-'+endpoint,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
      const observed=[],frames=[];
      for(const agent of ['sender','r1']){
        await run("INSERT INTO nodes(id,workspace_id,name,token_hash,status) VALUES(?,?,?,?,'online')",ws+agent+'node',ws,agent,hash(ws+agent+'node'));
        await run('INSERT INTO agent_node_bindings(id,workspace_id,agent_id,node_id) VALUES(?,?,?,?)',ws+agent+'binding',ws,ws+agent,ws+agent+'node');
        await run("UPDATE agents SET location_type='via_node',location_node_id=? WHERE id=?",ws+agent+'node',ws+agent);
      }
      const receiving=createEngine({...deps,nodeConnections:{...deps.nodeConnections,sendToProvider:async(workspaceId,nodeId,providerName,frame)=>{frames.push({workspaceId,nodeId,providerName,frame});return true;}},config:{...deps.config,mailbox:{depthCap:1}},realtime:{...deps.realtime,publishToWorkspaceStream:async event=>{observed.push(event);}}});
      expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'mailbox fill'},{engineApp:receiving}),201);await Promise.allSettled(background.splice(0));observed.length=0;
      const payload={jsonrpc:'2.0',id:'reject',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'rejected-delivery',role:'agent',parts:[{kind:'text',text:'admitted without target delivery'}]}}};
      const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
      const first=await request(ws,path,payload,{engineApp:receiving});expectStatus(first,200);await Promise.allSettled(background.splice(0));
      const rejected=observed.filter(x=>x.event.type==='delivery.failed');assert.equal(rejected.length,1);
      assert.equal(rejected[0].workspaceId,ws);assert.equal(rejected[0].event.target_agent_id,ws+'r1');
      assert.equal(rejected[0].event.message_id,first.body.result.task.id);
      assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),2);
      assert.equal(await scalar('SELECT count(*) FROM deliveries WHERE workspace_id=?',ws),1);
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
      const senderFrames=frames.filter(x=>x.frame.event==='delivery.failed');
      assert.equal(senderFrames.length,1);assert.equal(senderFrames[0].nodeId,ws+'sendernode');assert.deepEqual(senderFrames[0].frame.agent_ids,[ws+'sender']);
      const replay=await request(ws,path,payload,{engineApp:receiving});expectStatus(replay,200);assert.deepEqual(replay.body,first.body);
      await Promise.allSettled(background.splice(0));assert.equal(observed.filter(x=>x.event.type==='delivery.failed').length,1);assert.equal(frames.filter(x=>x.frame.event==='delivery.failed').length,1);
      record(endpoint+' actual optional mailbox refusal emits sender rejection once; accepted replay adds no notice');await run('DELETE FROM workspaces WHERE id=?',ws);
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='registration') {
    for (const endpoint of ['rpc','webhook']) for (const mutation of ['remove','reassign','replace','token']) {
      const ws=await seed('registration-'+endpoint+'-'+mutation,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,'{}');
      const payload={jsonrpc:'2.0',id:'registration-race',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'history',role:'agent',parts:[{kind:'text',text:'preserved history'}]}}};
      const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
      const noKv=createEngine({...deps,kv:undefined});
      const history=await request(ws,path,payload,{engineApp:noKv});expectStatus(history,200);
      const [original]=await rows('SELECT * FROM a2a_agents WHERE workspace_id=?',ws);
      const snapshot=async()=>{
        const result={};
        for(const table of ['messages','deliveries','message_logs','a2a_inbound','pending_events'])result[table]=await scalar(`SELECT count(*) FROM ${table} WHERE workspace_id=?`,ws);
        result.events=await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws);
        return result;
      };
      const before=await snapshot();let boundaries=0;
      const atomicMethod=adapter==='workerd-d1'?'batch':'withTransaction';
      const changedDb=new Proxy(db,{get(target,key){
        if(key===atomicMethod)return async(...args)=>{
          boundaries++;
          if(boundaries===1){
            if(mutation==='remove')await run('DELETE FROM a2a_agents WHERE id=?',original.id);
            if(mutation==='reassign')await run('UPDATE a2a_agents SET relay_agent_id=? WHERE id=?',ws+'r1',original.id);
            if(mutation==='replace')await run('UPDATE a2a_agents SET id=? WHERE id=?',ws+'replacement',original.id);
            if(mutation==='token')await run('UPDATE agents SET token_hash=? WHERE id=?',hash('rotated-token'),ws+'sender');
          }
          return target[key](...args);
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});
      const racing=createEngine({...deps,db:changedDb,kv:undefined});
      const fresh=structuredClone(payload);fresh.params.message.message_id='new-admission';
      const refused=await request(ws,path,fresh,{engineApp:racing});
      assert.equal(boundaries,1,'mutation executes after route reads immediately before real atomic admission');
      expectStatus(refused,401);
      assert.equal(refused.body.error.data.code,'a2a_registration_changed');
      assert.deepEqual(await snapshot(),before,'refused admission rolls back all durable effects and preserves history');
      if(mutation!=='remove')assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
      await run('DELETE FROM a2a_agents WHERE workspace_id=?',ws);
      await run(`INSERT INTO a2a_agents(${Object.keys(original).join(',')}) VALUES(${Object.keys(original).map(()=>'?').join(',')})`,...Object.values(original));
      await run('UPDATE agents SET token_hash=? WHERE id=?',hash('at_live_'+ws+'sender'),ws+'sender');
      const replay=await request(ws,path,payload,{engineApp:noKv});expectStatus(replay,200);assert.deepEqual(replay.body,history.body);
      assert.deepEqual(await snapshot(),before);
      expectStatus(await request(ws,path,fresh,{engineApp:noKv}),200);
      expectStatus(await request(ws,path,fresh,{engineApp:noKv}),200);
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),2);
      assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),2);
      record(endpoint+' authenticated registration '+mutation+' at atomic boundary refuses new admission, preserves history/replay, restored retry counts once');
      await run('DELETE FROM workspaces WHERE id=?',ws);
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='outbound-header') {
    const f=await setup('outbound-header');
    const intent=await f.intent();
    // The remote records the request before every lost response. Recovery has
    // the same durable identity even when a receiver ignores this header.
    assert.equal(f.captures.length,3);
    f.healthy();await run('UPDATE a2a_egress SET lease_until=0 WHERE id=?',intent.id);
    assert.deepEqual(await sweepPendingA2aEgress(db,1),{attempted:1,failed:0});
    assert.equal(f.captures.length,4);
    for(const capture of f.captures){
      assert.equal(capture.idempotencyKey,intent.id);
      assert.deepEqual(capture.payload,f.captures[0].payload);
      assert.equal(capture.payload.params.message.message_id,intent.message_id);
    }
    assert.equal((await f.intent()).status,'sent');
    assert.equal(await scalar('SELECT messages_sent FROM a2a_agents WHERE workspace_id=?',f.ws),1);
    record('lost-response remote acceptance retains same HTTP Idempotency-Key and body message_id over three transport attempts and recovery',{attempts:f.captures.length});
    await run('DELETE FROM workspaces WHERE id=?',f.ws);
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='policy') {
    for(const kind of ['dm','group','outbound']){
      const ws=await seed('policy-replay-'+kind,1,{cap:100});
      let path='/v1/dm',body={to:'recipient-1',text:'recorded before outage'},calls=0;
      if(kind==='group'){
        const group=await request(ws,'/v1/dm/group',{participants:['recipient-1']});expectStatus(group,201);
        path=`/v1/dm/${group.body.data.id}/messages`;body={text:'recorded before outage'};
      }
      if(kind==='outbound'){
        await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
        globalThis.fetch=async(url,init)=>{calls++;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
      }
      const engineApp=kind==='outbound'?createEngine({...deps,kv:undefined}):app;
      const send=()=>request(ws,path,body,{key:'recorded',engineApp});
      const first=await send();expectStatus(first,201);const before=resolves;
      resolverDown=true;
      try {const replay=await send();expectStatus(replay,201);assert.deepEqual(replay.body,first.body);assert.equal(resolves,before);}
      finally {resolverDown=false;}
      if(kind==='outbound')assert.equal(calls,1);
      record(kind+' cached/durable replay survives failed dynamic policy resolver without lookup or new transport');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='correlation') {
    for(const endpoint of ['rpc','webhook']){
      const ws=await seed('correlation-'+endpoint,1,{cap:1});
      expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'fill cap'}),201);
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      const body={jsonrpc:'2.0',id:'capacity-correlation',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'capacity-retry',role:'agent',parts:[{kind:'text',text:'cannot grow'}]}}};
      const reply=await request(ws,endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`,body);
      expectStatus(reply,429);assert.equal(reply.retry,'30');assert.equal(reply.body.id,'capacity-correlation');
      assert.equal(reply.body.error.data.code,'workspace_delivery_depth_exceeded');
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),0);
      record(endpoint+' real capacity rejection retains JSON-RPC correlation and Retry-After, counter unchanged');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='protocol') {
    for(const malformed of ['json','schema','redirect307','redirect308']){
      const ws=await seed('protocol-'+malformed,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      let calls=0;globalThis.fetch=async()=>{calls++;return malformed==='json'?new Response('{broken'):malformed.startsWith('redirect')?new Response(null,{status:Number(malformed.slice(8)),headers:{Location:'http://127.0.0.1/private'}}):Response.json({jsonrpc:'bad-protocol'});};
      const noKv=createEngine({...deps,kv:undefined});
      const refused=await request(ws,'/v1/dm',{to:'recipient-1',text:'accepted terminal response'},{key:'protocol',engineApp:noKv});
      expectStatus(refused,502);assert.equal(refused.body.error.code,malformed.startsWith('redirect')?'a2a_redirect_forbidden':'a2a_invalid_response');
      const [intent]=await rows('SELECT status,payload FROM a2a_egress WHERE workspace_id=?',ws);
      assert.deepEqual(intent,{status:'failed',payload:null},'parser/protocol failure is terminal and scrubs payload');
      await sweepPendingA2aEgress(db);assert.equal(calls,1);
      record(malformed+' malformed upstream is terminal after one fetch and cannot redrive retained payload');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='inboundCached') {
    for(const endpoint of ['rpc','webhook']){
      const ws=await seed('inbound-cached-'+endpoint,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      const privateBody='source-content-must-not-outlive-message';
      const payload={jsonrpc:'2.0',id:'cached-inbound',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'cached-inbound',role:'agent',parts:[{kind:'text',text:privateBody}]}}};
      const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
      const send=()=>request(ws,path,payload);
      const first=await send();expectStatus(first,200);
      const replay=await send();expectStatus(replay,200);assert.deepEqual(replay.body,first.body);
      assert.ok([...kvMap.entries()].some(([key])=>key.includes(ws)),'completion cache was populated');
      assert.ok(!JSON.stringify([...kvMap.entries()].filter(([key])=>key.includes(ws))).includes(privateBody),'KV retains neither public body nor plaintext fingerprint');
      await Promise.allSettled(background.splice(0));
      await run('DELETE FROM messages WHERE workspace_id=?',ws);
      const pruned=await send();expectStatus(pruned,410);assert.equal(pruned.body.error.data.code,'a2a_message_not_retained');
      assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),0);
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
      assert.deepEqual(await rows('SELECT message_id,response FROM a2a_inbound WHERE workspace_id=?',ws),[{message_id:null,response:null}]);
      record(endpoint+' completed KV cache stores identity only and cannot bypass SQL source-prune tombstone');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='inboundAtomic') {
    for(const table of ['a2a_inbound','pending_events','workspace_events']){
      const ws=await seed('inbound-atomic-'+table,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      const payload={jsonrpc:'2.0',id:'atomic-inbound',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'atomic-inbound',role:'agent',parts:[{kind:'text',text:'atomic local receive'}]}}};
      const path=`/a2a/webhook/${ws}/sender`;
      const noKv=createEngine({...deps,kv:undefined});
      await run(`CREATE TRIGGER inbound_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected inbound admission failure'); END`);
      expectStatus(await request(ws,path,payload,{engineApp:noKv}),500);
      await run('DROP TRIGGER inbound_fault');
      for(const name of ['messages','deliveries','message_logs','a2a_inbound','pending_events'])assert.equal(await scalar(`SELECT count(*) FROM ${name} WHERE workspace_id=?`,ws),0);
      assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws),0);
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),0);
      expectStatus(await request(ws,path,payload,{engineApp:noKv}),200);
      assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
      assert.equal(await scalar('SELECT count(*) FROM a2a_inbound WHERE workspace_id=?',ws),1);
      record('real SQL '+table+' failure rolls back inbound identity/message/counter/notifications; retry admits once');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='inbound') {
    for (const endpoint of ['rpc','webhook']) {
      for (const failure of ['race','completion']) {
        const ws=await seed('inbound-'+endpoint+'-'+failure,1,{cap:100});
        await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
        const payload={jsonrpc:'2.0',id:'inbound-correlation',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'durable-inbound',role:'agent',parts:[{kind:'text',text:'one accepted inbound'}]}}};
        const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
        let arrivals=0,release;const gate=new Promise(r=>release=r);
        const atomicMethod=adapter==='workerd-d1'?'batch':'withTransaction';
        const racingDb=new Proxy(db,{get(target,key){
          if(key===atomicMethod)return async(...args)=>{arrivals++;if(arrivals===2)release();if(arrivals<=2)await gate;return target[key](...args);};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }});
        let completionFailures=0;
        const failingKv={...deps.kv,put:async(k,v)=>{if(!k.endsWith(':lock')){completionFailures++;throw Error('injected inbound KV completion failure');}kvMap.set(k,v);}};
        const inboundApp=createEngine({...deps,db:failure==='race'?racingDb:db,kv:failure==='race'?undefined:failingKv});
        const send=()=>request(ws,path,payload,{engineApp:inboundApp});
        const replies=failure==='race'?await Promise.all([send(),send()]):[await send(),await send()];
        for(const reply of replies)expectStatus(reply,200);
        if(failure==='race')assert.ok(arrivals>=2,'both requests reach SQL admission');
        else assert.ok(completionFailures>=1,'KV completion write actually failed');
        assert.deepEqual(replies[0].body,replies[1].body);
        assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1,'durable inbound identity admits one message');
        assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
        assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws),1,'one durable inbound observer identity');
        assert.equal(await scalar("SELECT count(*) FROM pending_events WHERE workspace_id=? AND event_type='dm.received'",ws),1,'one durable inbound outbox identity');
        assert.equal(await scalar('SELECT count(*) FROM deliveries WHERE workspace_id=?',ws),1);
        record(endpoint+' inbound '+failure+': one SQL identity/message/counter/outbox/event/delivery',{arrivals,completionFailures});
        const changed=structuredClone(payload);changed.params.message.parts[0].text='different payload under same identity';
        expectStatus(await request(ws,path,changed,{engineApp:inboundApp}),409);
        assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1);
        const [identity]=await rows('SELECT * FROM a2a_inbound WHERE workspace_id=?',ws);
        assert.ok(!identity.response.includes('auth_credential'));
        // The local auth token is checked again even for an accepted identity.
        expectStatus(await request(ws,path,payload,{engineApp:inboundApp,token:'at_live_invalid'}),401);
        if(failure==='race'){
          await run('DELETE FROM messages WHERE workspace_id=?',ws);
          const pruned=await send();expectStatus(pruned,410);
          const tombstone=(await rows('SELECT message_id,response FROM a2a_inbound WHERE workspace_id=?',ws))[0];
          assert.deepEqual(tombstone,{message_id:null,response:null},'source pruning scrubs content but preserves retry identity');
          assert.equal(pruned.body.error.data.code,'a2a_message_not_retained');
          assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),0);
          assert.equal(await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws),1);
          assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",ws),1);
          await run('DELETE FROM workspaces WHERE id=?',ws);
          assert.equal(await scalar('SELECT count(*) FROM a2a_inbound WHERE workspace_id=?',ws),0);
        }else{
          await run('UPDATE a2a_inbound SET created_at=unixepoch()-86401 WHERE workspace_id=?',ws);
          await sweepPendingA2aEgress(db,1);
          assert.equal(await scalar('SELECT count(*) FROM a2a_inbound WHERE workspace_id=?',ws),0);
        }
        assert.deepEqual(await rows('PRAGMA foreign_key_check'),[]);
        record(endpoint+' inbound '+failure+' retained identity rejects payload reuse/current bad auth and cascades source or expires in bounded sweep');

      }
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='notifications') {
    const f=await setup('notifications-no-caller-retry',{node:true});
    const id=(await f.intent()).message_id;
    f.healthy();await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
    await sweepPendingA2aEgress(db);
    assert.equal((await f.intent()).status,'sent');
    assert.equal(await scalar("SELECT count(*) FROM pending_events WHERE workspace_id=? AND event_type='dm.received'",f.ws),1,'admitted webhook survives route transport failure');
    assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",f.ws),1,'admitted workspace event survives route transport failure');
    assert.equal(await scalar('SELECT count(*) FROM deliveries WHERE message_id=?',id),1);
    await Promise.allSettled(background.splice(0));
    await run('UPDATE deliveries SET next_attempt_at=0 WHERE workspace_id=?',f.ws);
    const recoverLocal=async()=>{
      for(const event of await sweepPendingEvents(db)){
        const result=await deliverEvent(db,event.workspaceId,event.eventType,event.payload);
        assert.equal(result.failed,0);await event.complete();
      }
      await sweepDueNodeDeliveries({...deps,db});
    };
    await recoverLocal();
    const replayLog=await listWorkspaceEvents(db,f.ws);
    const dmEvents=replayLog.events.filter(e=>e.type==='dm.received');
    assert.equal(dmEvents.length,1);assert.equal(dmEvents[0].payload.message.id,id);
    assert.equal(f.localReceipts.webhooks.length,1);assert.equal(f.localReceipts.webhooks[0].data.id,id);
    assert.equal(f.localReceipts.deliveries.length,1);assert.equal(f.localReceipts.deliveries[0].message_id,id);
    assert.equal(await scalar('SELECT status FROM deliveries WHERE message_id=?',id),'acked');
    await sweepPendingA2aEgress(db);await recoverLocal();
    assert.equal(f.localReceipts.webhooks.length,1);assert.equal(f.localReceipts.deliveries.length,1);
    assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",f.ws),1);
    // Only after sweep-only recovery has been proved, verify caller replay adds no identities.
    expectStatus(await f.retry(),201);await recoverLocal();
    assert.equal(f.localReceipts.webhooks.length,1);assert.equal(f.localReceipts.deliveries.length,1);
    assert.equal(await scalar("SELECT count(*) FROM workspace_events WHERE workspace_id=? AND type='dm.received'",f.ws),1);
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',f.ws),1);
    assert.equal(await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',f.ws),0);
    record('route failure plus lost live/queue fast paths: egress + webhook + node sweeps and workspace cursor replay; once-only identities',{messageId:id,workspaceSeq:dmEvents[0].seq,webhooks:1,deliveries:1});
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='atomic') {
    const counts=async ws=>({
      messages:await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),
      intents:await scalar('SELECT count(*) FROM a2a_egress WHERE workspace_id=?',ws),
      contexts:await scalar('SELECT count(*) FROM a2a_egress_context c JOIN a2a_egress e ON e.id=c.id WHERE e.workspace_id=?',ws),
      webhooks:await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',ws),
      events:await scalar('SELECT count(*) FROM workspace_events WHERE workspace_id=?',ws),
      deliveries:await scalar('SELECT count(*) FROM deliveries WHERE workspace_id=?',ws),
      logs:await scalar('SELECT count(*) FROM message_logs WHERE workspace_id=?',ws),
    });
    for(const failure of ['pending_events','workspace_events','a2a_egress_context','capacity']){
      const ws=await seed('rollback-'+failure,1,{cap:1});
      if(failure==='capacity')expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'fill'}),201);
      await Promise.allSettled(background.splice(0));
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      // Authentication legitimately emits presence on the first request. Warm it
      // before taking the strict all-event admission rollback baseline.
      const warm=await app.fetch(new Request('http://fixture/v1/dm/conversations',{headers:{authorization:'Bearer at_live_'+ws+'sender'}}),{}, {waitUntil:p=>background.push(p),passThroughOnException(){}});
      assert.equal(warm.status,200);await warm.arrayBuffer();await Promise.allSettled(background.splice(0));
      const before=await counts(ws);let calls=0;
      globalThis.fetch=async()=>{calls++;return Response.json({jsonrpc:'2.0',result:{}});};
      if(failure!=='capacity')await run(`CREATE TRIGGER admission_fault BEFORE INSERT ON ${failure} BEGIN SELECT RAISE(ABORT,'injected atomic notification failure'); END`);
      const attempt=await request(ws,'/v1/dm',{to:'recipient-1',text:'must roll back'},{key:'rollback'});
      expectStatus(attempt,failure==='capacity'?429:500);
      if(failure!=='capacity')await run('DROP TRIGGER admission_fault');
      const after=await counts(ws);
      if(JSON.stringify(after)!==JSON.stringify(before))console.log('ROLLBACK_DIAGNOSTIC',JSON.stringify({adapter,failure,before,after,events:await rows('SELECT type,payload FROM workspace_events WHERE workspace_id=?',ws)}));
      assert.deepEqual(after,before);assert.equal(calls,0);
      record('atomic '+failure+' refusal creates no message/intent/context/outbox/workspace event/delivery/log/transport',{counts:before,calls});
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='retention') {
    for(const change of ['source','expiry','workspace']){
      const f=await setup('context-retention-'+change);f.healthy();
      await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
      expectStatus(await f.retry(),201);const accepted=await f.intent();
      const contextCount=()=>scalar('SELECT count(*) FROM a2a_egress_context WHERE id=?',accepted.id);
      const context=(await rows('SELECT response FROM a2a_egress_context WHERE id=?',accepted.id))[0].response;
      assert.ok(context.includes('bounded payload'));assert.ok(!context.includes('fixture-old'));assert.equal(await contextCount(),1);
      const before=f.calls();
      if(change==='source'){
        await run('DELETE FROM messages WHERE workspace_id=?',f.ws);
        const retry=await f.retry();expectStatus(retry,410);assert.equal(retry.body.error.code,'a2a_message_not_retained');
        assert.ok(await f.intent(),'source deletion retains tombstone');
      }else if(change==='expiry'){
        await run('UPDATE a2a_egress SET created_at=unixepoch()-86401 WHERE workspace_id=?',f.ws);
        const retry=await f.retry();expectStatus(retry,410);assert.equal(retry.body.error.code,'a2a_egress_expired');
        await cleanupA2aEgress(db,100);assert.equal(await f.intent(),undefined);
      }else{
        await run('DELETE FROM workspaces WHERE id=?',f.ws);assert.equal(await f.intent(),undefined);
      }
      assert.equal(await contextCount(),0);assert.equal(f.calls(),before);
      record(change+' cleanup cascades full public context; no credentials or extra transport');
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='counter') {
    for (const endpoint of ['rpc','webhook']) {
      const ws=await seed('counter-'+endpoint,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'sender',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      const payload={jsonrpc:'2.0',id:'counter-rpc',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'counter-message',role:'agent',parts:[{kind:'text',text:'count once'}]}}};
      const path=endpoint==='rpc'?'/a2a/rpc':`/a2a/webhook/${ws}/sender`;
      await run("CREATE TRIGGER fail_received_counter BEFORE UPDATE OF messages_recv ON a2a_agents BEGIN SELECT RAISE(ABORT,'injected counter failure'); END");
      expectStatus(await request(ws,path,payload),500);
      const before=await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws);
      await run('DROP TRIGGER fail_received_counter');
      expectStatus(await request(ws,path,payload),200);
      expectStatus(await request(ws,path,payload),200);
      const count=await scalar('SELECT messages_recv FROM a2a_agents WHERE workspace_id=?',ws);
      assert.equal(count,1,'counter failure/retry must count exactly once');
      assert.equal(before,0,'counter failure rolls back local message');
      assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1);
      record(endpoint+' real SQL counter failure then retries: one admitted message and count',{before,count});
    }
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='retained') {
    const f=await setup('completed-context',{attachment:true});f.healthy();
    await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
    const original=await f.retry();expectStatus(original,201);
    const before=f.calls();
    await run("UPDATE files SET filename='changed.txt',status='pending' WHERE workspace_id=?",f.ws);
    await run("UPDATE agents SET name='renamed' WHERE id=?",f.ws+'r1');
    await run("UPDATE dm_participants SET left_at=unixepoch() WHERE agent_id=?",f.ws+'r1');
    await run("UPDATE a2a_agents SET external_url='https://example.net/new',auth_credential='new-secret-never-send' WHERE workspace_id=?",f.ws);
    const replay=await f.retry();expectStatus(replay,201);assert.deepEqual(replay.body,original.body);assert.equal(f.calls(),before);
    assert.equal(await scalar('SELECT count(*) FROM dm_participants WHERE agent_id=? AND left_at IS NULL',f.ws+'r1'),0);
    await run('DELETE FROM dm_conversations WHERE id=?',original.body.data.conversation_id);
    await run('DELETE FROM files WHERE workspace_id=?',f.ws);
    await run('DELETE FROM agents WHERE id=?',f.ws+'r1');
    const deleted=await f.retry();expectStatus(deleted,201);assert.deepEqual(deleted.body,original.body);assert.equal(f.calls(),before);
    assert.equal(await scalar('SELECT count(*) FROM dm_conversations WHERE id=?',original.body.data.conversation_id),0);
    assert.equal(original.body.data.attachments[0].filename,'original.txt');
    record('completed response survives recipient rename/delete and attachment/status/delete/endpoint/auth/roster churn without transport');
  }
  if (!process.env.REVIEW_CASE || process.env.REVIEW_CASE==='race') {
    const ws=await seed('real-ledger-race',1,{cap:100});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
    let arrivals=0,release;const gate=new Promise(r=>release=r);
    const atomicMethod=adapter==='workerd-d1'?'batch':'withTransaction';
    const racingDb=new Proxy(db,{get(target,key){
      if(key===atomicMethod)return async(...args)=>{arrivals++;if(arrivals===2)release();if(arrivals<=2)await gate;return target[key](...args);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const racingApp=createEngine({...deps,db:racingDb,kv:undefined});
    let calls=0;globalThis.fetch=async(url,init)=>{calls++;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const raced=await Promise.all(['first','different'].map(text=>request(ws,'/v1/dm',{to:'recipient-1',text},{key:'raced',engineApp:racingApp})));
    assert.ok(arrivals>=2,'both requests reached real atomic admission');
    assert.deepEqual(raced.map(r=>r.status).sort(),[201,409],JSON.stringify(raced));
    assert.equal(raced.find(r=>r.status===409).body.error.code,'idempotency_key_reused');
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1);assert.equal(calls,1);
    record('real simultaneous different-payload admission: SQL winner and typed 409 loser',{arrivals,statuses:raced.map(r=>r.status),calls});
  }
  globalThis.fetch=originalFetch;
  await Promise.allSettled(background);
 }
 writeFileSync(process.env.CAPACITY_RESULTS??'/tmp/engine-431-review-results.json',JSON.stringify({results},null,2)+'\n');
}finally{globalThis.fetch=originalFetch;await mf.dispose();for(const r of runtimes)r.close();}
