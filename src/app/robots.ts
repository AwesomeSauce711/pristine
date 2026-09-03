import type { MetadataRoute } from 'next';

/*
 * What crawlers may index. The public pages are the landing, the pricing
 * page and the legal texts; the tool, the account, sign-in and the return
 * page from Stripe are for people, and the API is not a page at all.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/account', '/app', '/sign-in', '/welcome'],
    },
    sitemap: 'https://pristine4k.com/sitemap.xml',
  };
}
