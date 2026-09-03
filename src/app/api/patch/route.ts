import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { denialMessage, denialStatus, resolveAccess, type Denial } from '@/lib/entitlement';
import { clientIp, limit, requestIp, tooMany } from '@/lib/ratelimit';
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

/* Longer than any file a phone or a camera writes; a header claiming more is
 * not a video, it is a number someone typed. */
const MAX_PAYLOAD_BYTES = 64 * 1024 ** 3;

/** Read a request body with a hard byte ceiling, whatever Content-Length says. */
async function readBounded(req: Request, max: number): Promise<Uint8Array | 'too_large' | 'unreadable'> {
  const reader = req.body?.getReader();
  if (!reader) return 'unreadable';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return 'unreadable';
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export async function POST(req: Request) {
  /* ---- 0. the cheapest guard first --------------------------------------- */

  const ipLimit = await limit(`patch:ip:${clientIp(req)}`, 60, 60);
  if (!ipLimit.ok) return tooMany(ipLimit);

  /* ---- 1. entitlement, before any work is done ------------------------- */

  const access = await resolveAccess();
  /*
   * A used-up allowance -- or no allowance at all: a plan that lapsed, a
   * single download already used -- is not a refusal yet. The same file
   * downloaded again costs nothing (see the reservation below), and whether
   * this is that file is not known until the body has been read. Only the
   * two denials that no repeat can lift end here: not signed in, revoked.
   */
  const quotaDenied = !access.ok && !!access.user && access.denial !== 'revoked';
  if ((!access.ok && !quotaDenied) || !access.user) {
    const denial = access.denial ?? 'no_subscription';
    return fail(denialStatus(denial), denial, denialMessage(denial));
  }
  const user = access.user;

  /* A person patching a batch by hand never sends more than one every few
   * seconds; a script does, and the quota check below costs real queries. */
  const burst = await limit(`patch:${user.id}`, 12, 60);
  if (!burst.ok) return tooMany(burst);

  /* ---- 2. validate the descriptor -------------------------------------- */

  const num = (name: string) => Number(req.headers.get(name));
  const ftypLen = num('x-pristine-ftyp-len');
  const payloadStart = num('x-pristine-payload-start');
  const payloadLen = num('x-pristine-payload-len');

  const sane =
    Number.isInteger(ftypLen) && ftypLen >= 8 && ftypLen <= 4096 &&
    Number.isInteger(payloadStart) && payloadStart >= 8 && payloadStart <= MAX_PAYLOAD_BYTES &&
    Number.isInteger(payloadLen) && payloadLen > 0 && payloadLen <= MAX_PAYLOAD_BYTES &&
    Number.isSafeInteger(payloadStart + payloadLen);

  if (!sane) return fail(400, 'bad_descriptor', 'The request was malformed.');

  /*
   * The body is the file's index, never the file. The client always states
   * its length; a request that does not is not the client, and is refused
   * before a byte of it is read. The read itself is bounded as well, so a
   * length that lies is caught at the ceiling rather than in memory.
   */
  const declared = Number(req.headers.get('content-length'));
  if (!Number.isInteger(declared) || declared < 8) {
    return fail(411, 'length_required', 'The request was malformed.');
  }
  if (declared > MAX_MOOV_BYTES) {
    return fail(413, 'moov_too_large',
      "This video's index is larger than we can process. Try a shorter clip.");
  }

  /* ---- 3. read the body, bounded --------------------------------------- */

  const read = await readBounded(req, MAX_MOOV_BYTES);
  if (read === 'too_large') {
    return fail(413, 'moov_too_large', "This video's index is larger than we can process.");
  }
  if (read === 'unreadable') return fail(400, 'bad_body', 'The request body could not be read.');
  if (read.length < 8) return fail(400, 'bad_descriptor', 'The request was malformed.');
  const moov = read;

  /* ---- 4. reserve the credit ------------------------------------------- */

  const startedAt = Date.now();
  const moovSha256 = await sha256Hex(moov);
  const ip = requestIp(req.headers);

  /*
   * RESERVE, THEN WORK. The usage row is written BEFORE the patch, under a
   * per-user lock, with the quota re-counted inside that lock. Two requests
   * arriving together therefore take turns: the second sees the first's row
   * and is refused at the cap instead of both slipping through. And because
   * the row exists before the file is built, no failure afterwards -- a
   * database blip, a crash -- can hand out an uncounted patch: the worst
   * case is a row left 'pending', which counts. A patch that fails is
   * released below, so a failed attempt never costs a credit.
   */
  type Reserved = { id: string; dailyRemaining: number; repeat: boolean } | { denial: Denial };
  let reserved: Reserved;
  try {
    reserved = await db().transaction(async (tx): Promise<Reserved> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);

      /*
       * THE SAME FILE AGAIN IS FREE. A file is its index: the same bytes in
       * the moov are the same video, cut the same way, and the output is the
       * same file every time. Someone who downloads it again -- lost the
       * first copy, wants it on another device, pressed the button twice --
       * has already paid for it, so a completed (or in-flight) job by this
       * account with this index, within the last thirty days, means no new
       * credit -- whether the plan is at its cap, has lapsed since, or the
       * file was a single download bought outright. There is nothing to
       * farm here: a different video is a different index, and the same
       * video twice yields the same file.
       */
      const since = new Date(Date.now() - 30 * 86_400_000);
      const prior = await tx.select({ id: schema.patchJobs.id }).from(schema.patchJobs)
        .where(and(
          eq(schema.patchJobs.userId, user.id),
          eq(schema.patchJobs.moovSha256, moovSha256),
          eq(schema.patchJobs.moovLen, moov.length),
          eq(schema.patchJobs.countsAgainstQuota, true),
          inArray(schema.patchJobs.status, ['completed', 'pending']),
          gt(schema.patchJobs.createdAt, since),
        ))
        .limit(1);
      if (prior.length) {
        const [row] = await tx.insert(schema.patchJobs).values({
          userId: user.id,
          status: 'pending',
          deviceId: user.deviceId ?? null,
          ip,
          multiplier: DEFAULT_MULTIPLIER,
          moovSha256,
          moovLen: moov.length,
          countsAgainstQuota: false,
          errorCode: 'repeat',
        }).returning({ id: schema.patchJobs.id });
        return { id: row.id, dailyRemaining: Math.max(0, access.dailyRemaining), repeat: true };
      }

      if (quotaDenied) return { denial: access.denial ?? 'daily_quota' };
      const fresh = await resolveAccess(tx);
      if (!fresh.ok) return { denial: fresh.denial ?? 'no_subscription' };
      const [row] = await tx.insert(schema.patchJobs).values({
        userId: user.id,
        status: 'pending',
        deviceId: user.deviceId ?? null,
        ip,
        multiplier: DEFAULT_MULTIPLIER,
        moovSha256,
        moovLen: moov.length,
        countsAgainstQuota: true,
      }).returning({ id: schema.patchJobs.id });
      return { id: row.id, dailyRemaining: fresh.dailyRemaining, repeat: false };
    });
  } catch (e) {
    console.error('[patch] could not reserve usage', e);
    return fail(500, 'internal',
      "Something went wrong on our end, and this hasn't used one of your patches.");
  }
  if ('denial' in reserved) {
    return fail(denialStatus(reserved.denial), reserved.denial, denialMessage(reserved.denial));
  }
  const jobId = reserved.id;

  const settle = async (
    values: Partial<typeof schema.patchJobs.$inferInsert>,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await db().update(schema.patchJobs)
          .set({ ...values, durationMs: Date.now() - startedAt })
          .where(eq(schema.patchJobs.id, jobId));
        return true;
      } catch (e) {
        console.error(`[patch] could not settle job ${jobId} (attempt ${attempt + 1})`, e);
      }
    }
    return false;
  };

  /* ---- 5. patch --------------------------------------------------------- */

  try {
    const r = buildPatchedMoov({ moov, ftypLen, payloadStart, payloadLen });

    const body = new Uint8Array(r.moov.length + r.mdatHeader.length + r.fillerHead.length);
    body.set(r.moov, 0);
    body.set(r.mdatHeader, r.moov.length);
    body.set(r.fillerHead, r.moov.length + r.mdatHeader.length);

    /* If this write fails the row stays 'pending' -- still counted, which is
     * the safe side -- and the customer still gets the file they paid for. */
    await settle({
      status: 'completed',
      outputLen: r.outputLen,
      realSamples: r.realSamples,
      phantomSamples: r.phantomSamples,
      clonedTrack: r.clonedTrack,
      neutralisedEdts: r.neutralisedEdts,
      ...(reserved.repeat ? { errorCode: 'repeat' } : {}),
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
          dailyRemaining: reserved.repeat ? reserved.dailyRemaining : Math.max(0, reserved.dailyRemaining - 1),
          repeat: reserved.repeat,
        }),
      },
    });
  } catch (e) {
    /*
     * A failed attempt must never cost a credit: the reservation is released.
     * Mp4Error messages are written to be shown to a user as-is.
     */
    if (e instanceof Mp4Error) {
      await settle({ status: 'rejected', countsAgainstQuota: false, errorCode: e.code });
      return fail(422, e.code, e.message);
    }
    await settle({ status: 'failed', countsAgainstQuota: false, errorCode: 'internal' });
    console.error('[patch] unexpected failure', e);
    return fail(500, 'internal',
      "Something went wrong on our end, and this hasn't used one of your patches.");
  }
}
