import { db, schema } from '@/db';
import { denialMessage, denialStatus, resolveAccess } from '@/lib/entitlement';
import { clientIp, limit, tooMany } from '@/lib/ratelimit';
import { Mp4Error } from '@/lib/mp4/boxes';
import { DEFAULT_MULTIPLIER, buildPatchedMoov } from '@/lib/mp4/patch.server';

/*
 * POST /api/patch — the only endpoint that costs money to use.
 *
 * Takes the file's index (its `moov` box, typically 30–150 KB) and returns a
 * patched one. The video itself is never uploaded: the browser reassembles the
 * finished file locally from its own bytes plus what this returns.
 *
 * That split is the entire security model. The transform lives in
 * `patch.server.ts`, which imports `server-only` so the build fails if it is
 * ever pulled into a client bundle. If it shipped to the browser, the paywall
 * would be an `if` statement on a machine we do not control.
 *
 * Response is framed binary rather than JSON+base64, because base64 would add a
 * third to a payload that can reach several megabytes:
 *
 *   body:    [patched moov][mdat header]
 *   header:  x-pristine-result: {"moovLen":…, "mdatHeaderLen":…, "fillerLen":…}
 */

/** Refuse anything larger outright. Real moovs are 30 KB–2 MB. */
const MAX_MOOV_BYTES = 4 * 1024 * 1024;

const fail = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function POST(req: Request) {
  /* ---- 1. entitlement, before any work is done ------------------------- */

  const access = await resolveAccess();
  if (!access.ok || !access.user) {
    const denial = access.denial ?? 'no_subscription';
    return fail(denialStatus(denial), denial, denialMessage(denial));
  }
  const user = access.user;

  /*
   * Burst limit, separate from the daily quota.
   *
   * The quota is the commercial limit and is counted from `patch_jobs`, which
   * is exact but costs two queries. This is the cheap guard in front of it: it
   * stops a script from issuing hundreds of requests a second, which would
   * otherwise run the quota check that many times and do real work before being
   * refused on the last one.
   *
   * Generous enough that a person patching a batch of clips by hand will never
   * see it — nobody legitimately patches more than one video every two seconds.
   */
  const burst = await limit(`patch:${user.id}`, 30, 60);
  if (!burst.ok) return tooMany(burst);

  const ipLimit = await limit(`patch:ip:${clientIp(req)}`, 60, 60);
  if (!ipLimit.ok) return tooMany(ipLimit);

  /* ---- 2. validate the descriptor -------------------------------------- */

  const num = (name: string) => Number(req.headers.get(name));
  const ftypLen = num('x-pristine-ftyp-len');
  const payloadStart = num('x-pristine-payload-start');
  const payloadLen = num('x-pristine-payload-len');

  const sane =
    Number.isInteger(ftypLen) && ftypLen >= 8 && ftypLen <= 4096 &&
    Number.isInteger(payloadStart) && payloadStart >= 8 &&
    Number.isInteger(payloadLen) && payloadLen > 0 &&
    Number.isSafeInteger(payloadStart + payloadLen);

  if (!sane) return fail(400, 'bad_descriptor', 'The request was malformed.');

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MOOV_BYTES) {
    return fail(413, 'moov_too_large',
      "This video's index is larger than we can process. Try a shorter clip.");
  }

  /* ---- 3. read the body, bounded --------------------------------------- */

  let moov: Uint8Array;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_MOOV_BYTES) {
      return fail(413, 'moov_too_large', "This video's index is larger than we can process.");
    }
    if (buf.byteLength < 8) return fail(400, 'bad_descriptor', 'The request was malformed.');
    moov = new Uint8Array(buf);
  } catch {
    return fail(400, 'bad_body', 'The request body could not be read.');
  }

  /* ---- 4. patch --------------------------------------------------------- */

  const startedAt = Date.now();
  const moovSha256 = await sha256Hex(moov);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  /*
   * A failed attempt must never cost a credit. Recording the outcome — rather
   * than incrementing a counter up front — is what makes that automatic: quota
   * counts only rows with countsAgainstQuota, and failures are written false.
   */
  const record = async (
    status: 'completed' | 'failed',
    extra: Partial<typeof schema.patchJobs.$inferInsert> = {},
  ) => {
    try {
      await db().insert(schema.patchJobs).values({
        userId: user.id,
        status,
        deviceId: access.user?.deviceId ?? null,
        ip,
        multiplier: DEFAULT_MULTIPLIER,
        moovSha256,
        moovLen: moov.length,
        durationMs: Date.now() - startedAt,
        countsAgainstQuota: status === 'completed',
        ...extra,
      });
    } catch (e) {
      // Losing an audit row must not lose the customer their patch.
      console.error('[patch] could not record usage', e);
    }
  };

  try {
    const r = buildPatchedMoov({ moov, ftypLen, payloadStart, payloadLen });

    const body = new Uint8Array(r.moov.length + r.mdatHeader.length + r.fillerHead.length);
    body.set(r.moov, 0);
    body.set(r.mdatHeader, r.moov.length);
    body.set(r.fillerHead, r.moov.length + r.mdatHeader.length);

    await record('completed', {
      outputLen: r.outputLen,
      realSamples: r.realSamples,
      phantomSamples: r.phantomSamples,
      clonedTrack: r.clonedTrack,
      neutralisedEdts: r.neutralisedEdts,
    });

    return new Response(body as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-pristine-result': JSON.stringify({
          moovLen: r.moov.length,
          mdatHeaderLen: r.mdatHeader.length,
          fillerLen: r.fillerLen,
          fillerHeadLen: r.fillerHead.length,
          outputLen: r.outputLen,
          realSamples: r.realSamples,
          phantomSamples: r.phantomSamples,
          clonedTrack: r.clonedTrack,
          neutralisedEdts: r.neutralisedEdts,
          multiplier: DEFAULT_MULTIPLIER,
          dailyRemaining: Math.max(0, access.dailyRemaining - 1),
        }),
      },
    });
  } catch (e) {
    /*
     * Mp4Error messages are written to be shown to a user as-is — "this video
     * has no audio track, so there is nothing to use as a decoy" is more useful
     * than any generic wording we could substitute.
     */
    if (e instanceof Mp4Error) {
      await record('failed', { errorCode: e.code });
      return fail(422, e.code, e.message);
    }
    await record('failed', { errorCode: 'internal' });
    console.error('[patch] unexpected failure', e);
    return fail(500, 'internal',
      "Something went wrong on our end, and this hasn't used one of your patches.");
  }
}
