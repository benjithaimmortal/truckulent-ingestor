import { Event } from '../schemas';

export function normalizeAndFilter(events: Event[], opts: { cityDefault: string; windowDays?: number; windowPastDays?: number }): Event[] {
  // No time filtering - accept all events regardless of date
  return events
    .map((e) => ({
      ...e,
      city: e.city || opts.cityDefault
    }))
    .filter((e) => {
      // Only filter out events with invalid dates
      const t = Date.parse(e.startISO);
      return !Number.isNaN(t);
    });
}

export function normalizePostsToEvents(posts: any[], opts: { truckName: string; fallbackURL: string }): Event[] {
  // Minimal heuristic placeholder; detailed patterns to be added
  const results: Event[] = [];
  for (const p of posts) {
    const text: string = p.caption || p.text || '';
    const ts: string | undefined = p.timestamp || p.time || p.date;
    const url: string = p.url || p.link || opts.fallbackURL;
    if (!text || !ts) continue;
    const venueMatch = /\b(at|@)\s+([^\n\r]+?)(?:\.|!|,|\n|$)/i.exec(text);
    const venue = venueMatch ? venueMatch[2].trim() : '';
    results.push({
      truckName: opts.truckName,
      startISO: new Date(ts).toISOString(),
      venue,
      sourceURL: url,
      confidence: 0.5
    });
  }
  return results;
}

