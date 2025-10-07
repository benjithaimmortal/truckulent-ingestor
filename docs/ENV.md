# Environment Variables

See `base-prd.md` §6 for full list. Copy `.env.example` to `.env`.

- `SEED_JSON_URL` (required): Public URL to the seed JSON. Shape may be `{ "trucks": [] }` or a base array of seeds. See `docs/seed.sample.json`.
- `CITY_DEFAULT` (default: Pittsburgh, PA)
- `WINDOW_DAYS` (default: 60)

- `FIRECRAWL_URL`, `FIRECRAWL_API_KEY`: Required for website extraction.

- `APIFY_TOKEN`: Required for FB/IG extraction.
- `APIFY_ACTOR_FB_EVENTS`, `APIFY_ACTOR_FB_PAGES`, `APIFY_ACTOR_IG_SCRAPER`: Actor IDs.

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required): REST endpoint and service role key.

- `USE_LLM` (default false), `OPENAI_API_KEY` when LLM parsing is enabled.

