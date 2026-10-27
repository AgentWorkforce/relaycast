// Real isolated TLS origin and HTTP/TLS redirect sinks. Only this test dispatcher
// trusts the generated certificate and resolves sink.example to loopback.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { pathToFileURL } from 'node:url';
import { Agent, fetch as networkFetch } from 'undici';
const { sendToExternalAgent } = await import(process.env.REDIRECT_ENGINE_MODULE ? pathToFileURL(process.env.REDIRECT_ENGINE_MODULE).href : '../dist/engine/a2a.js');
const dir=mkdtempSync(join(tmpdir(),'a2a-redirect-'));
writeFileSync(join(dir,'cert.cnf'),'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,DNS:sink.example,IP:127.0.0.1\n');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'cert.cnf'),'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
const tls={key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))};
const dispatcher=new Agent({connect:{ca:tls.cert,lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)}});
const sinks=[],origins=[];let location='',status=307;
const collect=async(req,list)=>{let body='';for await(const chunk of req)body+=chunk;list.push({headers:req.headers,body});};
const sinkHandler=async(req,res)=>{await collect(req,sinks);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:'redirect-proof',result:{}}));};
const httpSink=httpServer(sinkHandler),tlsSink=httpsServer(tls,sinkHandler);
const origin=httpsServer(tls,async(req,res)=>{await collect(req,origins);res.writeHead(status,{location});res.end();});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
const originalFetch=globalThis.fetch;const results=[],failures=[];
try {
 await Promise.all([listen(origin),listen(httpSink),listen(tlsSink)]);
 const originUrl=`https://127.0.0.1:${origin.address().port}/redirect`;
 const destinations={http:`http://127.0.0.1:${httpSink.address().port}/downgrade`,private:`https://127.0.0.1:${tlsSink.address().port}/private`,cross_origin:`https://sink.example:${tlsSink.address().port}/cross`};
 for(const code of [307,308])for(const [destination,url] of Object.entries(destinations))for(const scheme of ['bearer','api_key','none']){
   status=code;location=url;origins.length=0;sinks.length=0;let options,validations=0,error;
   globalThis.fetch=(target,init)=>{assert.equal(target,'https://peer.example/a2a');options=init;return networkFetch(originUrl,{...init,dispatcher});};
   const payload={jsonrpc:'2.0',id:'redirect-proof',method:'message/send',params:{message:{message_id:'stable-body-id',role:'agent',parts:[{kind:'text',text:'fixture-private-body'}]}}};
   try {await sendToExternalAgent('https://peer.example/a2a',payload,undefined,async()=>{validations++;return {scheme,credential:scheme==='none'?null:'fixture-secret'};},'a2ae_redirect-proof');}catch(e){error=e;}
   const record={code,destination,scheme,redirect:options?.redirect,originRequests:origins.length,sinkRequests:sinks.length,forwardedCredential:sinks.some(x=>x.headers.authorization||x.headers['x-api-key']),forwardedBody:sinks.some(x=>x.body.includes('fixture-private-body')),errorCode:error?.code,errorStatus:error?.status,retryable:error?.retryable,validations};
   results.push(record);console.log(JSON.stringify(record));
   if(options?.redirect!=='manual'||origins.length!==1||sinks.length!==0||error?.code!=='a2a_redirect_forbidden'||error?.status!==502||error?.retryable!==false||validations!==1)failures.push(record);
   assert.equal(origins[0].body,JSON.stringify(payload));assert.equal(origins[0].headers['idempotency-key'],'a2ae_redirect-proof');
 }
 if(process.env.CAPACITY_RESULTS)writeFileSync(process.env.CAPACITY_RESULTS,JSON.stringify({results},null,2)+'\n');
 assert.deepEqual(failures,[],'redirects must be terminal before any credential/body reaches a redirected sink');
 console.log('PASS 18 real TLS redirect controls; no forwarded credentials/body and no automatic retry');
} finally {globalThis.fetch=originalFetch;await dispatcher.close();await Promise.all([close(origin),close(httpSink),close(tlsSink)]);rmSync(dir,{recursive:true,force:true});}
