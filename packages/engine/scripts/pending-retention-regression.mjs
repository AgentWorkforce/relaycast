// Parent pending-retention probe copied verbatim except portable paths and new-index baseline filtering.
// Actual HTTP engine + native Node transactions and local workerd D1 batch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createNodeRuntime } from '../dist/adapters/node/index.js';
import { createEngine, schema } from '../dist/index.js';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import Database from 'better-sqlite3';
import { buildChannelDeliveryWrite, buildDirectDeliveryWrite, buildGroupDmDeliveryWrite } from '../dist/engine/deliveryWrites.js';
import { runAtomicWrites } from '../dist/ports/database.js';
import { resolveWorkspaceDeliveryPolicyFor, resolveWorkspaceDeliveryPolicy } from '../dist/engine/workspaceDeliveryPolicy.js';
import { deriveRelayfileInboundSecret } from '../dist/routes/relayfileInbound.js';
import { sweepPendingA2aEgress } from '../dist/engine/a2aEgress.js';

const results = [];
const hash = x => createHash('sha256').update(x).digest('hex');
const runtimes = [':memory:', `/tmp/finn-capacity-${randomUUID()}.sqlite`].map(dbPath => createNodeRuntime({
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
 // Exercise the exact new migration against the previous schema, including
 // existing rows, rather than relying only on fresh-table schema copying.
 const upgradeD1=await mf.getD1Database('UPGRADE');
 const upgradeSqlite=new Database(':memory:');
 try {
  const baseline=sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all().filter(row=>!shadow.has(row.name)&&row.name !== 'a2a_egress' && !row.name.startsWith('idx_a2a_egress_'));
  for(const row of baseline){upgradeSqlite.exec(row.sql);await upgradeD1.prepare(row.sql).run();}
  const seed="INSERT INTO workspaces(id,name,api_key_hash,plan) VALUES('upgrade','upgrade','upgrade','enterprise')";
  upgradeSqlite.exec(seed);await upgradeD1.prepare(seed).run();
  const migration=readFileSync(new URL('../src/db/migrations/0057_a2a_egress.sql',import.meta.url),'utf8');
  for(let repeat=0;repeat<2;repeat++){
   upgradeSqlite.exec(migration);
   for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await upgradeD1.prepare(statement).run();
  }
  assert.equal(upgradeSqlite.prepare("SELECT count(*) n FROM workspaces WHERE id='upgrade'").get().n,1);
  assert.equal((await upgradeD1.prepare("SELECT count(*) n FROM workspaces WHERE id='upgrade'").first()).n,1);
  assert.equal(upgradeSqlite.prepare('PRAGMA table_info(a2a_egress)').all().length,15);
  assert.equal((await upgradeD1.prepare('PRAGMA table_info(a2a_egress)').all()).results.length,15);
  results.push({test:'0057 migration applied twice to previous schema; existing workspace retained',adapters:['node','workerd-d1']});
 }finally{upgradeSqlite.close();}
 for(const adapter of ['node-memory','node-file','workerd-d1']){
  const runtime=runtimes[adapter==='node-file'?1:0];
  const db=adapter==='workerd-d1'?drizzle(measuredD1,{schema}):runtime.deps.db;
  const run=async(sql,...args)=>adapter==='workerd-d1'?d1.prepare(sql).bind(...args).run():runtime.handle.sqlite.prepare(sql).run(...args);
  const rows=async(sql,...args)=>adapter==='workerd-d1'?(await d1.prepare(sql).bind(...args).all()).results:runtime.handle.sqlite.prepare(sql).all(...args);
  const scalar=async(sql,...args)=>Object.values((await rows(sql,...args))[0])[0];
  const depth=ws=>scalar("SELECT count(*) FROM deliveries WHERE workspace_id=? AND status IN ('queued','delivered') AND (expires_at IS NULL OR expires_at>unixepoch())",ws);
  const policies=new Map();let resolves=0;const background=[];
  const kvMap=new Map();let failCompletion=false;
  const deps={...runtime.deps,db,
    config:{environment:'test',relayfileInboundSecret:'fixture-only',workspaceDelivery:{resolve:async workspace=>{await Promise.resolve();resolves++;assert.equal(workspace.plan,'enterprise');return policies.get(workspace.id);}}},
    kv:{get:async k=>kvMap.get(k)??null,put:async(k,v)=>{if(failCompletion&&!k.endsWith(':lock'))throw Error('fixture KV completion failure');kvMap.set(k,v);},delete:async k=>{kvMap.delete(k);}},
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
  const send=(ws,text,key,data)=>request(ws,'/v1/channels/general/messages',{text,...(data?{data}:{})},{key});
  const record=(test,details={})=>{results.push({adapter,test,...details});console.log('PASS',adapter,test,JSON.stringify(details));};

  {
    const ws=await seed('retained-intent-missing-message',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const noKv=createEngine({...deps,kv:undefined});
    const body={to:'recipient-1',text:'retention probe'};const options={key:'retain-original',engineApp:noKv};
    expectStatus(await request(ws,'/v1/dm',body,options),201);
    await run('DELETE FROM messages WHERE workspace_id=?',ws);
    const replay=await request(ws,'/v1/dm',body,options);
    const result={adapter,status:replay.status,error:replay.body.error?.code,calls,intents:await scalar('SELECT count(*) FROM a2a_egress WHERE workspace_id=?',ws)};
    results.push(result);console.log('RETENTION_REPLAY',JSON.stringify(result));assert.equal(result.status,410);assert.equal(result.error,'a2a_message_not_retained');assert.equal(result.calls,1);
    globalThis.fetch=originalFetch;
  }

  {
    const ws=await seed('pending-message-pruned',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;let healthy=false;globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;if(!healthy)throw Error('fixture transport outage');return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'must not outlive record'},{key:'pending-retained'}),500);
    await run('DELETE FROM messages WHERE workspace_id=?',ws);
    await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',ws);
    healthy=true;const before=calls;await sweepPendingA2aEgress(db);
    console.log('PRUNED_PENDING_RECOVERY',JSON.stringify({adapter,beforeCalls:before,afterCalls:calls}));
    globalThis.fetch=originalFetch;assert.equal(calls,before,'recovery must not send after source message retention');
  }
  await Promise.allSettled(background);assert.ok(resolves>0);
 }
 for(const cap of [0,-1,NaN,Infinity,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap,reserve:0})}},{id:'ws'}));
 for(const reserve of [-1,NaN,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve})}},{id:'ws'}));
 assert.deepEqual(await resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve:20})}},{id:'ws'}),{cap:10,reserve:9});
 assert.deepEqual(resolveWorkspaceDeliveryPolicy({workspaceDelivery:{cap:10,reserve:4,workspaces:{ws:{reserve:0}}}},'ws'),{cap:10,reserve:0});
 results.push({test:'dynamic validation and static explicit reserve zero'});
 writeFileSync(process.env.CAPACITY_RESULTS??'/tmp/finn-capacity-http-results.json',JSON.stringify({results},null,2)+'\n');console.log(`Recorded ${results.length} records`);assert.ok(results.filter(x=>x.status).every(x=>x.status!==500),'retained intent after message retention must not return500');
}finally{globalThis.fetch=originalFetch;await mf.dispose();for(const r of runtimes)r.close();}
