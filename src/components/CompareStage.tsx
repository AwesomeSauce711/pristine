'use client';

import { useCallback, useState } from 'react';
import CompareSlider from '@/components/CompareSlider';
import Descriptor3D from '@/components/Descriptor3D';
import Stage from '@/components/Stage';
import { randomPristine } from '@/lib/engagement';

/*
 * The comparison, staged.
 *
 * The same two clips as before — what TikTok served for a patched upload and
 * for an unpatched one — in the same slider with the same sync. Everything
 * around them is the Stage's: the phone with real thickness in a real hand,
 * turning with the reader across the whole page (or with the phone in their
 * hand, on a phone), the four engagement figures standing in the air above the
 * screen, the pool of light under it. This file only knows two things: the
 * split, which the slider reports and which becomes `t` for everything that
 * lights; and the two measured-figure badges, which it hands to the Stage as
 * plates to float over the screen's top corners.
 *
 * The split follows the reader (CompareSlider's `motionDrive`): the pointer's
 * place across the page on a desktop, the roll of the phone on a phone. Left
 * widens the compressed side, right widens the reader's own video. A drag or
 * a keyboard step wins while it is happening.
 *
 * THE BADGES
 * The figures are the delivered ones — what TikTok actually served — and are
 * exactly the words the flat badges carried in the screen's corners. They keep
 * their rule: each fades as the divider runs over its corner. The Pristine
 * plate lights once the split has crossed to its side, at the same moment the
 * holograms pop and the chime plays.
 */

interface Props {
  beforeSrc: string;
  afterSrc: string;
  beforePoster: string;
  afterPoster: string;
  /** Draw the hand holding the phone. */
  hand?: boolean;
}

export default function CompareStage({ beforeSrc, afterSrc, beforePoster, afterPoster, hand = true }: Props) {
  const [pos, setPos] = useState(50);
  const onPositionChange = useCallback((p: number) => setPos(p), []);
  /* A fresh set of million-scale figures per visit. Safe to draw at random
   * here: the holograms that show them mount only once the stage is in view,
   * after hydration, so the server never renders a number that could differ. */
  const [pristine] = useState(() => randomPristine());
  /* 0 at the crushed end of the travel (pos 100), 1 at the Pristine end
   * (pos 0): the counts and the split start and stop together, so at the
   * crushed end the counts read the crushed post (19 likes) exactly. */
  const t = Math.min(1, Math.max(0, 1 - pos / 100));

  return (
    <Stage
      t={t}
      hand={hand}
      pristine={pristine}
      illustrative
      descriptors={
        <>
          <Descriptor3D side="left" visible={pos > 22}>
            <div className="legend text-[9px] text-white/45">Uploaded normally</div>
            <div className="tabular text-[11px] font-medium text-white/90">720×1280 · 30fps</div>
            <div className="tabular text-[10px] text-white/50">2.90 Mbps</div>
          </Descriptor3D>
          <Descriptor3D side="right" lit={t > 0.5} visible={pos < 78}>
            <div className="legend text-[9px] text-accent-soft">With Pristine</div>
            <div className="tabular text-[11px] font-medium text-white/90">2160×3840 · 60fps</div>
            <div className="tabular text-[10px] text-white/50">41.72 Mbps</div>
          </Descriptor3D>
        </>
      }
    >
      <CompareSlider
        beforeSrc={beforeSrc}
        afterSrc={afterSrc}
        beforePoster={beforePoster}
        afterPoster={afterPoster}
        motionDrive
        onPositionChange={onPositionChange}
      />
    </Stage>
  );
}
