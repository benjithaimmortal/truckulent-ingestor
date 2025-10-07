import { Event } from '../schemas';

export function normalizeAndFilter(events: Event[], opts: { cityDefault: string; windowDays: number; windowPastDays?: number }): Event[] {
  const now = Date.now();
  const pastWindow = typeof opts.windowPastDays === 'number' ? opts.windowPastDays : 1;
  const min = now - pastWindow * 24 * 60 * 60 * 1000;
  const max = now + opts.windowDays * 24 * 60 * 60 * 1000;
  return events
    .map((e) => ({
      ...e,
      city: e.city || opts.cityDefault
    }))
    .filter((e) => {
      const t = Date.parse(e.startISO);
      if (Number.isNaN(t)) return false;
      return t >= min && t <= max;
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

