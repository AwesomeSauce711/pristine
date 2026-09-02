import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';

/*
 * The sign-in gate for /account lives here, not in the page.
 *
 * The page has a loading boundary (loading.tsx) so a click answers at once.
 * That makes it a streamed response, and a redirect thrown inside the page
 * then arrives after the shell has already gone out with a 200: browsers
 * still end up on sign-in, but a signed-out visitor sees the skeleton first,
 * and anything that is not a browser sees a page where there should be a
 * redirect. A layout renders before its children and outside their boundary,
 * so a redirect thrown here is a real 307 before a byte is streamed.
 *
 * currentUser is memoised for the request, so the page asking again costs
 * nothing.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/sign-in?next=%2Faccount');
  return children;
}
