/*
 * e2e-patch.mts — drive /api/patch against a running DEVELOPMENT server the
 * way the browser does, with a real file, and check the things the browser
 * cannot show: the credit reservation, the quota refusal, the bounded body,
 * and the refusal of a file whose header asks for the impossible.
 *
 *   npx tsx --conditions=react-server scripts/e2e-patch.mts http://localhost:3001 <email>
 *
 * Needs a development server (the sign-in code comes back in the response
 * there). The account must have a plan with a daily cap; the script patches
 * until the cap refuses it, so run it on a throwaway account.
 */
import fs from 'node:fs';
import http from 'node:http';
import { scanFile } from '../src/lib/mp4/scan';

const base = process.argv[2] ?? 'http://localhost:3001';
const email = process.argv[3];
if (!email) { console.error('usage: e2e-patch.mts <base> <email>'); process.exit(2); }

let pass = 0, failCount = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) pass++; else failCount++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ---- sign in ------------------------------------------------------------ */
const json = { 'content-type': 'application/json', origin: base };
const r1 = await fetch(`${base}/api/auth/request-code`, { method: 'POST', headers: json, body: JSON.stringify({ email }) });
const j1 = await r1.json() as { devCode?: string };
if (!j1.devCode) { console.error('no devCode: is this a development server?'); process.exit(1); }
const r2 = await fetch(`${base}/api/auth/verify-code`, { method: 'POST', headers: json, body: JSON.stringify({ email, code: j1.devCode }) });
const cookie = r2.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
ok('signed in', r2.status === 200 && cookie.includes('__Host-pristine_session'));

const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json() as { hasPlan: boolean; entitled: boolean; dailyRemaining: number; dailyCap: number | null };
ok('account may download', me.entitled, `plan ${me.hasPlan}, cap ${me.dailyCap}, remaining ${me.dailyRemaining}`);
/* On a plan the cap answers 429 daily_quota; a bought single download, once
 * used, answers with the plans (402 no_subscription) -- there is no
 * allowance left to count down. */
const denialAtCap = me.hasPlan ? 'daily_quota' : 'no_subscription';

/* ---- the file ----------------------------------------------------------- */
const src = 'public/demo/pristine.mp4';
const bytes = fs.readFileSync(src);
const scan = await scanFile(new File([bytes], 'pristine.mp4', { type: 'video/mp4' }));
const d = scan.descriptor;
const headers = (extra: Record<string, string> = {}) => ({
  cookie,
  origin: base,
  'content-type': 'application/octet-stream',
  'x-pristine-ftyp-len': String(d.ftypLen),
  'x-pristine-payload-start': String(d.payloadStart),
  'x-pristine-payload-len': String(d.payloadLen),
  ...extra,
});
const post = (body: Uint8Array, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/patch`, { method: 'POST', headers: headers(extra), body: body as BodyInit });

/* A different video, as far as the server can tell: the same index with a
 * different modification time in mvhd (version 0: +16 from the box start). */
const variant = (n: number): Uint8Array => {
  const m = new Uint8Array(scan.moov);
  const idx = Buffer.from(m).indexOf('mvhd');
  new DataView(m.buffer, m.byteOffset).setUint32(idx - 4 + 16, 0x50000000 + n);
  return m;
};

/* ---- refusals that must cost nothing, while there is still allowance ----- */
{
  const res = await post(scan.moov, { 'x-pristine-payload-len': '3000000000000' });
  ok('an absurd payload length is refused', res.status === 400, `status ${res.status}`);
}
await new Promise<void>((resolve) => {
  const u = new URL(`${base}/api/patch`);
  const req = http.request({
    host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { ...headers(), 'transfer-encoding': 'chunked' },
  }, (res) => {
    ok('a chunked body with no length is refused', res.statusCode === 411, `status ${res.statusCode}`);
    res.resume();
    res.on('end', resolve);
  });
  req.on('error', (e) => { ok('a chunked body with no length is refused', false, String(e)); resolve(); });
  req.write(Buffer.from(scan.moov.subarray(0, 64)));
  req.end();
});
{
  /* mvhd version 0: timescale at +20, duration at +24 from the box start. A
   * header asking for 136 years of silence must be refused before a byte is
   * allocated -- and, because the credit was reserved first, released again. */
  const moov = new Uint8Array(scan.moov);
  const idx = Buffer.from(moov).indexOf('mvhd');
  ok('found mvhd', idx > 0);
  const boxStart = idx - 4;
  const dv = new DataView(moov.buffer, moov.byteOffset);
  dv.setUint32(boxStart + 20, 1);            // timescale 1
  dv.setUint32(boxStart + 24, 0xffffffff);   // duration 136 years
  const res = await post(moov);
  const j = await res.json().catch(() => ({})) as { code?: string };
  ok('an impossible duration is refused cleanly', res.status === 422 && j.code === 'too_long', `status ${res.status} ${j.code ?? ''}`);
  const still = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json() as { dailyRemaining: number };
  ok('a refused attempt cost no credit', still.dailyRemaining === me.dailyRemaining, `remaining ${still.dailyRemaining}`);
}

/* ---- patches until the cap refuses: a different video each time ---------- */
const remaining = me.dailyRemaining;
for (let i = 0; i < remaining; i++) {
  const res = await post(i === 0 ? scan.moov : variant(i));
  const meta = JSON.parse(res.headers.get('x-pristine-result') ?? '{}') as Record<string, number | boolean>;
  const body = new Uint8Array(await res.arrayBuffer());
  ok(`patch ${i + 1}/${remaining} served`, res.status === 200, `status ${res.status}`);
  ok(`patch ${i + 1} body matches its header`,
    res.status === 200 && Number(meta.moovLen) + Number(meta.mdatHeaderLen) + Number(meta.fillerHeadLen) === body.length);
  ok(`patch ${i + 1} reports remaining ${remaining - i - 1}`, Number(meta.dailyRemaining) === remaining - i - 1, `got ${meta.dailyRemaining}`);
}
{
  /* The first file again, at the cap: free, and served. */
  const res = await post(scan.moov);
  const meta = JSON.parse(res.headers.get('x-pristine-result') ?? '{}') as Record<string, number | boolean>;
  await res.arrayBuffer();
  ok('the same file again is served for free at the cap', res.status === 200 && meta.repeat === true, `status ${res.status} repeat ${meta.repeat}`);
  ok('the free repeat leaves remaining at 0', Number(meta.dailyRemaining) === 0, `got ${meta.dailyRemaining}`);
}
{
  const res = await post(variant(100));
  const j = await res.json().catch(() => ({})) as { code?: string };
  ok('a new file is refused at the cap', (res.status === 429 || res.status === 402) && j.code === denialAtCap, `status ${res.status} ${j.code ?? ''}`);
}

/* ---- two at once at the cap: neither slips through --------------------- */
{
  const [a, b] = await Promise.all([post(variant(101)), post(variant(102))]);
  ok('parallel new files at the cap are both refused', a.status >= 400 && a.status < 500 && b.status >= 400 && b.status < 500, `${a.status} ${b.status}`);
}

const after = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json() as { dailyRemaining: number };
ok('remaining is 0 after the run', after.dailyRemaining === 0, `got ${after.dailyRemaining}`);

console.log(`\n  ${pass} passed, ${failCount} failed\n`);
process.exit(failCount ? 1 : 0);
