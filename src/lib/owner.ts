import 'server-only';

import { normaliseEmail } from '@/lib/auth';

/*
 * The accounts that run this place, and why letting them past the meter is
 * not a hole.
 *
 * Reaching the check below needs a live session on an account whose address
 * is on the list, and a session only exists after a six-digit code was
 * emailed to that address and typed back within ten minutes. So the door is
 * the mailbox. Whoever holds that mailbox can already sign in, read the
 * account page, open the billing portal and cancel the subscription —
 * unlimited patches is the least of what they would have. This adds no new
 * way in; it only changes what an already-authenticated owner is allowed.
 *
 * The addresses live in an environment variable rather than in the
 * repository. Changing who is on the list is then a Railway setting and a
 * restart rather than a deploy, the list never reaches a reader's browser,
 * and a fork of this code grants nobody anything.
 *
 * Set it as PRISTINE_OWNER_EMAILS, comma-separated. Unset (the default, and
 * the case in every test) means nobody is an owner.
 */
const owners = (): string[] =>
  (process.env.PRISTINE_OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => normaliseEmail(e))
    .filter(Boolean);

/**
 * Is this the address of an owner?
 *
 * Exact match on the normalised address. Gmail's dot and plus aliases are
 * deliberately NOT expanded: an alias delivers to the owner's own inbox, so
 * nobody else could receive the code for one anyway, and matching loosely
 * here would be a way to widen the list by accident rather than on purpose.
 */
export const isOwnerEmail = (email: string | null | undefined): boolean => {
  if (!email) return false;
  const list = owners();
  return list.length > 0 && list.includes(normaliseEmail(email));
};
