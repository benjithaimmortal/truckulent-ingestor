export type Provider = 'FIRECRAWL' | 'APIFY_FB_EVENTS' | 'APIFY_FB_PAGES' | 'APIFY_IG';

export function route(url: string): Provider {
  const u = url.toLowerCase();
  if (u.includes('facebook.com')) return u.includes('/events') ? 'APIFY_FB_EVENTS' : 'APIFY_FB_PAGES';
  if (u.includes('instagram.com')) return 'APIFY_IG';
  return 'FIRECRAWL';
}

