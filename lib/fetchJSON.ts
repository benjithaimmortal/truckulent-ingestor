import fetch from 'node-fetch';
import { Seed } from '../schemas';
import { CONFIG } from './config';

export async function fetchSeedJson(): Promise<Seed> {
  const res = await fetch(CONFIG.seedJsonUrl, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Seed fetch failed ${res.status}`);
  const json = await res.json();
  // Accept either { trucks: [...] } or a top-level array [...]
  if (Array.isArray(json)) {
    return { trucks: json } as Seed;
  }
  if (json && typeof json === 'object' && Array.isArray((json as any).trucks)) {
    return json as Seed;
  }
  throw new Error('Seed JSON invalid: expected array or { trucks: [] }');
}

