import { XMLParser, XMLValidator } from 'fast-xml-parser';
export const namespace = 'urn:microsoft-dynamics-schemas/codeunit/MPESAManagementB2C';
export function normalize(p, shortcode) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid payload');
  for (const field of ['TransID', 'TransactionType', 'TransTime', 'TransAmount', 'BusinessShortCode', 'BillRefNumber']) {
    if (typeof p[field] !== 'string' || p[field].length > 256) throw new Error(`Invalid ${field}`);
  }
  if (!/^[A-Z0-9]{6,32}$/.test(p.TransID)) throw new Error('Invalid receipt');
  if (!shortcode || p.BusinessShortCode !== shortcode) throw new Error('Wrong shortcode');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(p.TransAmount) || Number(p.TransAmount) <= 0) throw new Error('Invalid amount');
  if (!/^\d{14}$/.test(p.TransTime)) throw new Error('Invalid transaction time');
  const t = p.TransTime;
  const local = `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}`;
  const parsed = new Date(local + 'Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,19) !== local) throw new Error('Invalid date');
  const optional = name => {
    const value = p[name] ?? '';
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${name}`);
    return value;
  };
  if (/[\x00-\x1f]/.test(p.BillRefNumber)) throw new Error('Invalid reference');
  return {
    receiptNo: p.TransID, transactionType: p.TransactionType,
    transactionTime: local + '+03:00', transactionAmount: Number(p.TransAmount).toFixed(2),
    paybillCode: p.BusinessShortCode, accountCode: p.BillRefNumber,
    phoneNo: optional('MSISDN'), firstName: optional('FirstName'),
    middleName: optional('MiddleName'), lastName: optional('LastName'),
    customerDetails: '', postingDate: local.slice(0,10)
  };
}
export function soap(transaction) {
  const escape = value => String(value).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ReceiveMPESATransaction xmlns="${namespace}">${Object.entries({...transaction,responseCode:''}).map(([k,v]) => `<${k}>${escape(v)}</${k}>`).join('')}</ReceiveMPESATransaction></s:Body></s:Envelope>`;
}
export function parseNavResponse(body, httpOk) {
  if (body.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) return {ok:false,code:null,detail:'Invalid SOAP XML'};
  try {
    const parsed = new XMLParser({removeNSPrefix:true,parseTagValue:false,trimValues:true,processEntities:false}).parse(body);
    const soapBody = parsed?.Envelope?.Body;
    if (!soapBody || Array.isArray(soapBody)) return {ok:false,code:null,detail:'Missing SOAP body'};
    if (Object.hasOwn(soapBody,'Fault')) {
      const fault = soapBody.Fault?.faultstring;
      return {ok:false,code:null,detail:typeof fault === 'string' ? fault.slice(0,1000) : 'SOAP fault'};
    }
    const result = soapBody.ReceiveMPESATransaction_Result;
    const code = !Array.isArray(result) && typeof result?.responseCode === 'string' ? result.responseCode : null;
    return {ok:httpOk && code === '00',code,detail:!httpOk ? 'HTTP failure' : code === '00' ? 'Accepted' : code === null ? 'Missing responseCode' : 'NAV returned non-success responseCode'};
  } catch { return {ok:false,code:null,detail:'Invalid SOAP response'}; }
}
export function navUrl(value, allowedHttpOrigin = '') {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.origin === allowedHttpOrigin))) throw new Error('NAV requires HTTPS, loopback HTTP, or an explicitly authorized HTTP origin');
  if (url.username || url.password) throw new Error('Do not embed credentials in NAV URL');
  return url;
}
