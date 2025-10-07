import fetch from 'node-fetch';
import { Event } from '../schemas';
import { CONFIG } from './config';
import { logger } from './logger';

export async function extractWithFirecrawl(url: string, truckName: string, opts?: { verbose?: boolean }): Promise<Event[]> {
  if (!CONFIG.firecrawlUrl || !CONFIG.firecrawlApiKey) throw new Error('Firecrawl not configured');
  const body = {
    prompt: 'Extract upcoming in-person food-truck events (next 60 days). If none, return {"events":[]}.',
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              truck_name: { type: 'string' },
              start_iso: { type: 'string' },
              end_iso: { type: 'string' },
              venue: { type: 'string' },
              raw_address: { type: 'string' },
              city: { type: 'string' },
              lat: { type: 'number' },
              lng: { type: 'number' },
              source_url: { type: 'string' },
              confidence: { type: 'number' }
            },
            required: ['truck_name','start_iso','venue','source_url']
          }
        }
      },
      required: ['events']
    },
    urls: [url]
  } as const;

  const endpoint = `${CONFIG.firecrawlUrl}/v1/extract`;
  if (opts?.verbose) {
    logger.info('firecrawl-request', { endpoint, url, body });
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.firecrawlApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (opts?.verbose) {
    logger.info('firecrawl-response', { status: res.status, ok: res.ok, snippet: text.slice(0, 300) });
  }
  if (!res.ok) throw new Error(`Firecrawl ${res.status}: ${text.slice(0, 200)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Firecrawl invalid JSON: ${(e as Error).message}`);
  }
  const list = (json && (json.events || json.data?.events)) || [];
  return list.map((e: any) => ({
    truckName: e.truck_name || truckName,
    startISO: e.start_iso,
    endISO: e.end_iso,
    venue: e.venue,
    rawAddress: e.raw_address,
    city: e.city,
    lat: e.lat,
    lng: e.lng,
    sourceURL: e.source_url || url,
    confidence: typeof e.confidence === 'number' ? e.confidence : 0.7
  }));
}

