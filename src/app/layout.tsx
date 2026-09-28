import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import CursorTrail from '@/components/CursorTrail';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const interTight = Inter_Tight({ subsets: ['latin'], weight: ['300'], variable: '--font-inter-tight', display: 'swap', preload: false });
const bricolage = Bricolage_Grotesque({ subsets: ['latin'], weight: ['700', '800'], variable: '--font-bricolage', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://pristine4k.com'),
  title: 'Pristine — free, open-source video tool',
  description: 'Prepare an MP4 for TikTok entirely in your browser. Free, open source, and no account required.',
  openGraph: {
    title: 'Pristine — free, open-source video tool',
    description: 'Prepare an MP4 for TikTok entirely in your browser.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: '#05060c', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${bricolage.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen text-text antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <CursorTrail />
        {children}
      </body>
    </html>
  );
}
