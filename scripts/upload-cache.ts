import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG } from '../lib/config';
import { logger } from '../lib/logger';
import { upsertTruck, upsertEvents } from '../lib/supabase';
import { Event, Truck } from '../schemas';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('dry', { type: 'boolean', default: false, describe: 'Show what would be uploaded without writing' })
    .option('from', { type: 'string', describe: 'Upload from specific cache file (seed_TIMESTAMP.json or pending_upserts.jsonl)' })
    .option('truck', { type: 'string', describe: 'Upload only events for specific truck name' })
    .option('log-file', { type: 'string', describe: 'Write logs to file' })
    .strict()
    .parseAsync();

  // Generate timestamped log file if not specified
  const logFile = argv['log-file'] as string | undefined;
  if (logFile && !logFile.includes('/')) {
    // If just a filename, put it in logs/ directory with timestamp subdirectory
    const timestamp = Date.now();
    const name = logFile.replace('.jsonl', '');
    logger.setFile(`logs/${timestamp}/${name}.jsonl`);
  } else {
    logger.setFile(logFile);
  }
  logger.info('upload-cache-start', { dry: argv.dry, from: argv.from, truck: argv.truck });

  const cacheDir = '.cache';
  let trucks: Truck[] = [];
  let events: Array<{ truck: string; events: Event[] }> = [];
  let llmEvents: Array<{ truck: string; provider: string; url: string; events: Event[] }> = [];

  // Load seed snapshot if no specific file
  if (!argv.from) {
    try {
      // Look for timestamped subdirectories
      const subdirs = readdirSync(cacheDir).filter(f => {
        const fullPath = join(cacheDir, f);
        return statSync(fullPath).isDirectory() && /^\d+$/.test(f);
      }).sort().reverse(); // Most recent first
      
      if (subdirs.length === 0) {
        logger.error('no-cache-dirs', { cacheDir });
        process.exitCode = 1;
        return;
      }
      
      const latestDir = subdirs[0];
      const seedFile = join(cacheDir, latestDir, 'seed.json');
      const seedData = JSON.parse(readFileSync(seedFile, 'utf8'));
      trucks = seedData.trucks || [];
      logger.info('loaded-seed', { dir: latestDir, trucks: trucks.length });
    } catch (e) {
      logger.error('seed-load-failed', { error: String(e) });
      process.exitCode = 1;
      return;
    }
  } else {
    // Load from specific file - check if it's a path or just filename
    let filePath: string;
    if (argv.from.includes('/')) {
      // Full path provided
      filePath = argv.from;
    } else {
      // Just filename, look in most recent timestamped directory
      const subdirs = readdirSync(cacheDir).filter(f => {
        const fullPath = join(cacheDir, f);
        return statSync(fullPath).isDirectory() && /^\d+$/.test(f);
      }).sort().reverse();
      
      if (subdirs.length === 0) {
        logger.error('no-cache-dirs', { cacheDir });
        process.exitCode = 1;
        return;
      }
      
      filePath = join(cacheDir, subdirs[0], argv.from);
    }
    try {
      if (argv.from.endsWith('.json')) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        trucks = data.trucks || [];
      } else if (argv.from.endsWith('.jsonl')) {
        const lines = readFileSync(filePath, 'utf8').trim().split('\n');
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (entry.events && entry.events.length > 0) {
            if (entry.provider && entry.url) {
              // LLM events format
              llmEvents.push({ truck: entry.truck, provider: entry.provider, url: entry.url, events: entry.events });
            } else {
              // Regular pending upserts format
              events.push({ truck: entry.truck, events: entry.events });
            }
          }
        }
      }
      logger.info('loaded-specific', { file: argv.from, trucks: trucks.length, eventEntries: events.length });
    } catch (e) {
      logger.error('file-load-failed', { file: argv.from, error: String(e) });
      process.exitCode = 1;
      return;
    }
  }

  // Upload trucks
  if (trucks.length > 0) {
    logger.info('uploading-trucks', { count: trucks.length });
    for (const truck of trucks) {
      if (argv.truck && truck.name !== argv.truck) continue;
      try {
        if (argv.dry) {
          logger.info('dry-truck', { name: truck.name, website: truck.website, facebook: truck.facebook, instagram: truck.instagram });
        } else {
          const truckId = await upsertTruck({
            name: truck.name,
            website: truck.website || undefined,
            facebook: truck.facebook || undefined,
            instagram: truck.instagram || undefined,
            notes: truck.notes || undefined,
            active: !!truck.active
          });
          logger.info('truck-upserted', { name: truck.name, id: truckId });
        }
      } catch (e) {
        logger.error('truck-upload-failed', { name: truck.name, error: String(e) });
      }
    }
  }

  // Upload events (regular pending upserts)
  if (events.length > 0) {
    logger.info('uploading-events', { entries: events.length });
    for (const entry of events) {
      if (argv.truck && entry.truck !== argv.truck) continue;
      try {
        if (argv.dry) {
          logger.info('dry-events', { truck: entry.truck, count: entry.events.length, sample: entry.events.slice(0, 2) });
        } else {
          // First get truck ID
          const truckId = await upsertTruck({
            name: entry.truck,
            website: undefined,
            facebook: undefined,
            instagram: undefined,
            notes: undefined,
            active: true
          });
          await upsertEvents(truckId, entry.events);
          logger.info('events-upserted', { truck: entry.truck, count: entry.events.length });
        }
      } catch (e) {
        logger.error('events-upload-failed', { truck: entry.truck, error: String(e) });
      }
    }
  }

  // Upload LLM events
  if (llmEvents.length > 0) {
    logger.info('uploading-llm-events', { entries: llmEvents.length });
    for (const entry of llmEvents) {
      if (argv.truck && entry.truck !== argv.truck) continue;
      try {
        if (argv.dry) {
          logger.info('dry-llm-events', { truck: entry.truck, provider: entry.provider, count: entry.events.length, sample: entry.events.slice(0, 2) });
        } else {
          // First get truck ID
          const truckId = await upsertTruck({
            name: entry.truck,
            website: undefined,
            facebook: undefined,
            instagram: undefined,
            notes: undefined,
            active: true
          });
          await upsertEvents(truckId, entry.events);
          logger.info('llm-events-upserted', { truck: entry.truck, provider: entry.provider, count: entry.events.length });
        }
      } catch (e) {
        logger.error('llm-events-upload-failed', { truck: entry.truck, error: String(e) });
      }
    }
  }

  logger.info('upload-cache-end');
}

main().catch((err) => {
  logger.error('fatal', { error: String(err && err.stack || err) });
  process.exitCode = 2;
});
