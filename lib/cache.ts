import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { Event, Truck } from '../schemas';

const ROOT = '.cache';
let currentRunId: string | undefined;

function ensureDir() {
  if (!currentRunId) {
    currentRunId = Date.now().toString();
  }
  const runDir = join(ROOT, currentRunId);
  try { mkdirSync(runDir, { recursive: true }); } catch {}
  return runDir;
}

export function writeSeedSnapshot(seedUrl: string, trucks: Truck[]) {
  const runDir = ensureDir();
  const file = join(runDir, 'seed.json');
  writeFileSync(file, JSON.stringify({ seedUrl, trucks }, null, 2));
  return file;
}

export function recordPendingUpserts(truckName: string, events: Event[]) {
  const runDir = ensureDir();
  const file = join(runDir, 'pending_upserts.jsonl');
  const payload = { ts: new Date().toISOString(), truck: truckName, events };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

export function recordScrapedData(truckName: string, provider: string, url: string, rawData: any[]) {
  const runDir = ensureDir();
  const file = join(runDir, 'scraped_data.jsonl');
  const payload = { ts: new Date().toISOString(), truck: truckName, provider, url, data: rawData };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

export function recordLlmEvents(truckName: string, provider: string, url: string, events: Event[]) {
  const runDir = ensureDir();
  const file = join(runDir, 'llm_events.jsonl');
  const payload = { ts: new Date().toISOString(), truck: truckName, provider, url, events };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

export function recordWriteFailure(scope: 'truck' | 'events', meta: Record<string, unknown>) {
  const runDir = ensureDir();
  const file = join(runDir, 'write_failures.jsonl');
  const payload = { ts: new Date().toISOString(), scope, ...meta };
  appendFileSync(file, JSON.stringify(payload) + '\n');
}

