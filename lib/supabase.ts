import fetch from 'node-fetch';
import { Event } from '../schemas';
import { CONFIG } from './config';
import { geocodeAddress } from './geocoding';

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
  // For same-day events, use date + venue + address instead of exact timestamp
  const seen = new Set<string>();
  const uniqueEvents = events.filter(e => {
    // Extract date part (YYYY-MM-DD) from startISO for same-day deduplication
    const datePart = e.startISO.split('T')[0];
    const key = `${datePart}|${e.venue}|${e.rawAddress || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  // Log deduplication stats if events were filtered
  if (events.length > uniqueEvents.length) {
    console.log(`Deduplicated ${events.length - uniqueEvents.length} same-day events (${events.length} -> ${uniqueEvents.length})`);
  }
  
  if (!uniqueEvents.length) return;
  
  // Geocode events that don't have lat/lng coordinates
  const eventsWithGeocoding = await Promise.all(
    uniqueEvents.map(async (e) => {
      // If lat/lng are already present, use them
      if (e.lat && e.lng) {
        return e;
      }
      
      // Try to geocode using rawAddress or venue
      const addressToGeocode = e.rawAddress || e.venue;
      if (!addressToGeocode) {
        return e;
      }
      
      const geocodingResult = await geocodeAddress(addressToGeocode, { 
        verbose: false,
        region: 'us' // Bias towards US addresses
      });
      
      if (geocodingResult) {
        return {
          ...e,
          lat: geocodingResult.lat,
          lng: geocodingResult.lng,
          // Update venue with better place name from Google Maps
          venue: geocodingResult.placeName || e.venue,
          // Update rawAddress with the more accurate formatted address from Google Maps
          rawAddress: geocodingResult.formattedAddress || e.rawAddress
        };
      }
      
      return e;
    })
  );
  
  const body = eventsWithGeocoding.map(e => {
    // Explicitly map only the fields that exist in the database schema
    return {
      truck_id: truckId,
      start_ts: e.startISO,
      end_ts: e.endISO || null,
      venue: e.venue,
      raw_address: e.rawAddress || '',
      city: e.city || CONFIG.cityDefault,
      lat: e.lat,
      lng: e.lng,
      source_url: e.sourceURL,
      confidence: e.confidence,
      last_seen_at: new Date().toISOString()
      // Note: images and text fields are explicitly excluded as they're not in the database schema
    };
  });
  
  const res = await fetch(`${base}/events?on_conflict=truck_id,start_ts,venue,raw_address`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert events ${res.status}: ${text.slice(0, 200)}`);
  }
}

