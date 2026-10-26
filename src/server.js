import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalize, soap, namespace, navUrl, parseNavResponse } from './core.js';

export function createService(config) {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(config.token ?? '') || !/^\d{5,10}$/.test(config.shortcode ?? '')) throw new Error('Set CALLBACK_TOKEN (32+ random characters) and MPESA_SHORTCODE');
  if (config.forward) {
    navUrl(config.navUrl, config.allowedHttpOrigin);
    if (!config.username || !config.password) throw new Error('Missing NAV credentials');
  }
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS receipts (
      receipt TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', received TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    UPDATE receipts SET state='uncertain' WHERE state='sending';
    CREATE TABLE IF NOT EXISTS nav_attempts (
      id INTEGER PRIMARY KEY, receipt TEXT NOT NULL, http_status INTEGER,
      response_code TEXT, outcome TEXT NOT NULL, detail TEXT NOT NULL,
      attempted TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const reply = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return reply(res,200,{status:'ok'});
    const base = `/mpesa/c2b/${config.token}`;
    if (![`${base}/validation`,`${base}/confirmation`].includes(req.url)) return reply(res,404,{error:'Not found'});
    if (req.method !== 'POST') return reply(res,405,{error:'POST required'});
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res,415,{error:'JSON required'});
    let payload;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32768) { reply(res,413,{error:'Payload too large'}); return; }
        chunks.push(chunk);
      }
      payload = normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.shortcode);
    } catch { return reply(res,400,{ResultCode:'C2B00011',ResultDesc:'Invalid payment payload'}); }
    if (req.url.endsWith('/validation')) return reply(res,200,config.acceptAll
      ? {ResultCode:0,ResultDesc:'Accepted'} : {ResultCode:'C2B00012',ResultDesc:'Account validation unavailable'});
    try {
      const serialized = JSON.stringify(payload);
      const hash = createHash('sha256').update(serialized).digest('hex');
      const existing = db.prepare('SELECT hash FROM receipts WHERE receipt=?').get(payload.receiptNo);
      if (existing && existing.hash !== hash) return reply(res,409,{error:'Receipt payload conflict'});
      if (!existing) db.prepare('INSERT INTO receipts(receipt,hash,payload) VALUES(?,?,?)').run(payload.receiptNo,hash,serialized);
      return reply(res,200,{ResultCode:0,ResultDesc:'Accepted'});
    } catch { return reply(res,503,{error:'Storage unavailable'}); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let busy = false;
  async function forwardOne() {
    if (!config.forward || busy) return;
    const row = db.prepare("SELECT * FROM receipts WHERE state='pending' ORDER BY received LIMIT 1").get();
    if (!row) return;
    busy = true;
    try {
      db.prepare("UPDATE receipts SET state='sending',updated=CURRENT_TIMESTAMP WHERE receipt=?").run(row.receipt);
      const response = await fetch(config.navUrl, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${namespace}:ReceiveMPESATransaction"`,Authorization:`Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`},
        body:soap(JSON.parse(row.payload))
      });
      const body = await response.text();
      const result = parseNavResponse(body,response.ok);
      db.prepare('INSERT INTO nav_attempts(receipt,http_status,response_code,outcome,detail) VALUES(?,?,?,?,?)').run(row.receipt,response.status,result.code,result.ok ? 'delivered' : 'uncertain',result.detail);
      db.prepare('UPDATE receipts SET state=?,updated=CURRENT_TIMESTAMP WHERE receipt=?').run(result.ok ? 'delivered' : 'uncertain',row.receipt);
    } catch (error) {
      db.prepare('INSERT INTO nav_attempts(receipt,outcome,detail) VALUES(?,?,?)').run(row.receipt,'uncertain',error?.name === 'TimeoutError' ? 'NAV request timed out' : 'Transport or processing failure');
      db.prepare("UPDATE receipts SET state='uncertain',updated=CURRENT_TIMESTAMP WHERE receipt=?").run(row.receipt);
    } finally { busy = false; }
  }
  const timer = setInterval(() => { forwardOne().catch(() => console.error('NAV worker failed; inspect receipt states')); },1000);
  timer.unref();
  return {server,db,forwardOne,close:async () => {clearInterval(timer); await new Promise(resolve => server.close(resolve)); while(busy) await new Promise(resolve => setTimeout(resolve,50)); db.close();}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  const service = createService({token:e.CALLBACK_TOKEN,shortcode:e.MPESA_SHORTCODE,dbPath:e.DB_PATH || './data/callbacks.sqlite',acceptAll:e.ACCEPT_ALL_REFERENCES === 'true',forward:e.NAV_FORWARDING_ENABLED === 'true',navUrl:e.NAV_URL,allowedHttpOrigin:e.NAV_ALLOWED_HTTP_ORIGIN,username:e.NAV_USERNAME,password:e.NAV_PASSWORD_BASE64 ? Buffer.from(e.NAV_PASSWORD_BASE64,'base64').toString('utf8') : e.NAV_PASSWORD});
  service.server.listen(Number(e.PORT || 3087),e.HOST || '127.0.0.1',() => console.log('C2B listener started'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => service.close().then(() => process.exit(0)));
}
