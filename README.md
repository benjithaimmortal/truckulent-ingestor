## Food Truck Ingestor (Hackathon)

CLI that reads a hosted JSON seed of Pittsburgh food trucks, extracts upcoming in-person events via Firecrawl (web) or Apify (FB/IG), normalizes to an Event schema, and upserts into Supabase via REST.

### Quickstart

1. Copy `.env.example` to `.env` and fill values
2. Install deps: `npm i`
3. Run: `npm run ingest -- --dry --limit 5`

### CLI

```
npm run ingest -- [--only "Blue Sparrow"] [--dry] [--limit 50]
```

### Project Layout

See `base-prd.md` for the product spec and `docs/` for progress notes.

