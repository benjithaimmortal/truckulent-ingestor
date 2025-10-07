import fetch from 'node-fetch';
import { Event } from '../schemas';
import { CONFIG } from './config';
import { logger } from './logger';

type LlmEvent = {
  truck_name?: string;
  start_iso: string;
  end_iso?: string;
  venue: string;
  raw_address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  source_url?: string;
  confidence?: number;
  images?: string[];
  text?: string;
};

export async function llmExtractEventsFromPosts(posts: any[], truckName: string, fallbackURL: string, opts?: { verbose?: boolean }): Promise<Event[]> {
  if (!CONFIG.useLlm) return [];
  if (!CONFIG.openAiApiKey) throw new Error('OPENAI_API_KEY missing');

  if (opts?.verbose) {
    const preview = posts.slice(0, 3).map((p: any) => ({
      url: p.url || p.link,
      timestamp: p.timestamp || p.time || p.date,
      text: (p.caption || p.text || '').slice(0, 140),
      images: Array.isArray(p.images) ? p.images.slice(0, 2) : undefined
    }));
    logger.info('llm-input', { truck: truckName, posts: posts.length, preview });
  }

  const system = [
    'You are an expert event extraction agent.',
    'Extract upcoming in-person food-truck events occurring in the next ~60 days.',
    'Output MUST be STRICT JSON that conforms to the provided schema. No prose, no markdown.',
    'Constraints:',
    '- start_iso MUST be ISO 8601 (UTC preferred).',
    '- venue MUST be non-empty.',
    '- source_url SHOULD be the post URL when available.',
    '- If truck_name missing, use the provided truckName.',
    '- Include end_iso if present in text.',
    '- Include images (absolute URLs) when present, and the post text as text.',
    'If no events, return {"events":[]} strictly.'
  ].join(' ');
  const user = {
    task: 'Extract upcoming events from these social posts. Include image URLs if present and the post text.',
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              truck_name: { type: 'string' },
              start_iso: { type: 'string', description: 'ISO 8601 datetime' },
              end_iso: { type: 'string' },
              venue: { type: 'string' },
              raw_address: { type: 'string' },
              city: { type: 'string' },
              lat: { type: 'number' },
              lng: { type: 'number' },
              source_url: { type: 'string', description: 'URL of the source post or event' },
              confidence: { type: 'number' },
              images: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' }
            },
            required: ['start_iso','venue']
          }
        }
      },
      required: ['events']
    },
    guidance: {
      cityDefault: CONFIG.cityDefault,
      windowDays: CONFIG.windowDays
    },
    posts
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.openAiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) }
      ]
    })
  });
  const text = await res.text();
  if (opts?.verbose) logger.info('llm-response', { status: res.status, ok: res.ok, snippet: text.slice(0, 300) });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`LLM invalid JSON: ${(e as Error).message}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return [];
  let payload: any;
  try { payload = JSON.parse(content); } catch {
    // if model returned plain text with JSON, try to find JSON block
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) payload = JSON.parse(content.slice(start, end + 1));
  }
  const events = (payload?.events || []) as LlmEvent[];
  const mapped = events
    .filter((e) => typeof e?.start_iso === 'string' && !!e?.venue)
    .map((e) => ({
    truckName: e.truck_name || truckName,
    startISO: e.start_iso,
    endISO: e.end_iso,
    venue: e.venue,
    rawAddress: e.raw_address,
    city: e.city,
    lat: e.lat,
    lng: e.lng,
    sourceURL: e.source_url || fallbackURL,
    confidence: e.confidence ?? 0.6,
    images: e.images,
    text: e.text
  }));
  // Basic ISO validation and cleanup
  const valid: Event[] = [];
  for (const ev of mapped) {
    const t = Date.parse(ev.startISO);
    if (Number.isNaN(t)) {
      if (opts?.verbose) logger.warn('llm-drop-noniso', { startISO: ev.startISO, venue: ev.venue });
      continue;
    }
    valid.push(ev);
  }
  if (opts?.verbose) {
    const preview = valid.map(ev => ({
      startISO: ev.startISO,
      venue: ev.venue,
      sourceURL: ev.sourceURL,
      confidence: ev.confidence,
      images: ev.images?.slice(0, 2),
      text: ev.text ? ev.text.slice(0, 160) : undefined
    }));
    logger.info('llm-events', { truck: truckName, count: valid.length, events: preview });
  }
  return valid;
}

