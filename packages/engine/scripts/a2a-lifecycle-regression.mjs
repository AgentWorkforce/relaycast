// Actual HTTP/Node/D1 lifecycle and cleanup race controls built on the parent probe fixture.
// Actual HTTP engine + native Node transactions and local workerd D1 batch.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createNodeRuntime } from '../dist/adapters/node/index.js';
import { createEngine, schema } from '../dist/index.js';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import Database from 'better-sqlite3';
import { planMigrations } from '../dist/db/migrationPlan.js';
import { resolveWorkspaceDeliveryPolicyFor, resolveWorkspaceDeliveryPolicy } from '../dist/engine/workspaceDeliveryPolicy.js';
import { sweepPendingA2aEgress, cleanupA2aEgress } from '../dist/engine/a2aEgress.js';

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
  upgradeSqlite.pragma('foreign_keys = ON');
  const migrationDir=new URL('../src/db/migrations/',import.meta.url);
  const priorFiles=readdirSync(migrationDir).filter(name=>name.endsWith('.sql')&&name<'0057');
  const priorPlan=planMigrations(priorFiles,new Set(),JSON.parse(readFileSync(new URL('supersessions.json',migrationDir),'utf8')));
  for(const name of priorPlan)upgradeSqlite.exec(readFileSync(new URL(name,migrationDir),'utf8'));
  assert.equal(upgradeSqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'a2a_egress%' OR name='a2a_inbound'").get().n,0);
  const baselineShadow=new Set(upgradeSqlite.prepare('PRAGMA table_list').all().filter(r=>r.type==='shadow').map(r=>r.name));
  const baseline=upgradeSqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all().filter(row=>!baselineShadow.has(row.name));
  for(const row of baseline)await upgradeD1.prepare(row.sql).run();
  const metadata=async query=>{
    const tables=await query("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return Promise.all(tables.filter(t=>!baselineShadow.has(t.name)&&!t.name.startsWith('_cf_')).map(async table=>({
      ...table,foreignKeys:await query(`PRAGMA foreign_key_list('${table.name}')`),
      indexes:await Promise.all((await query(`PRAGMA index_list('${table.name}')`)).map(async index=>({...index,columns:await query(`PRAGMA index_info('${index.name}')`)}))),
    })));
  };
  const nodeQuery=async sql=>upgradeSqlite.prepare(sql).all();
  const d1Query=async sql=>(await upgradeD1.prepare(sql).all()).results;
  const beforeNode=await metadata(nodeQuery),beforeD1=await metadata(d1Query);
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
  for(const [query,before] of [[nodeQuery,beforeNode],[d1Query,beforeD1]]){
    const after=await metadata(query);
    assert.deepEqual(after.filter(t=>before.some(old=>old.name===t.name)),before,'0057 preserves original SQL/FK/unique-index metadata');
    assert.ok((await query("PRAGMA foreign_key_list('a2a_egress')")).some(f=>f.table==='workspaces'&&f.from==='workspace_id'&&f.on_delete==='CASCADE'));
  }
  for(const name of ['0058_a2a_egress_context.sql','0059_a2a_inbound_admission.sql']){
    const ddl=readFileSync(new URL(name,migrationDir),'utf8');
    for(let repeat=0;repeat<2;repeat++){
      upgradeSqlite.exec(ddl);
      for(const statement of ddl.split(ddl.includes('--> statement-breakpoint')?'--> statement-breakpoint':';').map(s=>s.trim()).filter(Boolean))await upgradeD1.prepare(statement).run();
    }
  }
  for(const query of [nodeQuery,d1Query]){
    assert.deepEqual((await query("PRAGMA index_info('idx_a2a_egress_workspace')")).map(c=>c.name),['workspace_id']);
    assert.deepEqual((await query("PRAGMA foreign_key_list('a2a_inbound')")).map(f=>[f.table,f.from,f.on_delete]).sort(),[['messages','message_id','SET NULL'],['workspaces','workspace_id','CASCADE']]);
    assert.deepEqual(await query('PRAGMA foreign_key_check'),[]);
  }
  results.push({test:'real pre0057 migration plan through0056; additive0057/58/59 twice, original SQL/FKs/unique-index metadata unchanged and new FK/index metadata verified',adapters:['node','workerd-d1'],priorPlan});
 }finally{upgradeSqlite.close();}
 for(const adapter of ['node-memory','node-file','workerd-d1']){
  const runtime=runtimes[adapter==='node-file'?1:0];
  const db=adapter==='workerd-d1'?drizzle(measuredD1,{schema}):runtime.deps.db;
  const run=async(sql,...args)=>adapter==='workerd-d1'?d1.prepare(sql).bind(...args).run():runtime.handle.sqlite.prepare(sql).run(...args);
  const rows=async(sql,...args)=>adapter==='workerd-d1'?(await d1.prepare(sql).bind(...args).all()).results:runtime.handle.sqlite.prepare(sql).all(...args);
  const scalar=async(sql,...args)=>Object.values((await rows(sql,...args))[0])[0];
  const policies=new Map();let resolves=0;const background=[];
  const kvMap=new Map();
  const deps={...runtime.deps,db,
    config:{environment:'test',relayfileInboundSecret:'fixture-only',workspaceDelivery:{resolve:async workspace=>{await Promise.resolve();resolves++;assert.equal(workspace.plan,'enterprise');return policies.get(workspace.id);}}},
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
  const send=(ws,text,key,data)=>request(ws,'/v1/channels/general/messages',{text,...(data?{data}:{})},{key});
  const record=(test,details={})=>{results.push({adapter,test,...details});console.log('PASS',adapter,test,JSON.stringify(details));};

  const targetUrl='https://example.com/a2a';
  async function setup(label) {
    const ws=await seed(label,1,{cap:100});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card,auth_scheme,auth_credential) VALUES(?,?,?,?,?,?,?)',ws+'a2a',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}),'bearer','fixture-old');
    const noKv=createEngine({...deps,kv:undefined});
    const body={to:'recipient-1',text:'bounded payload'};
    const retry=()=>request(ws,'/v1/dm',body,{key:'accepted',engineApp:noKv});
    let calls=0;let healthy=false;const captures=[];
    globalThis.fetch=async(url,init)=>{assert.equal(String(url),targetUrl);calls++;captures.push({url:String(url),auth:init.headers.authorization,payload:JSON.parse(init.body)});if(!healthy)throw Error('fixture-old transport outage');return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const unavailable=await retry();expectStatus(unavailable,502);assert.equal(unavailable.body.error.code,'a2a_transport_unavailable');
    const intent=()=>rows('SELECT * FROM a2a_egress WHERE workspace_id=?',ws).then(r=>r[0]);
    assert.ok(!(await intent()).last_error.includes('fixture-old'));
    return {ws,retry,intent,captures,calls:()=>calls,healthy:()=>{healthy=true;}};
  }
  for(const callerFirst of [false,true]){
    const f=await setup('source-pruned-'+callerFirst);const before=f.calls();
    await run('DELETE FROM messages WHERE workspace_id=?',f.ws);f.healthy();
    if(!callerFirst){await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);await sweepPendingA2aEgress(db);}
    const replay=await f.retry();expectStatus(replay,410);assert.equal(replay.body.error.code,'a2a_message_not_retained');assert.equal(f.calls(),before);
    assert.equal((await f.intent()).status,'failed');assert.equal((await f.intent()).payload,null);
    record('source deletion blocks '+(callerFirst?'caller retry before lease expiry':'recovery then caller retry'),{calls:f.calls()});
  }
  for(const change of ['delete','recreate','endpoint','recipient-delete']){
    const f=await setup('target-'+change);const before=f.calls();f.healthy();
    if(change==='endpoint')await run('UPDATE a2a_agents SET external_url=?,auth_credential=? WHERE workspace_id=?','https://example.net/rotated','fixture-rotated',f.ws);
    else if(change==='recipient-delete')await run('DELETE FROM agents WHERE id=?',f.ws+'r1');
    else {
      await run('DELETE FROM a2a_agents WHERE workspace_id=?',f.ws);
      if(change==='recreate')await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card,auth_scheme,auth_credential) VALUES(?,?,?,?,?,?,?)',f.ws+'replacement',f.ws,f.ws+'r1',targetUrl,'{}','bearer','fixture-rotated');
    }
    const replay=await f.retry();expectStatus(replay,410);assert.equal(replay.body.error.code,'a2a_target_gone');
    await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);await sweepPendingA2aEgress(db);
    assert.equal(f.calls(),before);assert.equal((await f.intent()).status,'failed');assert.equal((await f.intent()).payload,null);
    record('target '+change+' terminal before transport',{calls:f.calls()});
  }
  {
    const f=await setup('same-endpoint-auth');f.healthy();
    await run('UPDATE a2a_agents SET auth_scheme=?,auth_credential=? WHERE workspace_id=?','api_key','fixture-rotated',f.ws);
    await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
    let headers;globalThis.fetch=async(url,init)=>{headers=init.headers;assert.equal(String(url),targetUrl);assert.equal(init.headers['x-api-key'],'fixture-rotated');assert.equal(init.headers.authorization,undefined);return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    expectStatus(await f.retry(),201);assert.ok(headers);assert.equal((await f.intent()).payload,null);assert.ok(!JSON.stringify(await f.intent()).includes('fixture-rotated'));
    await run('DELETE FROM messages WHERE workspace_id=?',f.ws);const replay=await f.retry();expectStatus(replay,410);assert.equal(replay.body.error.code,'a2a_message_not_retained');
    record('same endpoint uses coherent rotated auth; sent payload scrubbed; retained sent replay stays 410');
  }
  for(const mutation of ['source','target','auth','expiry']){
    const f=await setup('internal-retry-'+mutation);await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
    let calls=0;
    globalThis.fetch=async(url,init)=>{
      calls++;assert.equal(String(url),targetUrl);
      if(calls===1){
        if(mutation==='source')await run('DELETE FROM messages WHERE workspace_id=?',f.ws);
        if(mutation==='target')await run('UPDATE a2a_agents SET external_url=?,auth_credential=? WHERE workspace_id=?','https://example.net/new','fixture-new',f.ws);
        if(mutation==='auth')await run('UPDATE a2a_agents SET auth_credential=? WHERE workspace_id=?','fixture-new',f.ws);
        if(mutation==='expiry')await run('UPDATE a2a_egress SET created_at=unixepoch()-86401 WHERE workspace_id=?',f.ws);
        return new Response('retry',{status:503});
      }
      assert.equal(mutation,'auth');assert.equal(init.headers.authorization,'Bearer fixture-new');return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});
    };
    const replay=await f.retry();expectStatus(replay,mutation==='auth'?201:410);assert.equal(calls,mutation==='auth'?2:1);
    if(mutation!=='auth')assert.equal(replay.body.error.code,{source:'a2a_message_not_retained',target:'a2a_target_gone',expiry:'a2a_egress_expired'}[mutation]);
    record('revalidation between internal transport attempts: '+mutation,{calls});
  }
  {
    const f=await setup('expiry-before-dispatch');const before=f.calls();f.healthy();
    await run('UPDATE a2a_egress SET created_at=unixepoch()-86401 WHERE workspace_id=?',f.ws);
    const replay=await f.retry();expectStatus(replay,410);assert.equal(replay.body.error.code,'a2a_egress_expired');assert.equal(f.calls(),before);assert.equal((await f.intent()).payload,null);
    await cleanupA2aEgress(db,100);assert.equal(await f.intent(),undefined);
    // After the documented window and cleanup, the old key is fresh.
    expectStatus(await f.retry(),201);assert.equal(f.calls(),before+1);
    record('expired pending intent never sends; typed 410 until cleanup, then key is fresh');
  }
  {
    // Isolate cleanup counts from previous expired fixtures.
    await cleanupA2aEgress(db,100);
    const f=await setup('bounded-cleanup');const original=await f.intent();
    for(let i=0;i<5;i++)await run("INSERT INTO a2a_egress(id,workspace_id,message_id,target_id,external_url,fingerprint,payload,status,created_at) VALUES(?,?,?,?,?,?,?,'sent',unixepoch()-86401)",f.ws+'old'+i,f.ws,original.message_id,original.target_id,targetUrl,'cleanup',null);
    const plan=await rows('EXPLAIN QUERY PLAN SELECT id FROM a2a_egress WHERE created_at<=unixepoch()-86400 ORDER BY created_at,id LIMIT 2');
    assert.ok(plan.some(r=>String(r.detail).includes('idx_a2a_egress_retention')));
    const counts=await Promise.all([cleanupA2aEgress(db,2),cleanupA2aEgress(db,2)]);assert.deepEqual(counts,[2,2]);
    assert.equal(await scalar("SELECT count(*) FROM a2a_egress WHERE workspace_id=? AND status='sent'",f.ws),1);
    assert.equal(await cleanupA2aEgress(db,2),1);assert.ok(await f.intent());
    record('bounded indexed cleanup and concurrent cleanup delete disjoint expired batches',{counts,plan:plan.map(r=>r.detail)});
  }
  {
    const f=await setup('cleanup-transport-race');await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',f.ws);
    let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let calls=0;
    globalThis.fetch=async(url,init)=>{calls++;entered();await gate;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const sending=f.retry();await started;
    await run('UPDATE a2a_egress SET created_at=unixepoch()-86401 WHERE workspace_id=?',f.ws);
    assert.equal(await cleanupA2aEgress(db,100),0);assert.equal((await f.intent()).status,'sending');
    expectStatus(await f.retry(),409);assert.equal(calls,1);release();expectStatus(await sending,201);
    assert.equal((await f.intent()).status,'sent');assert.equal((await f.intent()).payload,null);assert.equal(await cleanupA2aEgress(db,100),1);
    record('cleanup preserves active lease; concurrent retry excluded; cleanup after settlement',{calls});
  }
  {
    const f=await setup('expired-crash-lease');f.healthy();const before=f.calls();
    await run("UPDATE a2a_egress SET status='sending',claim_token='crashed',lease_until=unixepoch()-1,created_at=unixepoch()-86401 WHERE workspace_id=?",f.ws);
    await sweepPendingA2aEgress(db);assert.equal(f.calls(),before);assert.equal(await f.intent(),undefined);
    record('expired crashed lease retires without transport',{calls:f.calls()});
  }
  globalThis.fetch=originalFetch;
  await Promise.allSettled(background);assert.ok(resolves>0);
 }
 for(const cap of [0,-1,NaN,Infinity,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap,reserve:0})}},{id:'ws'}));
 for(const reserve of [-1,NaN,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve})}},{id:'ws'}));
 assert.deepEqual(await resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve:20})}},{id:'ws'}),{cap:10,reserve:9});
 assert.deepEqual(resolveWorkspaceDeliveryPolicy({workspaceDelivery:{cap:10,reserve:4,workspaces:{ws:{reserve:0}}}},'ws'),{cap:10,reserve:0});
 results.push({test:'dynamic validation and static explicit reserve zero'});
 writeFileSync(process.env.CAPACITY_RESULTS??'/tmp/finn-capacity-http-results.json',JSON.stringify({results},null,2)+'\n');console.log(`Recorded ${results.length} records`);
}finally{globalThis.fetch=originalFetch;await mf.dispose();for(const r of runtimes)r.close();}
