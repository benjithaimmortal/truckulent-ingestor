import fetch from 'node-fetch';
import { Event } from '../schemas';
import { CONFIG } from './config';
import { logger } from './logger';
import { normalizePostsToEvents } from './normalize';
import { llmExtractEventsFromPosts } from './llm';

async function runActorSync(actorId: string, input: any, opts?: { verbose?: boolean }) {
  if (!CONFIG.apifyToken) throw new Error('APIFY_TOKEN missing');
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync?token=${CONFIG.apifyToken}`;
  if (opts?.verbose) {
    logger.info('apify-request', { actorId, url, input });
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const text = await res.text();
  if (opts?.verbose) {
    logger.info('apify-response', { actorId, status: res.status, ok: res.ok, snippet: text.slice(0, 300) });
  }
  if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Apify invalid JSON: ${(e as Error).message}`);
  }
}

async function runSyncGetDatasetItems(actorId: string, input: any, opts?: { verbose?: boolean }) {
  if (!CONFIG.apifyToken) throw new Error('APIFY_TOKEN missing');
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${CONFIG.apifyToken}&format=json`;
  if (opts?.verbose) logger.info('apify-request', { actorId, url, input });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const text = await res.text();
  if (opts?.verbose) logger.info('apify-response', { actorId, status: res.status, ok: res.ok, snippet: text.slice(0, 300) });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 200)}`);
  try {
    const json = JSON.parse(text);
    // Actors often return an array of items directly
    return Array.isArray(json) ? json : (json?.items ?? []);
  } catch (e) {
    throw new Error(`Apify invalid JSON: ${(e as Error).message}`);
  }
}

async function runAsyncAndPoll(actorId: string, input: any, opts?: { verbose?: boolean; pollMs?: number; pollMaxMs?: number }) {
  if (!CONFIG.apifyToken) throw new Error('APIFY_TOKEN missing');
  const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${CONFIG.apifyToken}`;
  if (opts?.verbose) logger.info('apify-request', { actorId, url: startUrl, input });
  const runRes = await fetch(startUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const runText = await runRes.text();
  if (!runRes.ok) throw new Error(`Apify start ${runRes.status}: ${runText.slice(0, 200)}`);
  let runJson: any;
  try { runJson = JSON.parse(runText); } catch (e) { throw new Error(`Apify start invalid JSON: ${(e as Error).message}`); }
  const runId = runJson.id || runJson.data?.id;
  if (!runId) throw new Error('Apify run id missing');

  const pollMs = opts?.pollMs ?? 10000;
  const pollMaxMs = opts?.pollMaxMs ?? 60000;
  const start = Date.now();
  // poll
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(r => setTimeout(r, pollMs));
    const statusUrl = `https://api.apify.com/v2/actor-runs/${runId}`;
    const sRes = await fetch(statusUrl);
    const sText = await sRes.text();
    if (!sRes.ok) throw new Error(`Apify poll ${sRes.status}: ${sText.slice(0, 200)}`);
    let sJson: any; try { sJson = JSON.parse(sText); } catch (e) { throw new Error(`Apify poll invalid JSON: ${(e as Error).message}`); }
    const status = sJson.data?.status || sJson.status;
    if (opts?.verbose) logger.info('apify-poll', { actorId, runId, status });
    if (status === 'SUCCEEDED') {
      const datasetId = sJson.data?.defaultDatasetId || sJson.data?.datasetId || sJson.defaultDatasetId;
      if (!datasetId) return [];
      const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`;
      const iRes = await fetch(itemsUrl);
      const iText = await iRes.text();
      if (!iRes.ok) throw new Error(`Apify items ${iRes.status}: ${iText.slice(0, 200)}`);
      try { return JSON.parse(iText); } catch (e) { throw new Error(`Apify items invalid JSON: ${(e as Error).message}`); }
    }
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${status}`);
    }
    if (Date.now() - start > pollMaxMs) throw new Error('Apify poll timeout');
  }
}

export async function extractWithApify(url: string, truckName: string, opts?: { verbose?: boolean; mode?: 'sync-dataset' | 'sync' | 'async'; pollMs?: number; pollMaxMs?: number }): Promise<Event[]> {
  const lower = url.toLowerCase();
  const provider = lower.includes('facebook.com/events') ? 'APIFY_FB_EVENTS' : (lower.includes('facebook.com') ? 'APIFY_FB_PAGES' : 'APIFY_IG');
  const actor = provider === 'APIFY_FB_EVENTS' ? CONFIG.apifyActorFbEvents
             : provider === 'APIFY_FB_PAGES'  ? (CONFIG.apifyActorFbPosts || CONFIG.apifyActorFbPages)
             : CONFIG.apifyActorIgScraper;
  if (!actor) throw new Error(`Apify actor not configured for ${provider}`);

  const mode = opts?.mode || (process.env.APIFY_MODE as any) || 'sync-dataset';
  // prefer posts for FB pages & IG
  // Allow optional extra input via APIFY_EXTRA_INPUT (JSON)
  let extra: any = undefined;
  if (process.env.APIFY_EXTRA_INPUT) {
    try { extra = JSON.parse(process.env.APIFY_EXTRA_INPUT); } catch {}
  }
  // determine max posts limit with overrides
  const perTruckLimit = CONFIG.apifyPostLimitsByTruck?.[truckName];
  const providerDefault = provider === 'APIFY_IG' ? CONFIG.apifyIgMaxPosts : CONFIG.apifyFbMaxPosts;
  const maxPosts = perTruckLimit ?? providerDefault ?? CONFIG.apifyDefaultMaxPosts;

  const baseInput: any = { startUrls: [{ url }], maxItems: maxPosts, resultsLimit: maxPosts };
  if (provider === 'APIFY_FB_PAGES') {
    baseInput.resultsType = 'posts';
  }
  if (provider === 'APIFY_IG') {
    baseInput.directUrls = [url];
    delete baseInput.startUrls;
    baseInput.includeBiography = false;
    baseInput.includeComments = false;
    baseInput.resultsType = 'posts';
    baseInput.maxItems = maxPosts;
    baseInput.resultsLimit = maxPosts;
    baseInput.postCount = maxPosts; // best-effort; some actors support this alias
  }
  const input = extra ? { ...baseInput, ...extra } : baseInput;
  let items: any[] = [];
  if (mode === 'sync-dataset') {
    try {
      items = await runSyncGetDatasetItems(actor, input, { verbose: !!opts?.verbose }) as any[];
    } catch (e) {
      if (opts?.verbose) logger.warn('apify-sync-dataset-fallback', { actor, error: String(e) });
    }
  }
  if (!items.length && mode !== 'async') {
    try {
      const raw = await runActorSync(actor, input, { verbose: !!opts?.verbose }) as unknown as { items?: any[]; data?: any[] };
      items = (raw.items || raw.data || []) as any[];
    } catch (e) {
      if (opts?.verbose) logger.warn('apify-sync-fallback', { actor, error: String(e) });
    }
  }
  if (!items.length) {
    items = await runAsyncAndPoll(actor, input, { verbose: !!opts?.verbose, pollMs: opts?.pollMs ?? CONFIG.apifyPollMs, pollMaxMs: opts?.pollMaxMs ?? CONFIG.apifyPollMaxMs }) as any[];
  }

  if (provider === 'APIFY_FB_EVENTS') {
    return items.map((ev: any) => ({
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

  // do not truncate client-side; rely on actor-side limits to reduce API calls
  const posts = items as any[];
  if (CONFIG.useLlm) {
    if (opts?.verbose) logger.info('llm-start', { provider, truck: truckName, posts: posts.length });
    const llmEvents = await llmExtractEventsFromPosts(posts, truckName, url, { verbose: !!opts?.verbose });
    if (opts?.verbose) logger.info('llm-finish', { events: llmEvents.length });
    return llmEvents;
  }
  return normalizePostsToEvents(posts, { truckName, fallbackURL: url });
}

