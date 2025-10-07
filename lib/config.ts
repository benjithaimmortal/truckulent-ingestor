import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optionalNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const num = Number(raw);
  if (Number.isNaN(num)) throw new Error(`Invalid number for env ${name}: ${raw}`);
  return num;
}

export const CONFIG = {
  seedJsonUrl: requireEnv('SEED_JSON_URL'),
  cityDefault: process.env.CITY_DEFAULT || 'Pittsburgh, PA',
  windowDays: optionalNumber('WINDOW_DAYS', 60) ?? 60,
  windowPastDays: optionalNumber('WINDOW_PAST_DAYS', 14) ?? 14,

  firecrawlUrl: process.env.FIRECRAWL_URL,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY,

  apifyToken: process.env.APIFY_TOKEN,
  apifyActorFbEvents: process.env.APIFY_ACTOR_FB_EVENTS,
  apifyActorFbPages: process.env.APIFY_ACTOR_FB_PAGES,
  apifyActorFbPosts: process.env.APIFY_ACTOR_FB_POSTS,
  apifyActorIgScraper: process.env.APIFY_ACTOR_IG_SCRAPER,
  apifyDefaultMaxPosts: optionalNumber('APIFY_DEFAULT_MAX_POSTS', 4) ?? 4,
  apifyFbMaxPosts: optionalNumber('APIFY_FB_MAX_POSTS'),
  apifyIgMaxPosts: optionalNumber('APIFY_IG_MAX_POSTS'),
  apifyPollMs: optionalNumber('APIFY_POLL_MS', 10000) ?? 10000,
  apifyPollMaxMs: optionalNumber('APIFY_POLL_MAX_MS', 300000) ?? 300000,
  concurrency: optionalNumber('CONCURRENCY', 2) ?? 2,
  apifyPostLimitsByTruck: (() => {
    const raw = process.env.APIFY_POST_LIMITS;
    if (!raw) return undefined as undefined | Record<string, number>;
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj as Record<string, number> : undefined;
    } catch {
      return undefined;
    }
  })(),

  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),

  useLlm: (process.env.USE_LLM || 'false').toLowerCase() === 'true',
  openAiApiKey: process.env.OPENAI_API_KEY
};

export type AppConfig = typeof CONFIG;

