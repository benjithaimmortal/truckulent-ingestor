import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CONFIG } from '../lib/config';
import { logger } from '../lib/logger';
import { fetchSeedJson } from '../lib/fetchJSON';
import { route } from '../lib/route';
import { extractWithApify } from '../lib/apify';
import { extractWithFirecrawl } from '../lib/firecrawl';
import { normalizeAndFilter } from '../lib/normalize';
import { upsertTruck, upsertEvents } from '../lib/supabase';
import { Event, Truck } from '../schemas';
import { CONFIG as CFG } from '../lib/config';
import { writeSeedSnapshot, recordPendingUpserts, recordWriteFailure } from '../lib/cache';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('only', { type: 'string', describe: 'Regex to filter truck names' })
    .option('dry', { type: 'boolean', default: false, describe: 'Skip Supabase writes' })
    .option('limit', { type: 'number', describe: 'Process only first N trucks' })
    .option('include-inactive', { type: 'boolean', default: false, describe: 'Include inactive trucks (for testing)'} )
    .option('verbose', { type: 'boolean', default: false, describe: 'Verbose logging for extractor calls' })
    .option('log-file', { type: 'string', describe: 'Write logs to a file (JSON lines)' })
    .strict()
    .help()
    .parseAsync();

  logger.setFile(argv['log-file']);
  logger.info('ingest-start', { dry: argv.dry, only: argv.only, limit: argv.limit, city: CONFIG.cityDefault, verbose: argv.verbose, logFile: argv['log-file'] });
  const seed = await fetchSeedJson();
  try { writeSeedSnapshot(CONFIG.seedJsonUrl, seed.trucks); } catch {}
  const onlyRe = argv.only ? new RegExp(argv.only, 'i') : null;
  const total = seed.trucks.length;
  const activeList = seed.trucks.filter(t => t.active);
  const filtered = seed.trucks.filter(t => (argv['include-inactive'] ? true : t.active) && (!onlyRe || onlyRe.test(t.name)) );
  const limited = typeof argv.limit === 'number' ? filtered.slice(0, argv.limit) : filtered;

  logger.info('selection', { total, active: activeList.length, selected: filtered.length, processing: limited.length, includeInactive: !!argv['include-inactive'] });
  if (limited.length === 0) {
    logger.info('nothing-to-process', { hint: 'Try --include-inactive or adjust --only/--limit' });
  }

  let partialErrors = 0;
  // simple concurrency pool
  const pool = CFG.concurrency;
  let idx = 0;
  async function processTruck(truck: Truck) {
    const candidates = Array.from(new Set([truck.pref_url, ...(truck.urls || [])].filter(Boolean))) as string[];
    let events: Event[] = [];
    let lastErr: unknown;
    for (const url of candidates) {
      try {
        const p = route(url);
        logger.info('candidate-start', { truck: truck.name, url, provider: p });
        const out = p === 'FIRECRAWL' ? await extractWithFirecrawl(url, truck.name, { verbose: !!argv.verbose })
                                      : await extractWithApify(url, truck.name, { verbose: !!argv.verbose });
        events = normalizeAndFilter(out, { cityDefault: CONFIG.cityDefault, windowDays: CONFIG.windowDays, windowPastDays: CONFIG.windowPastDays });
        if (events.length) break;
      } catch (e) {
        lastErr = e;
        if (argv.verbose) {
          logger.error('candidate-error', { truck: truck.name, url, error: String((e as any)?.stack || e) });
        }
        // On Apify timeout/failure, log and move on to next candidate/truck
      }
    }

    if (argv.dry) {
      if (events.length) {
        try { recordPendingUpserts(truck.name, events); } catch {}
      }
      logger.info('dry-summary', { truck: truck.name, candidates: candidates.length, events: events.length, lastError: lastErr ? String(lastErr) : undefined, sample: events.slice(0, 3) });
      return;
    }

    try {
      const truckId = await upsertTruck({
        name: truck.name,
        website: truck.website || undefined,
        facebook: (truck as Truck).facebook || undefined,
        instagram: (truck as Truck).instagram || undefined,
        notes: truck.notes || undefined,
        active: !!truck.active
      });
      if (events.length) await upsertEvents(truckId, events);
      else logger.info('no-events', { truck: truck.name, error: lastErr ? String(lastErr) : undefined });
    } catch (e) {
      partialErrors += 1;
      logger.error('write-failed', { truck: truck.name, error: String(e) });
      try { recordWriteFailure('events', { truck: truck.name, error: String(e), events }); } catch {}
    }
  }

  const running: Promise<void>[] = [];
  while (idx < limited.length || running.length) {
    while (idx < limited.length && running.length < pool) {
      const t = limited[idx++];
      running.push(processTruck(t).finally(() => {
        const i = running.indexOf((processTruck as unknown) as Promise<void>);
      }));
    }
    await Promise.race(running).catch(() => {});
    for (let i = running.length - 1; i >= 0; i--) {
      // remove settled promises
      // @ts-ignore
      if (running[i].settled) running.splice(i, 1);
    }
    // Fallback: filter promises that have resolved (no native settled flag, so we rebuild the array)
    await Promise.allSettled(running);
    running.length = 0;
  }

  logger.info('ingest-end', { partialErrors });
  if (partialErrors > 0) process.exitCode = 1;
}

main().catch((err) => {
  logger.error('fatal', { error: String(err && err.stack || err) });
  process.exitCode = 2;
});

