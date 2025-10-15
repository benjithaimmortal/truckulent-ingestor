import fetch from 'node-fetch';
import { CONFIG } from './config';
import { logger } from './logger';

export interface GeocodingResult {
  lat: number;
  lng: number;
  formattedAddress?: string;
  confidence?: number;
  placeName?: string;
  placeTypes?: string[];
  placeId?: string;
}

export interface GeocodingError {
  error: string;
  address: string;
}

/**
 * Geocode an address using Google Maps Geocoding API
 * @param address The address to geocode
 * @param opts Optional configuration
 * @returns Promise<GeocodingResult | null> Returns null if geocoding fails or is disabled
 */
export async function geocodeAddress(
  address: string, 
  opts?: { verbose?: boolean; region?: string }
): Promise<GeocodingResult | null> {
  // Skip geocoding if API key is not configured
  if (!CONFIG.googleMapsApiKey) {
    if (opts?.verbose) {
      logger.info('geocoding-skipped', { reason: 'no-api-key', address });
    }
    return null;
  }

  // Skip if address is empty or too short
  if (!address || address.trim().length < 5) {
    if (opts?.verbose) {
      logger.info('geocoding-skipped', { reason: 'address-too-short', address });
    }
    return null;
  }

  try {
    const params = new URLSearchParams({
      address: address.trim(),
      key: CONFIG.googleMapsApiKey
    });

    // Add region bias if provided (e.g., 'us' for United States)
    if (opts?.region) {
      params.append('region', opts.region);
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;
    
    if (opts?.verbose) {
      logger.info('geocoding-request', { address, url: url.replace(CONFIG.googleMapsApiKey, '***') });
    }

    const response = await fetch(url);
    const data = await response.json() as any;

    if (data.status !== 'OK') {
      if (opts?.verbose) {
        logger.warn('geocoding-failed', { 
          address, 
          status: data.status, 
          error: data.error_message 
        });
      }
      return null;
    }

    if (!data.results || data.results.length === 0) {
      if (opts?.verbose) {
        logger.warn('geocoding-no-results', { address });
      }
      return null;
    }

    const result = data.results[0];
    const location = result.geometry?.location;
    
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      if (opts?.verbose) {
        logger.warn('geocoding-invalid-location', { address, location });
      }
      return null;
    }

    // Extract better place name from address components
    let placeName: string | undefined;
    const addressComponents = result.address_components || [];
    
    // Try to find the establishment name
    const establishment = addressComponents.find(comp => 
      comp.types.includes('establishment') || comp.types.includes('point_of_interest')
    );
    
    if (establishment) {
      placeName = establishment.long_name;
    } else {
      // Fall back to the original address if no establishment name found
      placeName = address;
    }

    const geocodingResult: GeocodingResult = {
      lat: location.lat,
      lng: location.lng,
      formattedAddress: result.formatted_address,
      confidence: result.geometry?.location_type === 'ROOFTOP' ? 1.0 : 0.8,
      placeName: placeName,
      placeTypes: result.types || [],
      placeId: result.place_id
    };

    if (opts?.verbose) {
      logger.info('geocoding-success', { 
        address, 
        lat: geocodingResult.lat, 
        lng: geocodingResult.lng,
        formattedAddress: geocodingResult.formattedAddress,
        confidence: geocodingResult.confidence
      });
    }

    return geocodingResult;

  } catch (error) {
    if (opts?.verbose) {
      logger.error('geocoding-error', { 
        address, 
        error: String(error) 
      });
    }
    return null;
  }
}

/**
 * Geocode multiple addresses in batch
 * @param addresses Array of addresses to geocode
 * @param opts Optional configuration
 * @returns Promise<Array<GeocodingResult | null>> Array of results, null for failed geocoding
 */
export async function geocodeAddresses(
  addresses: string[],
  opts?: { verbose?: boolean; region?: string; delayMs?: number }
): Promise<Array<GeocodingResult | null>> {
  const results: Array<GeocodingResult | null> = [];
  
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    const result = await geocodeAddress(address, opts);
    results.push(result);
    
    // Add delay between requests to respect rate limits
    if (i < addresses.length - 1 && opts?.delayMs) {
      await new Promise(resolve => setTimeout(resolve, opts.delayMs));
    }
  }
  
  return results;
}
