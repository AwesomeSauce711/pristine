'use client';

import Link from 'next/link';
import { soundProps } from '@/lib/sound';
import { useMe } from '@/lib/use-me';

/*
 * The hero's main button. "Try it on your video -- free" is the right offer
 * to a stranger and the wrong one to a subscriber, who has already tried it
 * and paid: for them it says what they came to do.
 */
export default function HeroCta() {
  const { entitled } = useMe();
  return (
    <Link href="/app" className="pill pill-primary" {...soundProps('hover')}>
      {entitled ? 'Upload a video' : 'Try it on your video \u2014 free'}
    </Link>
  );
}
