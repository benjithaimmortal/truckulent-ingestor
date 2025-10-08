import fetch from 'node-fetch';
import { Event } from '../schemas';
import { CONFIG } from './config';

const base = `${CONFIG.supabaseUrl}/rest/v1`;
const hdrs = {
  'apikey': CONFIG.supabaseServiceRoleKey!,
  'Authorization': `Bearer ${CONFIG.supabaseServiceRoleKey}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation, resolution=merge-duplicates'
};

export async function upsertTruck(t: {name:string; website?:string; facebook?:string; instagram?:string; notes?:string; active:boolean;}): Promise<string> {
  const payload = [{ ...t, last_seen_at: new Date().toISOString() } as any];
  const res = await fetch(`${base}/trucks?on_conflict=name&select=id`, { method: 'POST', headers: hdrs, body: JSON.stringify(payload) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert truck ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows = await res.json() as Array<{ id: string }>;
  return rows[0]?.id;
}

export async function upsertEvents(truckId: string, events: Event[]) {
  if (!events.length) return;
  
  // Deduplicate events by composite key to avoid constraint violations
  const seen = new Set<string>();
  const uniqueEvents = events.filter(e => {
    const key = `${e.startISO}|${e.venue}|${e.rawAddress || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  if (!uniqueEvents.length) return;
  
  const body = uniqueEvents.map(e => ({
    truck_id: truckId,
    start_ts: e.startISO,
    end_ts: e.endISO,
    venue: e.venue,
    raw_address: e.rawAddress || '',
    city: e.city || CONFIG.cityDefault,
    lat: e.lat,
    lng: e.lng,
    source_url: e.sourceURL,
    confidence: e.confidence,
    last_seen_at: new Date().toISOString()
  }));
  
  const res = await fetch(`${base}/events?on_conflict=truck_id,start_ts,venue,raw_address`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert events ${res.status}: ${text.slice(0, 200)}`);
  }
}

