import SceneNav from '@/components/SceneNav';
import Starfield from '@/components/fx/Starfield';

/*
 * The shell every secondary page shares — sign-in, account, welcome, legal,
 * not-found: the galaxy behind, the floating nav and dock instead of a bar,
 * and a centred column. One place, so the tool and the marketing pages stop
 * looking like two sites; a reader who lands on the sign-in page from the
 * dock should feel they never left.
 *
 * No 'use client': it composes client components and passes server-rendered
 * children through, so pages that fetch on the server keep doing so.
 */
export default function PageShell({
  children,
  className,
  density = 0.7,
}: {
  children: React.ReactNode;
  className?: string;
  density?: number;
}) {
  return (
    <>
      <Starfield density={density} />
      <div className="relative z-[1] min-h-[100svh] overflow-x-clip">
        <SceneNav variant="app" />
        <main
          id="main"
          className={['mx-auto px-6 pt-28 pb-20 md:pt-32 md:pb-24', className].filter(Boolean).join(' ')}
        >
          {children}
        </main>
      </div>
    </>
  );
}
