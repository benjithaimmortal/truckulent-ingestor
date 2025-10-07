import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { Event, Truck } from '../schemas';

const ROOT = '.cache';

function ensureDir() {
  try { mkdirSync(ROOT, { recursive: true }); } catch {}
}

export function writeSeedSnapshot(seedUrl: string, trucks: Truck[]) {
  ensureDir();
  const file = join(ROOT, `seed_${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ seedUrl, trucks }, null, 2));
  return file;
}

export function recordPendingUpserts(truckName: string, events: Event[]) {
  ensureDir();
  const file = join(ROOT, 'pending_upserts.jsonl');
  const payload = { ts: new Date().toISOString(), truck: truckName, events };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

export function recordWriteFailure(scope: 'truck' | 'events', meta: Record<string, unknown>) {
  ensureDir();
  const file = join(ROOT, 'write_failures.jsonl');
  const payload = { ts: new Date().toISOString(), scope, ...meta };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

