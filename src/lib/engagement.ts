/*
 * Illustrative engagement figures for the comparison previews.
 *
 * These are NOT measured and are labelled as illustrative wherever they are
 * shown. They exist to make the visual argument — the same post, seen crushed
 * versus seen as it was made — and nothing on the page treats them as data.
 * The measured figures (resolution, frame rate, bitrate) live in the page and
 * component copy and are never derived from anything here.
 */

export interface Engagement {
  likes: number;
  comments: number;
  bookmarks: number;
  shares: number;
}

export const CRUSHED_ENGAGEMENT: Engagement = { likes: 19, comments: 2, bookmarks: 1, shares: 0 };
export const PRISTINE_ENGAGEMENT: Engagement = {
  likes: 4_200_000,
  comments: 312_000,
  bookmarks: 486_000,
  shares: 371_000,
};

/* The ceilings and floors every Pristine figure stays inside: likes in the
 * millions and never past 9M, everything else in the hundreds of thousands
 * and never past 1M. Big, believable, and different every time. */
export const LIKES_MIN = 1_100_000;
export const LIKES_MAX = 9_000_000;
export const STAT_MIN = 100_000;
export const STAT_MAX = 1_000_000;

export const ENGAGEMENT_KEYS: (keyof Engagement)[] = ['likes', 'comments', 'bookmarks', 'shares'];

/**
 * A fresh set of Pristine figures so the numbers a reader meets are not the
 * same ones every visit or every file. Likes land between 1.1M and 9M; the
 * other three scale with the likes (saves highest, then shares, then
 * comments, the way a post that travelled reads) and are held between 100K
 * and 1M whatever the likes did. Still illustrative, still labelled as such.
 */
export function randomPristine(rnd: () => number = Math.random): Engagement {
  /* 1.1M … 9.0M in steps of 0.1M — a figure that reads cleanly as "x.yM". */
  const likes = Math.round((11 + rnd() * 79)) * 100_000;
  const stat = (lo: number, hi: number) => {
    const raw = likes * (lo + rnd() * (hi - lo));
    /* Rounded to the thousand so it reads as a feed figure, e.g. 412.3K. */
    return Math.round(Math.min(STAT_MAX, Math.max(STAT_MIN, raw)) / 1000) * 1000;
  };
  return {
    likes,
    comments: stat(0.04, 0.11),
    shares: stat(0.05, 0.12),
    bookmarks: stat(0.07, 0.15),
  };
}

/** 1.2M, 6.5K, 19 — the compact form a feed shows. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** Ease-out cubic: fast start, gentle landing. */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/*
 * Ease-in, a little steeper than quadratic. The counts sit near the crushed
 * figures for the first half of the travel and climb hard toward Pristine, so
 * the moment the split crosses over is where the numbers take off — and the
 * crushed end reads exactly as the crushed post: 19 likes, 2 comments.
 */
export function easeIn(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return Math.pow(c, 2.2);
}

/**
 * Where the numbers sit for a given position between crushed (t=0) and
 * pristine (t=1). Each stat is offset slightly so the four counters do not
 * move in lockstep, which reads as one animation rather than four.
 */
export function engagementAt(t: number, a = CRUSHED_ENGAGEMENT, b = PRISTINE_ENGAGEMENT): Engagement {
  const at = (k: keyof Engagement, offset: number) => {
    const u = easeIn((t - offset) / (1 - offset));
    return a[k] + (b[k] - a[k]) * u;
  };
  return {
    likes: at('likes', 0),
    comments: at('comments', 0.06),
    bookmarks: at('bookmarks', 0.1),
    shares: at('shares', 0.14),
  };
}
