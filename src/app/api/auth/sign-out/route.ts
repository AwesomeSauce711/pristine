import { signOut } from '@/lib/auth';

/*
 * POST only, never GET.
 *
 * A GET sign-out can be triggered by any image tag or link on another site,
 * which is a small but pointless denial of service against your own users.
 */
export async function POST() {
  await signOut();
  return Response.json({ ok: true });
}
