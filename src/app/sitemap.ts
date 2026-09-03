import type { MetadataRoute } from 'next';

const ORIGIN = 'https://pristine4k.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${ORIGIN}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${ORIGIN}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${ORIGIN}/legal/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${ORIGIN}/legal/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${ORIGIN}/legal/refunds`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
