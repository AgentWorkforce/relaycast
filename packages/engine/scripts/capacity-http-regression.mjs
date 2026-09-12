// Actual HTTP engine + native Node transactions and local workerd D1 batch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createNodeRuntime } from '../dist/adapters/node/index.js';
import { createEngine, schema } from '../dist/index.js';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import Database from 'better-sqlite3';
import { buildChannelDeliveryWrite, buildDirectDeliveryWrite } from '../dist/engine/deliveryWrites.js';
import { runAtomicWrites } from '../dist/ports/database.js';
import { resolveWorkspaceDeliveryPolicyFor, resolveWorkspaceDeliveryPolicy } from '../dist/engine/workspaceDeliveryPolicy.js';
import { deriveRelayfileInboundSecret } from '../dist/routes/relayfileInbound.js';
import { sweepPendingA2aEgress } from '../dist/engine/a2aEgress.js';

const results = [];
const originalConsoleError=console.error;
const backgroundErrors=[];
console.error=(...args)=>{
  if(args.some(arg=>arg && typeof arg==='object' && arg.source==='background.task'))backgroundErrors.push(args);
  originalConsoleError(...args);
};
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
  const kvMap=new Map();let failCompletion=false;let completionFailures=0;
  const deps={...runtime.deps,db,
    config:{environment:'test',relayfileInboundSecret:'fixture-only',workspaceDelivery:{resolve:async workspace=>{await Promise.resolve();resolves++;assert.equal(workspace.plan,'enterprise');return policies.get(workspace.id);}}},
    kv:{get:async k=>kvMap.get(k)??null,put:async(k,v)=>{if(failCompletion&&!k.endsWith(':lock')){completionFailures++;throw Error('fixture KV completion failure');}kvMap.set(k,v);},delete:async k=>{kvMap.delete(k);}},
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
    const ws=await seed('replay');const a=await send(ws,'once','recorded');expectStatus(a,201);
    const high=await scalar('SELECT sum(delivery_seq) FROM agents WHERE workspace_id=?',ws);
    const events=await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',ws);
    const b=await send(ws,'once','recorded');expectStatus(b,201);assert.deepEqual(b.body,a.body);
    expectStatus(await send(ws,'new','fresh'),429);
    assert.equal(await depth(ws),1);assert.equal(await scalar('SELECT sum(delivery_seq) FROM agents WHERE workspace_id=?',ws),high);
    assert.equal(await scalar('SELECT count(*) FROM pending_events WHERE workspace_id=?',ws),events);
    const rejected=await send(ws,'overflow','overflow',{session_ref:'must-rollback'});expectStatus(rejected,429);assert.equal(rejected.body.error.code,'workspace_delivery_depth_exceeded');assert.equal(rejected.retry,'30');
    assert.equal(await scalar('SELECT count(*) FROM message_sessions WHERE workspace_id=? AND session_ref=?',ws,'must-rollback'),0);
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1);
    const message=(await rows('SELECT id FROM messages WHERE workspace_id=?',ws))[0].id;
    await runAtomicWrites(db,tx=>[buildChannelDeliveryWrite(tx,{workspaceId:ws,messageId:message,channelId:ws+'ch',senderAgentId:ws+'sender',mode:'immediate',ttlMs:3600000,depthCap:1,rejectOnOverflow:true,workspacePolicy:{cap:1}})],{requireAtomic:true});
    await run("UPDATE deliveries SET status='acked' WHERE workspace_id=?",ws);
    await runAtomicWrites(db,tx=>[buildChannelDeliveryWrite(tx,{workspaceId:ws,messageId:message,channelId:ws+'ch',senderAgentId:ws+'sender',mode:'immediate',ttlMs:3600000,depthCap:1,rejectOnOverflow:true,workspacePolicy:{cap:1}})],{requireAtomic:true});
    assert.equal(await depth(ws),0);record('HTTP new key rejected, recorded replay, rollback, duplicate settled identity');
  }
  {
    const ws=await seed('all-routes',2,{cap:2});
    const group=await request(ws,'/v1/dm/group',{participants:['recipient-1','recipient-2']});expectStatus(group,201);
    const conv=group.body.data.id;
    const initial=await send(ws,'fill');expectStatus(initial,201);const message=initial.body.data.id;
    for(const [path,body] of [
      ['/v1/dm',{to:'recipient-1',text:'blocked'}],
      [`/v1/dm/${conv}/messages`,{text:'blocked'}],
      [`/v1/messages/${message}/replies`,{text:'blocked'}],
    ]){const r=await request(ws,path,body,{key:path});expectStatus(r,429);assert.equal(r.body.error.code,'workspace_delivery_depth_exceeded');assert.equal(r.retry,'30');}
    await run('INSERT INTO webhooks(id,workspace_id,channel_id,name,created_by,token_hash) VALUES(?,?,?,?,?,?)',ws+'hook',ws,ws+'ch','hook',ws+'sender',hash('hook-token'));
    const hook=await request(ws,`/v1/hooks/${ws}hook`,{text:'required'},{token:'hook-token'});expectStatus(hook,429);assert.equal(hook.body.error.code,'workspace_delivery_depth_exceeded');
    const body={eventId:'event-1',type:'file.created',path:'/fixture',provider:'github',snapshot:{content:'{"title":"required"}'}};
    const secret=await deriveRelayfileInboundSecret('fixture-only',{workspaceId:ws,channelId:ws+'ch',provider:'github',pathGlob:'/**'});
    const timestamp=String(Math.floor(Date.now()/1000));const signature=createHmac('sha256',secret).update(timestamp+'.'+JSON.stringify(body)).digest('hex');
    const relay=()=>request(ws,`/v1/integrations/relayfile/inbound/${ws}/${ws}ch?provider=github&path_glob=/**`,body,{headers:{'X-Relay-Timestamp':timestamp,'X-Relay-Signature':signature}});
    const lock=`idem:v1:${ws}:relayfile-inbound:${hash(`relayfile-inbound:${ws}ch`).slice(0,16)}:${hash('event-1')}:lock`;
    kvMap.set(lock,'1');const busy=await relay();expectStatus(busy,409);assert.equal(busy.retry,'1');kvMap.delete(lock);
    expectStatus(await relay(),429);
    await run("UPDATE deliveries SET status='acked' WHERE workspace_id=?",ws);
    // Integration system identity is not a member; sender now is a recipient too.
    policies.set(ws,{cap:3});expectStatus(await relay(),201);const n=await depth(ws);expectStatus(await relay(),201);assert.equal(await depth(ws),n);
    record('HTTP DM/group/thread/token hook/signed Relayfile async-only policy and same-event recovery');
  }
  {
    const ws=await seed('defer');expectStatus(await send(ws,'first'),201);
    const id=(await rows('SELECT id FROM deliveries WHERE workspace_id=?',ws))[0].id;
    await run("UPDATE deliveries SET status='failed' WHERE id=?",id);expectStatus(await send(ws,'refill'),201);
    const defer=()=>request(ws,`/v1/deliveries/${id}/defer`,{available_at:new Date(Date.now()+60000).toISOString()},{token:`at_live_${ws}r1`});
    expectStatus(await defer(),429);assert.equal((await rows('SELECT status FROM deliveries WHERE id=?',id))[0].status,'failed');
    await run("UPDATE deliveries SET status='acked' WHERE workspace_id=? AND id<>?",ws,id);expectStatus(await defer(),200);assert.equal(await depth(ws),1);expectStatus(await defer(),200);
    record('HTTP failed-row resurrection refused then admitted; active defer at cap');
  }
  {
    const ws=await seed('reserve',2,{cap:3,reserve:1});expectStatus(await send(ws,'broadcast'),201);expectStatus(await send(ws,'blocked'),429);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'targeted'}),201);assert.equal(await depth(ws),3);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-2',text:'no room'}),429);record('reserve carved inside cap');
  }
  {
    const ws=await seed('muted',2,{cap:1});await run('UPDATE channel_members SET is_muted=1 WHERE agent_id=?',ws+'r2');
    expectStatus(await send(ws,'optional muted'),201);assert.equal(await depth(ws),1);
    await run("UPDATE deliveries SET status='acked' WHERE workspace_id=?",ws);
    expectStatus(await send(ws,'@recipient-2 required mention'),429);assert.equal(await depth(ws),0);
    record('recipient relation excludes mute unless mentioned; whole-request rejection');
  }
  {
    const ws=await seed('a2a-ingress');
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url) VALUES(?,?,?,?)',ws+'a2a',ws,ws+'sender','https://example.com/a2a');
    await run('UPDATE a2a_agents SET agent_card=? WHERE workspace_id=?',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1.0.0',skills:[{name:'message'}]}),ws);
    const payload={jsonrpc:'2.0',id:'rpc-1',method:'message/send',params:{target_agent:'recipient-1',message:{message_id:'remote-1',role:'agent',parts:[{kind:'text',text:'inbound'}]}}};
    expectStatus(await request(ws,'/a2a/rpc',payload),200);
    expectStatus(await request(ws,'/a2a/rpc',payload),200);
    payload.id='rpc-2';payload.params.message.message_id='remote-2';
    const rpc=await request(ws,'/a2a/rpc',payload);expectStatus(rpc,429);assert.equal(rpc.body.error.data.code,'workspace_delivery_depth_exceeded');assert.equal(rpc.retry,'30');
    const hook=await request(ws,`/a2a/webhook/${ws}/sender`,payload);expectStatus(hook,429);assert.equal(hook.body.error.data.code,'workspace_delivery_depth_exceeded');
    assert.equal(await depth(ws),1);
    await run("UPDATE deliveries SET status='acked' WHERE workspace_id=?",ws);
    expectStatus(await request(ws,`/a2a/webhook/${ws}/sender`,payload),200);
    expectStatus(await request(ws,`/a2a/webhook/${ws}/sender`,payload),200);assert.equal(await depth(ws),1);
    record('both actual A2A HTTP ingress paths; recorded RPC and webhook replays at cap');
  }
  {
    const ws=await seed('a2a-egress');
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url) VALUES(?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a');
    await run('UPDATE a2a_agents SET agent_card=? WHERE workspace_id=?',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1.0.0',skills:[{name:'message'}]}),ws);
    let calls=0;const payloads=[];
    globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;const payload=JSON.parse(init.body);payloads.push(payload);assert.equal(await depth(ws),1);assert.equal(await scalar('SELECT count(*) FROM a2a_egress WHERE workspace_id=?',ws),1);return Response.json({jsonrpc:'2.0',id:payload.id,result:{}});};
    const sendE=(text,key)=>request(ws,'/v1/dm',{to:'recipient-1',text},{key});
    const simultaneous=await Promise.all([sendE('one','one'),sendE('two','two')]);assert.deepEqual(simultaneous.map(x=>x.status).sort(),[201,429]);assert.equal(calls,1);assert.equal(await depth(ws),1);
    const winner=simultaneous[0].status===201?'one':'two';expectStatus(await sendE(winner,winner),201);assert.equal(calls,1);
    kvMap.clear();failCompletion=true;expectStatus(await sendE(winner,winner),201);assert.ok(completionFailures>0,'injected KV completion write actually failed');failCompletion=false;assert.equal(calls,1);
    globalThis.fetch=originalFetch;record('concurrent A2A overflow: one admitted, one transport; durable replay survives lost KV',{calls});
  }
  {
    const ws=await seed('a2a-failure');
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url) VALUES(?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a');
    await run('UPDATE a2a_agents SET agent_card=? WHERE workspace_id=?',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1.0.0',skills:[{name:'message'}]}),ws);
    let calls=0;const ids=[];let fail=true;
    globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;const p=JSON.parse(init.body);ids.push(p.params.message.message_id);return fail?new Response('unavailable',{status:503}):Response.json({jsonrpc:'2.0',id:p.id,result:{}});};
    const r=await request(ws,'/v1/dm',{to:'recipient-1',text:'durable'},{key:'retry'});expectStatus(r,502);assert.equal(calls,3);assert.equal(await depth(ws),1);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'new'},{key:'new'}),429);assert.equal(calls,3);
    await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',ws);fail=false;
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'durable'},{key:'retry'}),201);assert.equal(calls,4);assert.equal(new Set(ids).size,1);assert.equal(await depth(ws),1);
    globalThis.fetch=originalFetch;record('transport failure retains accepted intent; retry at cap reuses message identity',{calls});
  }
  {
    for(const concurrent of [false,true]){
      const ws=await seed('large-'+concurrent,4889,{cap:5000});
      const metricsStart=d1Metrics.length;
      const query=buildChannelDeliveryWrite(db,{workspaceId:ws,messageId:'plan-only',channelId:ws+'ch',senderAgentId:ws+'sender',mode:'immediate',ttlMs:3600000,depthCap:1000,workspacePolicy:{cap:5000}}).toSQL();
      const plan=await rows('EXPLAIN QUERY PLAN '+query.sql,...query.params);
      assert.ok(plan.some(row=>String(row.detail).includes('MATERIALIZE capacity_candidates')));assert.ok(plan.some(row=>String(row.detail).includes('MATERIALIZE capacity_admission')));
      const a=concurrent?null:await send(ws,'large A');if(a)expectStatus(a,201);
      const attempts=concurrent?await Promise.all([send(ws,'large A'),send(ws,'large B')]):[a,await send(ws,'large B')];
      assert.deepEqual(attempts.map(x=>x.status).sort(),[201,429]);assert.equal(await depth(ws),4889);
      assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),1);
      assert.equal(await scalar('SELECT sum(delivery_seq) FROM agents WHERE workspace_id=?',ws),4889);
      record('HTTP 4889-recipient '+(concurrent?'concurrent':'sequential')+' atomic overflow',{depth:4889,binds:query.params.length,plan:plan.map(row=>row.detail),d1BatchMetrics:adapter==='workerd-d1'?d1Metrics.slice(metricsStart).map(meta=>({rows_read:meta.rows_read,rows_written:meta.rows_written})):undefined});
    }
    const ws=await seed('oversized',5001,{cap:5000});expectStatus(await send(ws,'too many'),429);assert.equal(await depth(ws),0);assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),0);
    record('HTTP single 5001-recipient message fully refused');
    const pre=await seed('preexisting58',4889,{cap:5000});
    await run("INSERT INTO channels(id,workspace_id,name) VALUES(?,?,'prior')",pre+'prior',pre);
    await run('INSERT INTO channel_members(channel_id,agent_id) SELECT ?,id FROM agents WHERE workspace_id=? AND id<>? LIMIT 58',pre+'prior',pre,pre+'sender');
    await run('INSERT INTO channel_members(channel_id,agent_id) VALUES(?,?)',pre+'prior',pre+'sender');
    expectStatus(await request(pre,'/v1/channels/prior/messages',{text:'58 preexisting'}),201);assert.equal(await depth(pre),58);
    const prefills=await Promise.all([send(pre,'large A'),send(pre,'large B')]);assert.deepEqual(prefills.map(r=>r.status).sort(),[201,429]);assert.equal(await depth(pre),4947);
    record('HTTP concurrent 4889 fanouts after 58 accepted preexisting rows',{depth:4947});
  }
  {
    const ws=await seed('required-mailbox',2,{cap:10});deps.config.mailbox={depthCap:1,deliveryTtlMs:3600000};
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'full mailbox'}),201);
    await run('INSERT INTO webhooks(id,workspace_id,channel_id,name,created_by,token_hash) VALUES(?,?,?,?,?,?)',ws+'hook',ws,ws+'ch','hook',ws+'sender',hash('hook-token'));
    const before=await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws);
    const hook=await request(ws,`/v1/hooks/${ws}hook`,{text:'required atomic'},{token:'hook-token'});expectStatus(hook,503);assert.equal(hook.body.error.code,'mailbox_full');assert.equal(hook.retry,'30');
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),before);assert.equal(await depth(ws),1);
    expectStatus(await send(ws,'ordinary mailbox rejection'),201);assert.equal(await depth(ws),2);
    deps.config.mailbox=undefined;record('required mailbox overflow remains distinct 503; optional mailbox rejection preserved');
  }
  {
    const ws=await seed('restore-race',2,{cap:2});expectStatus(await send(ws,'two rows'),201);
    await run("UPDATE deliveries SET status='failed' WHERE workspace_id=?",ws);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'refill one'}),201);
    const failed=await rows("SELECT id,agent_id FROM deliveries WHERE workspace_id=? AND status='failed'",ws);
    const restore=async row=>request(ws,`/v1/deliveries/${row.id}/defer`,{available_at:'2027-01-01T00:00:00Z'},{token:'at_live_'+row.agent_id});
    const attempts=await Promise.all(failed.map(restore));assert.deepEqual(attempts.map(x=>x.status).sort(),[200,429]);assert.equal(await depth(ws),2);
    const remaining=(await rows("SELECT id,agent_id FROM deliveries WHERE workspace_id=? AND status='failed'",ws))[0];
    await run('UPDATE deliveries SET expires_at=unixepoch()-1 WHERE id=?',remaining.id);expectStatus(await restore(remaining),200);assert.equal(await depth(ws),2);
    record('concurrent failed-row resurrection cannot overbook; expired zero-growth defer allowed');
  }
  {
    const ws=await seed('zero-growth',1,{cap:1});
    const dm=await request(ws,'/v1/dm',{to:'recipient-1',text:'original'});expectStatus(dm,201);
    await runAtomicWrites(db,tx=>[buildDirectDeliveryWrite(tx,{workspaceId:ws,messageId:dm.body.data.id,agentId:ws+'r1',deliveryId:'different-random-id',mode:'immediate',reason:'dm',ttlMs:3600000,depthCap:100,workspacePolicy:{cap:1}})],{requireAtomic:true});
    assert.equal(await depth(ws),1);expectStatus(await request(ws,'/v1/dm',{to:'@self',text:'no growth'}),201);assert.equal(await depth(ws),1);
    const group=await request(ws,'/v1/dm/group',{participants:['recipient-1']});expectStatus(group,201);
    await run('UPDATE dm_participants SET left_at=unixepoch() WHERE conversation_id=? AND agent_id=?',group.body.data.id,ws+'r1');
    expectStatus(await request(ws,`/v1/dm/${group.body.data.id}/messages`,{text:'no active recipients'}),201);assert.equal(await depth(ws),1);
    record('direct duplicate with alternate id, self-DM, and left-group zero growth at cap');
  }
  {
    const ws=await seed('late-rollback',1,{cap:1});
    await run("INSERT INTO files(id,workspace_id,uploaded_by,filename,content_type,size_bytes,storage_key,status) VALUES(?,?,?,'fixture','text/plain',1,'fixture','complete')",ws+'file',ws,ws+'sender');
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    await run("CREATE TRIGGER fixture_late_abort BEFORE INSERT ON message_logs WHEN NEW.workspace_id = '"+ws+"' BEGIN SELECT RAISE(ABORT, 'fixture later write failure'); END");
    const r=await request(ws,'/v1/dm',{to:'recipient-1',text:'rollback all',attachments:[ws+'file'],data:{session_ref:'rolled-back'}},{key:'later-failure'});expectStatus(r,500);
    for(const table of ['messages','message_sessions','message_logs','a2a_egress','deliveries'])assert.equal(await scalar(`SELECT count(*) FROM ${table} WHERE workspace_id=?`,ws),0,table);
    assert.equal(await scalar('SELECT count(*) FROM message_attachments WHERE file_id=?',ws+'file'),0);assert.equal(await scalar('SELECT sum(delivery_seq) FROM agents WHERE workspace_id=?',ws),0);assert.equal(calls,0);
    await run('DROP TRIGGER fixture_late_abort');
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'rollback all',attachments:[ws+'file'],data:{session_ref:'rolled-back'}},{key:'later-failure'}),201);assert.equal(calls,1);
    globalThis.fetch=originalFetch;record('HTTP late write failure rolls back intent/message/attachments/session/log/sequence before transport');
  }
  {
    const ws=await seed('lease',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;let entered;const started=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);
    globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;entered();await gate;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const noKv=createEngine({...deps,kv:undefined});
    const first=request(ws,'/v1/dm',{to:'recipient-1',text:'same'},{key:'same',engineApp:noKv});await started;
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'same'},{key:'same',engineApp:noKv}),409);assert.equal(calls,1);release();expectStatus(await first,201);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'same'},{key:'same',engineApp:noKv}),201);assert.equal(calls,1);assert.equal(await depth(ws),1);
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'different'},{key:'same',engineApp:noKv}),409);assert.equal(calls,1);
    globalThis.fetch=originalFetch;record('HTTP concurrent same-key transport lease without KV; mismatch refused',{calls});
  }
  {
    const ws=await seed('egress-recovery',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;const payloads=[];
    globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;payloads.push(JSON.parse(init.body));return Response.json({jsonrpc:'2.0',id:payloads.at(-1).id,result:{}});};
    await run("CREATE TRIGGER fixture_settle_abort BEFORE UPDATE ON a2a_egress WHEN NEW.workspace_id = '"+ws+"' AND NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'fixture settlement failure'); END");
    expectStatus(await request(ws,'/v1/dm',{to:'recipient-1',text:'accepted remotely'},{key:'recover'}),500);assert.equal(calls,1);assert.equal(await depth(ws),1);
    assert.equal(await scalar('SELECT messages_sent FROM a2a_agents WHERE workspace_id=?',ws),0);
    await run('DROP TRIGGER fixture_settle_abort');await run('UPDATE a2a_egress SET lease_until=0 WHERE workspace_id=?',ws);
    assert.deepEqual(await sweepPendingA2aEgress(db),{attempted:1,failed:0});assert.equal(calls,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(await scalar('SELECT messages_sent FROM a2a_agents WHERE workspace_id=?',ws),1);
    assert.deepEqual(await sweepPendingA2aEgress(db),{attempted:0,failed:0});assert.equal(calls,2);
    globalThis.fetch=originalFetch;record('post-transport settlement failure recovers same payload; counter settles once',{calls,remoteExactlyOnce:false});
  }
  {
    const ws=await seed('egress-rejected',1,{cap:1});
    await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'a2a',ws,ws+'r1','https://example.com/a2a',JSON.stringify({name:'fixture',url:'https://example.com/a2a',version:'1',skills:[{name:'message'}]}));
    let calls=0;globalThis.fetch=async(url,init)=>{if(String(url)!=='https://example.com/a2a')return originalFetch(url,init);calls++;return new Response('refused',{status:403});};
    const sendRejected=()=>request(ws,'/v1/dm',{to:'recipient-1',text:'terminal'},{key:'terminal'});
    expectStatus(await sendRejected(),403);expectStatus(await sendRejected(),403);assert.equal(calls,1);
    assert.deepEqual(await sweepPendingA2aEgress(db),{attempted:0,failed:0});assert.equal(await depth(ws),1);
    globalThis.fetch=originalFetch;record('permanent upstream rejection retains accepted intent and original status without retry',{calls});
  }
  {
    const ws=await seed('unsupported',1,{cap:1});
    const bare=new Proxy(db,{get(target,key){if(key==='withTransaction'||key==='batch')return undefined;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const bareApp=createEngine({...deps,db:bare});expectStatus(await request(ws,'/v1/channels/general/messages',{text:'cannot commit'},{engineApp:bareApp}),500);
    assert.equal(await scalar('SELECT count(*) FROM messages WHERE workspace_id=?',ws),0);assert.equal(await depth(ws),0);record('unsupported atomic adapter fails before message write');
  }
  // waitUntil receives caught best-effort tasks; SQL/delivery assertions above, not settlement, prove effects.
  await Promise.allSettled(background);assert.equal(backgroundErrors.length,0,'background route failures must remain visible');assert.ok(resolves>0);
 }
 for(const cap of [0,-1,NaN,Infinity,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap,reserve:0})}},{id:'ws'}));
 for(const reserve of [-1,NaN,0.5])await assert.rejects(()=>resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve})}},{id:'ws'}));
 assert.deepEqual(await resolveWorkspaceDeliveryPolicyFor({workspaceDelivery:{resolve:async()=>({cap:10,reserve:20})}},{id:'ws'}),{cap:10,reserve:9});
 assert.deepEqual(resolveWorkspaceDeliveryPolicy({workspaceDelivery:{cap:10,reserve:4,workspaces:{ws:{reserve:0}}}},'ws'),{cap:10,reserve:0});
 results.push({test:'dynamic validation and static explicit reserve zero'});
 writeFileSync(process.env.CAPACITY_RESULTS??'/tmp/finn-capacity-http-results.json',JSON.stringify({results},null,2)+'\n');console.log(`PASS ${results.length} scenario records`);
}finally{console.error=originalConsoleError;globalThis.fetch=originalFetch;await mf.dispose();for(const r of runtimes)r.close();}
