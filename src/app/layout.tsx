import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import CursorTrail from '@/components/CursorTrail';
import DevBar from '@/components/DevBar';
import StatusBanner from '@/components/StatusBanner';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/*
 * Inter Tight for the display sizes: the same letterforms as the body face,
 * drawn tighter, so the hero headline reads as one shape at 8rem rather than as
 * a paragraph that got large. Only the one weight the display class uses.
 *
 * Not preloaded: its only consumer is the giant wordmark above the landing
 * footer, so a preload on every route (the tool, sign-in, legal) spent a
 * request slot and ~45 KB before first paint on a face that page never
 * shows. `display: swap` fetches it when the wordmark is reached.
 */
const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['300'],
  variable: '--font-inter-tight',
  display: 'swap',
  preload: false,
});

/*
 * Bricolage Grotesque for the hero headline and the section titles: a face
 * with its own character at display sizes, where Inter Tight reads as a
 * larger body face. Two weights; the headline uses the heavier.
 */
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono-face',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://pristine4k.com'),
  title: {
    default: 'Pristine 4K — stop TikTok compressing your video',
    template: '%s — Pristine 4K',
  },
  description:
    'TikTok re-encodes your upload to 720p and halves the frame rate. Pristine makes sure it is served exactly as you made it. Your video never leaves your device.',
  openGraph: {
    title: 'Pristine 4K — stop TikTok compressing your video',
    description:
      'TikTok re-encodes your upload to 720p. Pristine makes sure it is served exactly as you made it.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#05060c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * suppressHydrationWarning is scoped to <html>'s own attributes and nothing
     * deeper, which is exactly the problem: browser extensions stamp the root
     * element before React loads. The warning here was `nighteye="disabled"`,
     * written by a dark-mode extension — a real attribute mismatch that the
     * application cannot prevent and that means nothing.
     *
     * Left unsuppressed it trains you to ignore hydration warnings, which is how
     * a genuine one gets missed. This silences only the noise; a mismatch inside
     * the app still reports normally.
     */
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${bricolage.variable} ${mono.variable}`} suppressHydrationWarning>
      {/*
        * No background on <body>. The page's ground is painted on <html>
        * (globals.css), because the landing page's starfield and hero canvases
        * sit at a negative z-index and a body with its own background paints
        * OVER negative-z children — that is the CSS painting order, and it
        * hid every canvas behind a flat #05060c.
        */}
      <body className="min-h-screen text-text antialiased">
        {/* Hidden until focused. Lets a keyboard user skip the nav on every page. */}
        <a href="#main" className="skip-link">Skip to content</a>
        {/* Renders nothing unless the method is degraded or broken. */}
        <StatusBanner />
        <CursorTrail />
        {children}
        {/* Renders nothing unless the server allows the dev unlock. */}
        <DevBar />
      </body>
    </html>
  );
}
