import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { normalize, soap, navUrl, parseNavResponse } from '../src/core.js';
import { createService } from '../src/server.js';
const payload = {TransID:'TEST123456',TransactionType:'Pay Bill',TransTime:'20261026113045',TransAmount:'150.00',BusinessShortCode:'600000',BillRefNumber:'MEMBER<&1',MSISDN:'2547******12',FirstName:'TEST'};
test('C2B fields map to WSDL, XML is escaped and date uses Nairobi time', () => {
  const mapped = normalize(payload,'600000');
  assert.equal(Object.keys(mapped).length,12);
  assert.equal(mapped.transactionTime,'2026-10-26T11:30:45+03:00');
  assert.equal(mapped.postingDate,'2026-10-26');
  assert.equal(mapped.middleName,'');
  assert.match(soap(mapped),/MEMBER&lt;&amp;1/);
  assert.throws(() => normalize({...payload,TransTime:'20260230113045'},'600000'));
  assert.throws(() => normalize(payload,'600001'));
  assert.throws(() => navUrl('http://158.220.121.153:3057/'));
  assert.equal(navUrl('http://158.220.121.153:3057/Tunder/', 'http://158.220.121.153:3057').hostname,'158.220.121.153');
  assert.throws(() => navUrl('http://158.220.121.153:3058/', 'http://158.220.121.153:3057'));
  assert.throws(() => navUrl('http://example.com/', 'http://158.220.121.153:3057'));
  assert.equal(navUrl('http://127.0.0.1:3057/').protocol,'http:');
});
test('callbacks persist, deduplicate, reject conflicts and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tunde-test-'));
  const config = {token:'a'.repeat(64),shortcode:'600000',dbPath:join(dir,'inbox.sqlite'),forward:false,acceptAll:true};
  let service = createService(config);
  try {
    await new Promise(resolve => service.server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${service.server.address().port}/mpesa/c2b/${config.token}`;
    const post = (path,data) => fetch(base + path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await post('/validation',payload)).status,200);
    assert.equal(service.db.prepare('SELECT count(*) n FROM receipts').get().n,0);
    assert.equal((await post('/confirmation',payload)).status,200);
    assert.equal((await post('/confirmation',payload)).status,200);
    assert.equal(service.db.prepare('SELECT count(*) n FROM receipts').get().n,1);
    assert.equal((await post('/confirmation',{...payload,TransAmount:'200'})).status,409);
    assert.equal((await post('/confirmation',{...payload,BusinessShortCode:'600001'})).status,400);
    await service.close();
    service = createService(config);
    assert.equal(service.db.prepare('SELECT state FROM receipts').get().state,'pending');
    service.db.exec("UPDATE receipts SET state='sending'");
    await service.close();
    service = createService(config);
    assert.equal(service.db.prepare('SELECT state FROM receipts').get().state,'uncertain');
  } finally { await service.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('NAV response loss is quarantined without automatic duplicate posting', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tunde-test-'));
  const service = createService({token:'b'.repeat(64),shortcode:'600000',dbPath:join(dir,'inbox.sqlite'),forward:true,navUrl:'http://127.0.0.1:1/',username:'test',password:'test'});
  try {
    service.db.prepare('INSERT INTO receipts(receipt,hash,payload) VALUES(?,?,?)').run(payload.TransID,'test',JSON.stringify(normalize(payload,'600000')));
    await service.forwardOne();
    assert.equal(service.db.prepare('SELECT state FROM receipts').get().state,'uncertain');
    await service.forwardOne();
    assert.equal(service.db.prepare('SELECT state FROM receipts').get().state,'uncertain');
  } finally {await service.close(); rmSync(dir,{recursive:true,force:true});}
});
test('successful SOAP delivery authenticates and marks receipt delivered once', async () => {
  let calls = 0;
  const nav = http.createServer(async (req,res) => {
    calls++;
    assert.equal(req.headers.authorization,`Basic ${Buffer.from('test:password').toString('base64')}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.match(body,/<receiptNo>TEST123456<\/receiptNo>/);
    assert.match(body,/<postingDate>2026-10-26<\/postingDate><responseCode><\/responseCode>/);
    res.writeHead(200,{'Content-Type':'text/xml'});
    res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ReceiveMPESATransaction_Result xmlns="urn:microsoft-dynamics-schemas/codeunit/MPESAManagementB2C"><responseCode>00</responseCode></ReceiveMPESATransaction_Result></s:Body></s:Envelope>');
  });
  await new Promise(resolve => nav.listen(0,'127.0.0.1',resolve));
  const dir = mkdtempSync(join(tmpdir(),'tunde-test-'));
  const service = createService({token:'c'.repeat(64),shortcode:'600000',dbPath:join(dir,'inbox.sqlite'),forward:true,navUrl:`http://127.0.0.1:${nav.address().port}/`,username:'test',password:'password'});
  try {
    service.db.prepare('INSERT INTO receipts(receipt,hash,payload) VALUES(?,?,?)').run(payload.TransID,'test',JSON.stringify(normalize(payload,'600000')));
    await service.forwardOne();
    await service.forwardOne();
    assert.equal(service.db.prepare('SELECT state FROM receipts').get().state,'delivered');
    assert.equal(calls,1);
    assert.equal(service.db.prepare('SELECT response_code FROM nav_attempts').get().response_code,'00');
  } finally {await service.close(); await new Promise(resolve => nav.close(resolve)); rmSync(dir,{recursive:true,force:true});}
});
test('NAV requires exact 00 inside the SOAP result and rejects faults or missing codes', () => {
  const wrap = inner => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
  const result = value => wrap(`<n:ReceiveMPESATransaction_Result xmlns:n="urn:microsoft-dynamics-schemas/codeunit/MPESAManagementB2C"><n:responseCode>${value}</n:responseCode></n:ReceiveMPESATransaction_Result>`);
  assert.equal(parseNavResponse(result('00'),true).ok,true);
  for (const value of ['0','01','', '000']) assert.equal(parseNavResponse(result(value),true).ok,false);
  assert.equal(parseNavResponse(result('00'),false).ok,false);
  assert.equal(parseNavResponse(wrap('<ReceiveMPESATransaction_Result/>'),true).ok,false);
  assert.equal(parseNavResponse(wrap('<Fault><faultstring>Missing parameter</faultstring></Fault>'),true).detail,'Missing parameter');
  assert.equal(parseNavResponse('<broken>',true).ok,false);
  assert.equal(parseNavResponse(wrap('<responseCode>00</responseCode>'),true).ok,false);
  assert.equal(parseNavResponse(wrap('<ReceiveMPESATransaction_Result><responseCode>00</responseCode><responseCode>01</responseCode></ReceiveMPESATransaction_Result>'),true).ok,false);
});
