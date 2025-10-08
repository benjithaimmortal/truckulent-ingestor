# Cursor PRD — JSON Ingester (Firecrawl + Apify + Supabase)

*Last updated: 2025‑10‑07*

## 1) Summary

A Node/TypeScript CLI that **reads a hosted JSON seed** of Pittsburgh food trucks, chooses a URL to scrape per truck, calls the appropriate extractor (**Firecrawl** for websites, **Apify** for Facebook/Instagram), normalizes results into a unified **Event** schema, and **upserts** into **Supabase** via REST. We will **run manually** for the hackathon.

---

## 2) Scope & Non‑Goals

**In scope**

* Consume JSON at `SEED_JSON_URL` with fields: `name`, `pref_url`, `urls[]`, `website`, `facebook`, `instagram`, `notes`, `active`.
* Per truck: pick `pref_url`; on failure, fallback through `urls[]`.
* Extract upcoming **in‑person** events (next ~60 days) into a uniform schema.
* Upsert trucks and events into Supabase (`on_conflict=name` for trucks; composite unique for events).
* CLI with dry‑run and per‑truck filters.

**Out of scope (v1)**

* Automatic scheduling/cron.
* Full NER of ambiguous captions (we’ll implement sane regex+heuristics; optional LLM toggle).
* Geocoding (optional hook provided, off by default).

---

## 3) Inputs & Outputs

**Input JSON (hosted)**

```jsonc
{
  "trucks": [
    {
      "name": "Blue Sparrow",
      "pref_url": "https://www.bluesparrowpgh.com/",
      "urls": ["https://www.bluesparrowpgh.com/", "https://instagram.com/bluesparrowpgh"],
      "website": "https://www.bluesparrowpgh.com/",
      "instagram": "https://instagram.com/bluesparrowpgh",
      "facebook": null,
      "notes": "Calendar on website",
      "active": true
    }
  ]
}
```

**Normalized Event schema (internal)**

```ts
export type Event = {
  truckName: string;
  startISO: string;     // ISO 8601
  endISO?: string;
  venue: string;
  rawAddress?: string;
  city?: string;        // default "Pittsburgh, PA"
  lat?: number;
  lng?: number;
  sourceURL: string;    // page/post/event url
  confidence?: number;  // 0..1
};
```

**Supabase write model**

* **Trucks**: `name (unique), website, facebook, instagram, notes, active`
  - Optional: `last_seen_at TIMESTAMPTZ` updated on each ingest (graceful degradation if missing)
* **Events**: `truck_id (fk), start_ts, end_ts, venue, raw_address, city, lat, lng, source_url, confidence, last_seen_at`
* **Upsert keys**: `on_conflict=name` (trucks), `on_conflict=truck_id,start_ts,venue,raw_address` (events)

### 3.1 Database Schema (SQL)

```sql
-- Trucks table
CREATE TABLE IF NOT EXISTS trucks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  facebook TEXT,
  instagram TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ,
  venue TEXT NOT NULL,
  raw_address TEXT,
  city TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  source_url TEXT NOT NULL,
  confidence DECIMAL(3, 2) DEFAULT 0.5,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(truck_id, start_ts, venue, raw_address)
);

-- Enable RLS (Row Level Security)
ALTER TABLE trucks ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_trucks_name ON trucks(name);
CREATE INDEX IF NOT EXISTS idx_trucks_active ON trucks(active);
CREATE INDEX IF NOT EXISTS idx_events_truck_id ON events(truck_id);
CREATE INDEX IF NOT EXISTS idx_events_start_ts ON events(start_ts);
CREATE INDEX IF NOT EXISTS idx_events_venue ON events(venue);
CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);

-- Update triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_trucks_updated_at BEFORE UPDATE ON trucks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS Policies (simple service role access)
CREATE POLICY "Service role access" ON trucks
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role access" ON events
  FOR ALL USING (auth.role() = 'service_role');

-- Optional: Public view for frontend consumption
CREATE OR REPLACE VIEW public_events AS
SELECT 
  e.id,
  t.name as truck_name,
  e.start_ts,
  e.end_ts,
  e.venue,
  e.raw_address,
  e.city,
  e.lat,
  e.lng,
  e.source_url,
  e.confidence,
  e.last_seen_at
FROM events e
JOIN trucks t ON e.truck_id = t.id
WHERE t.active = true
  AND e.start_ts >= NOW() - INTERVAL '14 days'
  AND e.start_ts <= NOW() + INTERVAL '60 days'
ORDER BY e.start_ts ASC;
```

---

## 4) Decision & Routing Logic

* For each truck where `active=true`:

  * Let `candidates = [pref_url, ...urls]` (deduped).
  * For each `url` in `candidates` until success:

    * If `facebook.com` or `instagram.com` → **Apify path**.
    * Else → **Firecrawl path**.
  * If no extractor returns events → record `NO_EVENTS` in logs and continue.

**Event window**: Only persist events with `startISO >= now() - 14 days` (configurable via `WINDOW_PAST_DAYS`, default 14) and `<= now() + 60 days`.

---

## 5) Integrations

### 5.1 Firecrawl (Web)

* **Endpoint**: `POST ${FIRECRAWL_URL}/v1/extract`
* **Headers**: `Authorization: Bearer ${FIRECRAWL_API_KEY}`, `Content-Type: application/json`
* **Body (v1)**

```json
{
  "prompt": "Extract upcoming in-person food-truck events (next 60 days). If none, return {\"events\":[]}.",
  "schema": {
    "type": "object",
    "properties": {
      "events": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "truck_name": {"type": "string"},
            "start_iso":  {"type": "string"},
            "end_iso":    {"type": "string"},
            "venue":      {"type": "string"},
            "raw_address":{"type": "string"},
            "city":       {"type": "string"},
            "lat":        {"type": "number"},
            "lng":        {"type": "number"},
            "source_url": {"type": "string"},
            "confidence": {"type": "number"}
          },
          "required": ["truck_name","start_iso","venue","source_url"]
        }
      }
    },
    "required": ["events"]
  },
  "urls": ["<URL>"]
}
```

* **Mapper**: Convert Firecrawl `events[]` → internal `Event[]`.

### 5.2 Apify (Facebook & Instagram)

* **Token**: `APIFY_TOKEN`
* **Actors** (configurable via env):

  * `APIFY_ACTOR_FB_EVENTS` (for `facebook.com/events/...`)
  * `APIFY_ACTOR_FB_PAGES` (Page posts feed)
  * `APIFY_ACTOR_IG_SCRAPER` (Instagram profile / post)
* **Run endpoints**

  1) Preferred for datasets: `POST https://api.apify.com/v2/acts/{ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&format=json`
     - Returns the actor's default dataset items directly in JSON.
  2) Alternative: `POST https://api.apify.com/v2/acts/{ACTOR_ID}/run-sync?token=${APIFY_TOKEN}`
     - Some actors return `201` with an empty body even on success. If body is empty or non‑JSON, fallback to async polling (below).
  3) Async fallback: `POST https://api.apify.com/v2/acts/{ACTOR_ID}/runs?token=${APIFY_TOKEN}` → poll `GET /v2/actor-runs/{runId}` until `status=SUCCEEDED` → fetch `GET /v2/datasets/{datasetId}/items?format=json`.

  * **Body** (example for all): `{ "startUrls": [{"url": "<URL>"}], "maxItems": 50 }`
* **Mapper**

  * **FB Events actor** → directly map event name, start/end time, venue/location fields.
  * **FB Pages / IG (Posts mode)** → fetch recent posts instead of page metadata. Use **regex + heuristics** to derive events from captions:

    * date/time patterns (e.g., `Fri 10/11 5-8pm`, `Oct 11, 6 PM`)
    * venue keywords ("at", "@", "hosted by", brewery names)
    * addresses (street + city)
    * create one `Event` per matched mention; label `confidence` accordingly.
  * *Optional*: if `USE_LLM=true`, send caption text to an LLM parser for better structuring.

* **Actor input (posts mode)**
  * FB Pages: set `resultsType="posts"`, `maxItems=50`.
    - Prefer `APIFY_ACTOR_FB_POSTS=apify/facebook-posts-scraper` when available.
  * IG: prefer `directUrls=[profileUrl]` and `resultsType="posts"`; disable biography/comments; `maxItems=50`.
  * Extra overrides may be passed via `APIFY_EXTRA_INPUT` (JSON), merged into the actor input.
  * Rate/credit control: limit API calls at the actor level to the most recent X posts; do not truncate client-side results.
    - Defaults: `APIFY_DEFAULT_MAX_POSTS=4`
    - Provider overrides: `APIFY_FB_MAX_POSTS`, `APIFY_IG_MAX_POSTS`
    - Per-truck overrides: `APIFY_POST_LIMITS` JSON map, e.g. `{ "Blue Sparrow": 6, "Pittsburgh Smokehouse": 2 }`
    - Inputs set `maxItems/resultsLimit/postCount` when supported to minimize calls.
  * Default behavior: Facebook Pages scraping uses posts mode (not page metadata).

* **Notes on async behavior**
  * Many official actors execute asynchronously and write results to the default dataset. Use `run-sync-get-dataset-items` when available to avoid manual polling.
  * If using `run-sync` and the response body is empty or non‑JSON, treat this as a signal to switch to the async polling flow.

### 5.3 Supabase (REST writes)

* **Base URL**: `${SUPABASE_URL}/rest/v1`
* **Headers (writes)**: `apikey: ${SUPABASE_SERVICE_ROLE_KEY}`, `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, `Content-Type: application/json`, `Prefer: return=representation, resolution=merge-duplicates`
* **Upsert truck**: `POST /trucks?on_conflict=name` with `[ { name, website, facebook, instagram, notes, active } ]`
* **Upsert events**: `POST /events?on_conflict=truck_id,start_ts,venue,raw_address` with `[{ truck_id, start_ts, ... }]`

---

## 6) Configuration / .env

```dotenv
SEED_JSON_URL=https://example.com/food_trucks_seed.json
CITY_DEFAULT=Pittsburgh, PA
WINDOW_DAYS=60

FIRECRAWL_URL=https://<your-firecrawl-endpoint>
FIRECRAWL_API_KEY=sk_...

APIFY_TOKEN=apify_...
APIFY_ACTOR_FB_EVENTS=apify/facebook-events-scraper
APIFY_ACTOR_FB_PAGES=apify/facebook-pages-scraper
APIFY_ACTOR_FB_POSTS=apify/facebook-posts-scraper
APIFY_ACTOR_IG_SCRAPER=apify/instagram-scraper

# Apify execution mode
# sync-dataset (default): run-sync-get-dataset-items
# sync (legacy): run-sync and expect JSON body
# async: run + poll run status, then fetch dataset items
APIFY_MODE=sync-dataset
APIFY_EXTRA_INPUT=  # optional JSON to merge into actor input

SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
USE_LLM=false
OPENAI_API_KEY=sk-...  # only if USE_LLM=true
```

---

## 7) Project Structure (Cursor)

```
/ (repo)
  ├─ scripts/
  │   └─ ingest.ts                # main CLI (manual run)
  ├─ lib/
  │   ├─ fetchJSON.ts             # load seed JSON
  │   ├─ route.ts                 # URL → {provider, actorId}
  │   ├─ firecrawl.ts             # call extract, map to Event[]
  │   ├─ apify.ts                 # run-sync actor, map to Event[]
  │   ├─ normalize.ts             # regex heuristics for posts → Event[]
  │   ├─ supabase.ts              # upsert trucks/events
  │   └─ logger.ts                # console + file logs
  ├─ schemas.ts                   # TypeScript types (Truck, Event)
  ├─ .env.example
  ├─ package.json
  └─ README.md
```

---

## 8) CLI Design

**Usage:** `npm run ingest [--only "Blue Sparrow"] [--dry] [--limit 50]`

**Flags**

* `--only <truckNameRegex>`: process matching trucks only.
* `--dry`: do extraction but skip Supabase writes; print summary.
* `--limit <n>`: stop after N trucks.

**Exit codes**

* `0` success; `1` partial (some errors); `2` fatal.

---

## 9) Pseudocode (ingest.ts)

```ts
const seed = await loadSeed(SEED_JSON_URL);
for (const truck of seed.trucks) {
  if (!truck.active) continue;
  const candidates = dedupe([truck.pref_url, ...(truck.urls||[])]).filter(Boolean);
  let events: Event[] = [];
  let lastErr: Error | undefined;
  for (const url of candidates) {
    try {
      let out: Event[] = [];
      if (/facebook\.com/i.test(url) || /instagram\.com/i.test(url)) {
        out = await extractWithApify(url, truck.name, { mode: process.env.APIFY_MODE || 'sync-dataset', pollMs: 10000, pollMaxMs: 60000 });
      } else {
        out = await extractWithFirecrawl(url, truck.name);
      }
      events = normalizeAndFilter(out, { cityDefault: CITY_DEFAULT, windowDays: WINDOW_DAYS });
      if (events.length) break; // success for this truck
    } catch (e) {
      lastErr = e as Error; // try next candidate
    }
  }

  if (DRY_RUN) { logSummary(truck.name, events, lastErr); continue; }

  // Upserts
  const truckId = await upsertTruck({
    name: truck.name,
    website: truck.website || undefined,
    facebook: truck.facebook || undefined,
    instagram: truck.instagram || undefined,
    notes: truck.notes || undefined,
    active: !!truck.active,
  });

  if (events.length) {
    await upsertEvents(truckId, events);
  } else {
    logNoEvents(truck.name, lastErr);
  }
}
```

---

## 10) Normalization rules

* **Time window**: No filtering - all events are accepted regardless of date.
* **Truck name**: if extractor returns blank, set to input `truck.name`.
* **Venue**: if missing, try to parse from title/caption around `@|at` tokens.
* **Address**: keep raw if available; leave geocoding off by default.
* **Confidence**: 1.0 for FB Events actor; 0.7 for Firecrawl calendar; 0.5 for IG/FB posts heuristic.

---

## 11) Error Handling & Retries

* Firecrawl/Apify HTTP: retry 2× with exponential backoff (250ms → 2s).
* If Apify actor blocks run-sync, fallback to run + poll (10s cadence, 60s max).
* On per‑URL failure, try next candidate URL before giving up.
* Log per truck: `status=OK|NO_EVENTS|ERROR`, last error message.

---

## 12) Manual Runbook

1. Set environment in `.env` (copy `.env.example`).
2. Place the JSON at `SEED_JSON_URL` (public or authenticated; if private, add fetch headers to `fetchJSON.ts`).
3. `npm i` then `npm run ingest`.
4. Inspect logs and verify Supabase rows (Trucks & Events). Use `--dry` to test extractors only.

---

## 13) Acceptance Criteria

* CLI completes against ≥20 trucks with ≤5 errors.
* Supabase `trucks` contains ≥ the seed set (upserted by name).
* Supabase `events` shows ≥1 upcoming event for at least 30% of active trucks (or NO_EVENTS logged).
* No duplicate events after two consecutive runs (composite upsert).

---

## 14) Code Stubs (Cursor‑friendly)

**lib/route.ts**

```ts
export type Provider = 'FIRECRAWL' | 'APIFY_FB_EVENTS' | 'APIFY_FB_PAGES' | 'APIFY_IG';

export function route(url: string): Provider {
  const u = url.toLowerCase();
  if (u.includes('facebook.com')) return u.includes('/events') ? 'APIFY_FB_EVENTS' : 'APIFY_FB_PAGES';
  if (u.includes('instagram.com')) return 'APIFY_IG';
  return 'FIRECRAWL';
}
```

**lib/firecrawl.ts (sketch)**

```ts
import fetch from 'node-fetch';
import { Event } from '../schemas';

export async function extractWithFirecrawl(url: string, truckName: string): Promise<Event[]> {
  const res = await fetch(`${process.env.FIRECRAWL_URL}/v1/extract`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ /* payload from §5.1 with urls:[url] */ })
  });
  if (!res.ok) throw new Error(`Firecrawl ${res.status}`);
  const json = await res.json();
  // map json.events → Event[]; fill truckName where missing
  return (json.events || []).map((e: any) => ({
    truckName: e.truck_name || truckName,
    startISO: e.start_iso,
    endISO: e.end_iso,
    venue: e.venue,
    rawAddress: e.raw_address,
    city: e.city,
    lat: e.lat,
    lng: e.lng,
    sourceURL: e.source_url || url,
    confidence: e.confidence
  }));
}
```

**lib/apify.ts (sketch)**

```ts
import fetch from 'node-fetch';
import { Event } from '../schemas';
import { normalizePostsToEvents } from './normalize';

async function runActorSync(actorId: string, input: any) {
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync?token=${process.env.APIFY_TOKEN}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Apify ${res.status}`);
  return res.json();
}

export async function extractWithApify(url: string, truckName: string): Promise<Event[]> {
  const provider = url.includes('facebook.com/events') ? 'APIFY_FB_EVENTS' : (url.includes('facebook.com') ? 'APIFY_FB_PAGES' : 'APIFY_IG');
  const actor = provider === 'APIFY_FB_EVENTS' ? process.env.APIFY_ACTOR_FB_EVENTS
             : provider === 'APIFY_FB_PAGES'  ? process.env.APIFY_ACTOR_FB_PAGES
             : process.env.APIFY_ACTOR_IG_SCRAPER!;
  const raw = await runActorSync(actor!, { startUrls: [{ url }], maxItems: 50 });

  if (provider === 'APIFY_FB_EVENTS') {
    // map actor's structured fields directly
    return (raw.items || raw.data || []).map((ev: any) => ({
      truckName,
      startISO: ev.startTime || ev.start_time || ev.startDate,
      endISO: ev.endTime || ev.end_time,
      venue: ev.place?.name || ev.venue || '',
      rawAddress: ev.place?.location?.street || ev.address || '',
      city: ev.place?.location?.city,
      sourceURL: ev.url || ev.link || url,
      confidence: 1
    }));
  }

  // FB Pages / IG → posts list → regex/heuristics
  const posts = raw.items || raw.data || [];
  return normalizePostsToEvents(posts, { truckName, fallbackURL: url });
}
```

**lib/supabase.ts (sketch)**

```ts
import fetch from 'node-fetch';
import { Event } from '../schemas';

const base = `${process.env.SUPABASE_URL}/rest/v1`;
const hdrs = {
  'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
  'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation, resolution=merge-duplicates'
};

export async function upsertTruck(t: {name:string; website?:string; facebook?:string; instagram?:string; notes?:string; active:boolean;}): Promise<string> {
  const res = await fetch(`${base}/trucks?on_conflict=name&select=id`, { method: 'POST', headers: hdrs, body: JSON.stringify([t]) });
  if (!res.ok) throw new Error(`Supabase upsert truck ${res.status}`);
  const rows = await res.json();
  return rows[0].id;
}

export async function upsertEvents(truckId: string, events: Event[]) {
  if (!events.length) return;
  const body = events.map(e => ({
    truck_id: truckId,
    start_ts: e.startISO,
    end_ts: e.endISO,
    venue: e.venue,
    raw_address: e.rawAddress || '',
    city: e.city || process.env.CITY_DEFAULT || 'Pittsburgh, PA',
    lat: e.lat,
    lng: e.lng,
    source_url: e.sourceURL,
    confidence: e.confidence,
    last_seen_at: new Date().toISOString()
  }));
  const res = await fetch(`${base}/events?on_conflict=truck_id,start_ts,venue,raw_address`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase upsert events ${res.status}`);
}
```

---

## 15) Risks & Mitigations

* **FB/IG anti-scrape changes** → keep actor IDs configurable; allow fallback to website URLs.
* **Sparse IG captions** → normalization may miss dates/venues; optional `USE_LLM=true` to improve.
* **Quota/429** → backoff + per‑provider concurrency limit (e.g., max 2 parallel calls).
* **Dirty input URLs** → sanitize/normalize before calls; skip invalid schemes.

---

## 16) Definition of Done

* `.env` configured, `npm run ingest` completes with successful upserts.
* Logs show per‑truck status and counts.
* Supabase `public_events` view returns data for the static site.

---

## 17) Current Implementation Overview (Code & Intent)

This section mirrors the code as implemented and provides a step-by-step flow for diagnosis.

**Note**: See `.cursorrules` for development preferences and coding standards.

### 17.1 End-to-End Steps

1) Seed load
   - `lib/fetchJSON.ts` fetches `SEED_JSON_URL`.
   - Accepts either `{ "trucks": [...] }` or a top-level `[...]` array; coerces to `{ trucks }`.

2) Selection & filters
   - CLI flags: `--only`, `--limit`, `--include-inactive` select trucks.
   - Concurrency: `CONCURRENCY` (default 2) controls parallel trucks.

3) Per-truck candidate routing
   - Candidates: `[pref_url, ...urls]` (deduped, truthy), tried in order until a successful event extraction yields ≥1 event.
   - Router `lib/route.ts`: `facebook.com/events` → FB Events; other FB → FB Posts; IG → IG; else → Firecrawl.

4) Providers and modes
   - Firecrawl (web): `POST {FIRECRAWL_URL}/v1/extract` with strict schema; maps to `Event[]`.
   - Apify (FB/IG): prefers `run-sync-get-dataset-items` (dataset JSON); falls back to `run-sync`; if needed, async `runs` + poll `actor-runs` → fetch dataset items.
   - `APIFY_MODE=sync-dataset|sync|async` selects strategy; all paths verbose-log request/response snippets.

5) Posts vs Events
   - FB Events: maps event objects directly.
   - FB Posts: uses `APIFY_ACTOR_FB_POSTS` if set (recommended) or `APIFY_ACTOR_FB_PAGES` with `resultsType=posts`.
   - IG: uses profile/posts mode (directUrls, resultsType=posts) with minimal metadata.

6) Rate/Credit control
   - Actor-side limits only (we do not truncate client-side): `maxItems`, `resultsLimit`, and, if supported, `postCount`.
   - Defaults: `APIFY_DEFAULT_MAX_POSTS=4`; provider overrides `APIFY_FB_MAX_POSTS`, `APIFY_IG_MAX_POSTS`; per-truck JSON map via `APIFY_POST_LIMITS`.

7) LLM parsing stage (optional)
   - When `USE_LLM=true`, FB/IG post items are sent to `lib/llm.ts` (OpenAI) with a strict JSON schema.
   - Returns normalized `Event[]` including `images[]` and `text`.
   - Non-ISO `start_iso` or missing `venue` entries are dropped; verbose logs show `llm-input` and `llm-events`.

8) Normalization & windows
   - `normalizeAndFilter` enforces city default, but accepts all events regardless of date (no time filtering).

9) Upserts (skip when `--dry`)
   - Upsert truck by `name`, updating `last_seen_at` each run.
   - Upsert events by composite conflict `truck_id,start_ts,venue,raw_address` with `last_seen_at` on each event row.
   - Events are deduplicated by composite key before upsert to avoid constraint violations.
   - Local cache: write snapshots, pending upserts, scraped data, and LLM events under `/.cache/TIMESTAMP/` so failed writes can be replayed.

10) Cache upload command
    - `npm run upload-cache` uploads cached data to Supabase.
    - Options: `--dry` (preview), `--from <file>` (specific cache file), `--truck <name>` (filter), `--log-file <path>`.
    - Files: `/.cache/TIMESTAMP/seed.json` (trucks), `/.cache/TIMESTAMP/pending_upserts.jsonl` (events), `/.cache/TIMESTAMP/scraped_data.jsonl` (raw data), `/.cache/TIMESTAMP/llm_events.jsonl` (processed events), `/.cache/TIMESTAMP/write_failures.jsonl` (errors).

11) Logging & diagnostics
   - JSONL logs to console; `--log-file <path>` also writes to file.
   - Key messages: `selection`, `candidate-start`, `firecrawl-request/response`, `apify-request/response`, `apify-poll`, `llm-input`, `llm-events`, `dry-summary`, `no-events`, `write-failed`.

12) Async handling and timeouts
   - Apify async polling: `APIFY_POLL_MS` (default 10s), `APIFY_POLL_MAX_MS` (default 300s ~ 5 min).
   - On timeout or run failure, we log and continue to the next candidate/truck (no hard abort), including in `--dry` mode.

### 17.2 Configuration Summary (env)

- Core: `SEED_JSON_URL`, `CITY_DEFAULT` (time window filtering removed)
- Firecrawl: `FIRECRAWL_URL`, `FIRECRAWL_API_KEY`
- Apify: `APIFY_TOKEN`, `APIFY_MODE`, `APIFY_EXTRA_INPUT`
  - Actors: `APIFY_ACTOR_FB_EVENTS`, `APIFY_ACTOR_FB_PAGES`, `APIFY_ACTOR_FB_POSTS`, `APIFY_ACTOR_IG_SCRAPER`
  - Post limits: `APIFY_DEFAULT_MAX_POSTS`, `APIFY_FB_MAX_POSTS`, `APIFY_IG_MAX_POSTS`, `APIFY_POST_LIMITS`
  - Polling: `APIFY_POLL_MS`, `APIFY_POLL_MAX_MS`
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- LLM: `USE_LLM`, `OPENAI_API_KEY`
- Execution: `CONCURRENCY`
 - Local cache: none required; stored in `/.cache/TIMESTAMP/` automatically (seed snapshots, pending upserts, scraped data, LLM events, write failures)

### 17.3 Operational Steps (Troubleshooting)

1) Run `--dry --verbose --log-file run.jsonl` to inspect request/response snippets (creates `logs/TIMESTAMP/run.jsonl`).
2) If Apify shows empty/non-JSON, switch to `APIFY_MODE=async` or ensure dataset-items mode.
3) If IG consumes too many credits, lower `APIFY_IG_MAX_POSTS` or set per-truck limits in `APIFY_POST_LIMITS`.
4) If no events parsed from posts, enable `USE_LLM=true` and verify `llm-events` output; otherwise improve regex in `normalize.ts`.
5) When satisfied, run without `--dry` to upsert; confirm trucks have `last_seen_at` updated and events appear without duplicates.
6) If Supabase writes fail, check `/.cache/TIMESTAMP/write_failures.jsonl` for error details, then use `npm run upload-cache -- --dry` to preview cached data.
7) Upload specific cache files: `npm run upload-cache -- --from pending_upserts.jsonl --truck "Blue Sparrow" --dry --log-file upload.jsonl`.
8) Upload LLM events: `npm run upload-cache -- --from llm_events.jsonl --dry --log-file upload.jsonl`.
9) For 401 RLS errors: Verify `SUPABASE_SERVICE_ROLE_KEY` is correct and has service role permissions.
10) For 400 column errors: Ensure schema matches the SQL in section 3.1, especially `last_seen_at` columns.
