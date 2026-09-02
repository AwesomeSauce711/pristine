import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import DevBar from '@/components/DevBar';
import StatusBanner from '@/components/StatusBanner';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
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
    'TikTok re-encodes your upload to 720p and halves the frame rate. Pristine patches the file so it is served exactly as you made it. Your video never leaves your device.',
  openGraph: {
    title: 'Pristine 4K — stop TikTok compressing your video',
    description:
      'TikTok re-encodes your upload to 720p. Pristine patches the file so it is served exactly as you made it.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#08080b',
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
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-text antialiased">
        {/* Hidden until focused. Lets a keyboard user skip the nav on every page. */}
        <a href="#main" className="skip-link">Skip to content</a>
        {/* Renders nothing unless the method is degraded or broken. */}
        <StatusBanner />
        {children}
        {/* Renders nothing unless the server allows the dev unlock. */}
        <DevBar />
      </body>
    </html>
  );
}
