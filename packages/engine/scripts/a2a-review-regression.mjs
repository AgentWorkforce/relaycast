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
      assert.equal(String(url),targetUrl);calls++;captures.push({url:String(url),auth:init.headers.authorization,payload:JSON.parse(init.body)});if(!healthy)throw Error('fixture-old transport outage');return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{}});};
    const unavailable=await retry();expectStatus(unavailable,502);assert.equal(unavailable.body.error.code,'a2a_transport_unavailable');
    const intent=()=>rows('SELECT * FROM a2a_egress WHERE workspace_id=?',ws).then(r=>r[0]);
    assert.ok(!(await intent()).last_error.includes('fixture-old'));
    return {ws,retry,intent,captures,localReceipts,calls:()=>calls,healthy:()=>{healthy=true;}};
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
    for(const malformed of ['json','schema']){
      const ws=await seed('protocol-'+malformed,1,{cap:100});
      await run('INSERT INTO a2a_agents(id,workspace_id,relay_agent_id,external_url,agent_card) VALUES(?,?,?,?,?)',ws+'peer',ws,ws+'r1',targetUrl,JSON.stringify({name:'fixture',url:targetUrl,version:'1',skills:[{name:'message'}]}));
      let calls=0;globalThis.fetch=async()=>{calls++;return malformed==='json'?new Response('{broken'):Response.json({jsonrpc:'bad-protocol'});};
      const noKv=createEngine({...deps,kv:undefined});
      await request(ws,'/v1/dm',{to:'recipient-1',text:'accepted terminal response'},{key:'protocol',engineApp:noKv});
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
