export type Truck = {
  name: string;
  pref_url?: string | null;
  urls?: string[] | null;
  website?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  notes?: string | null;
  active: boolean;
};

export type Seed = {
  trucks: Truck[];
};

export type Event = {
  truckName: string;
  startISO: string;
  endISO?: string;
  venue: string;
  rawAddress?: string;
  city?: string;
  lat?: number;
  lng?: number;
  sourceURL: string;
  confidence?: number;
  images?: string[];
  text?: string;
};

