'use client';

import dynamic from 'next/dynamic';

/*
 * The engagement field as a page backdrop, for pages that are server
 * components (the pricing page exports metadata, so it cannot be a client
 * component, and Next refuses a `ssr: false` import inside one). This is the
 * client boundary: three.js is loaded here, on the client, once the page is
 * up, and rendered behind the content at −10 in the wrapper's own stacking
 * context. The wrapper the page mounts it in must be `relative` and sized.
 */
const HeroField = dynamic(() => import('@/components/three/HeroField'), { ssr: false });

export default function FieldBackdrop({ className, calm = 0.5 }: { className?: string; calm?: number }) {
  return (
    <div
      aria-hidden
      className={['pointer-events-none absolute inset-0 -z-10', className].filter(Boolean).join(' ')}
    >
      <HeroField calm={calm} />
    </div>
  );
}
