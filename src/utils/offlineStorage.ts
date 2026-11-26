import {
  CachedRoute,
  ChatMessage,
  EnterpriseMapPin,
  LatLng,
  OfflineRouteStep,
  SyncOutboxItem,
  TravelMode,
  Trip,
  TripAlert,
  TripGeofence,
  TripStop,
} from '../types/travel';
import { decryptFromLocalVault, encryptForLocalVault } from './e2ee';
import { bearingToCardinal, computeBearingDegrees, haversineDistanceMeters } from './geofence';

const DB_NAME = 'waypost-offline-db';
const DB_VERSION = 2;

export interface OfflineTripBundle {
  trip: Trip;
  stops: TripStop[];
  geofences: TripGeofence[];
  alerts: TripAlert[];
  messages: ChatMessage[];
  updatedAt: number;
}

interface StoredTripBundleRecord {
  trip: { id: string };
  updatedAt: number;
  encryptedVaultPayload?: string;
  vaultIv?: string;
  // Legacy plaintext fields preserved for seamless read migration
  stops?: TripStop[];
  geofences?: TripGeofence[];
  alerts?: TripAlert[];
  messages?: ChatMessage[];
}

export interface CachedEnterprisePinsRecord {
  source: 'jira' | 'salesforce';
  pins: EnterpriseMapPin[];
  updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tripBundles')) {
        db.createObjectStore('tripBundles', { keyPath: 'trip.id' });
      }
      if (!db.objectStoreNames.contains('cachedRoutes')) {
        db.createObjectStore('cachedRoutes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncOutbox')) {
        db.createObjectStore('syncOutbox', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('enterprisePinsCache')) {
        db.createObjectStore('enterprisePinsCache', { keyPath: 'source' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveOfflineTripBundle(bundle: OfflineTripBundle): Promise<void> {
  try {
    const enc = await encryptForLocalVault(bundle);
    if (!enc) {
      // Do not persist plaintext trip bundles if the encrypted device vault is unavailable
      return;
    }
    const db = await openDB();
    const record: StoredTripBundleRecord = {
      trip: { id: bundle.trip.id },
      updatedAt: bundle.updatedAt,
      encryptedVaultPayload: enc.encryptedPayload,
      vaultIv: enc.iv,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tripBundles', 'readwrite');
      tx.objectStore('tripBundles').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Fallback gracefully in restricted incognito contexts
  }
}

export async function loadOfflineTripBundles(): Promise<OfflineTripBundle[]> {
  try {
    const db = await openDB();
    const rawRecords = await new Promise<StoredTripBundleRecord[]>((resolve, reject) => {
      const tx = db.transaction('tripBundles', 'readonly');
      const req = tx.objectStore('tripBundles').getAll();
      req.onsuccess = () => resolve((req.result as StoredTripBundleRecord[]) || []);
      req.onerror = () => reject(req.error);
    });

    const bundles: OfflineTripBundle[] = [];
    for (const rec of rawRecords) {
      if (rec.encryptedVaultPayload && rec.vaultIv) {
        const decrypted = await decryptFromLocalVault<OfflineTripBundle>(
          rec.encryptedVaultPayload,
          rec.vaultIv
        );
        if (decrypted?.trip?.id) {
          bundles.push(decrypted);
        }
      } else if ((rec as OfflineTripBundle).trip?.title !== undefined) {
        const legacy = rec as OfflineTripBundle;
        bundles.push(legacy);
        // Opportunistically upgrade legacy plaintext bundle to encrypted at rest
        void saveOfflineTripBundle(legacy);
      }
    }

    bundles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return bundles;
  } catch {
    return [];
  }
}

export async function saveCachedRoute(route: CachedRoute): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('cachedRoutes', 'readwrite');
      tx.objectStore('cachedRoutes').put(route);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage error
  }
}

export async function loadCachedRoutesForTrip(tripId: string): Promise<CachedRoute[]> {
  try {
    const db = await openDB();
    return await new Promise<CachedRoute[]>((resolve, reject) => {
      const tx = db.transaction('cachedRoutes', 'readonly');
      const req = tx.objectStore('cachedRoutes').getAll();
      req.onsuccess = () => {
        const all = (req.result as CachedRoute[]) || [];
        resolve(all.filter((r) => r.tripId === tripId));
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

// --- Smart Offline Sync Outbox Storage ---

export async function loadOutboxItems(): Promise<SyncOutboxItem[]> {
  try {
    const db = await openDB();
    const items = await new Promise<SyncOutboxItem[]>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readonly');
      const req = tx.objectStore('syncOutbox').getAll();
      req.onsuccess = () => resolve((req.result as SyncOutboxItem[]) || []);
      req.onerror = () => reject(req.error);
    });
    return items.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function saveOutboxItem(item: SyncOutboxItem): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      tx.objectStore('syncOutbox').put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage error
  }
}

export async function removeOutboxItem(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      tx.objectStore('syncOutbox').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage error
  }
}

// --- Offline Enterprise Map Pins Cache ---

export async function saveEnterprisePinsCache(
  source: 'jira' | 'salesforce',
  pins: EnterpriseMapPin[]
): Promise<void> {
  try {
    const db = await openDB();
    const record: CachedEnterprisePinsRecord = {
      source,
      pins,
      updatedAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('enterprisePinsCache', 'readwrite');
      tx.objectStore('enterprisePinsCache').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage error
  }
}

export async function loadEnterprisePinsCache(
  source: 'jira' | 'salesforce'
): Promise<CachedEnterprisePinsRecord | null> {
  try {
    const db = await openDB();
    return await new Promise<CachedEnterprisePinsRecord | null>((resolve, reject) => {
      const tx = db.transaction('enterprisePinsCache', 'readonly');
      const req = tx.objectStore('enterprisePinsCache').get(source);
      req.onsuccess = () => resolve((req.result as CachedEnterprisePinsRecord) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export function buildRouteCacheKey(
  tripId: string,
  origin: LatLng,
  destination: LatLng,
  travelMode: TravelMode
): string {
  return `${tripId}_${origin.lat.toFixed(4)}_${origin.lng.toFixed(4)}_${destination.lat.toFixed(4)}_${destination.lng.toFixed(4)}_${travelMode}`;
}

export function computeOfflineFallbackRoute(
  tripId: string,
  origin: LatLng,
  destination: LatLng,
  originName: string,
  destinationName: string,
  travelMode: TravelMode
): CachedRoute {
  const straightMeters = haversineDistanceMeters(origin, destination);
  // Urban street grid winding factor
  const detourFactor = travelMode === 'WALKING' ? 1.24 : 1.32;
  const distanceMeters = Math.round(straightMeters * detourFactor);

  const speedMps: Record<TravelMode, number> = {
    WALKING: 1.34,
    BICYCLING: 4.2,
    TRANSIT: 7.5,
    DRIVING: 10.5,
  };
  const durationMillis = Math.max(60000, Math.round((distanceMeters / speedMps[travelMode]) * 1000));

  const bearing = computeBearingDegrees(origin, destination);
  const cardinal = bearingToCardinal(bearing);

  // Create smooth waypoint arc for offline vector display
  const segments = 6;
  const path: LatLng[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    path.push({
      lat: origin.lat + (destination.lat - origin.lat) * t,
      lng: origin.lng + (destination.lng - origin.lng) * t,
    });
  }

  const steps: OfflineRouteStep[] = [
    {
      instruction: `Depart ${originName} heading ${cardinal} (${Math.round(bearing)}°)`,
      distanceMeters: Math.round(distanceMeters * 0.25),
      durationSeconds: Math.round((durationMillis / 1000) * 0.25),
    },
    {
      instruction: `Continue ${cardinal} along offline corridor toward ${destinationName}`,
      distanceMeters: Math.round(distanceMeters * 0.55),
      durationSeconds: Math.round((durationMillis / 1000) * 0.55),
    },
    {
      instruction: `Arrive at ${destinationName}`,
      distanceMeters: Math.round(distanceMeters * 0.2),
      durationSeconds: Math.round((durationMillis / 1000) * 0.2),
    },
  ];

  return {
    id: buildRouteCacheKey(tripId, origin, destination, travelMode),
    tripId,
    originName,
    destinationName,
    origin,
    destination,
    travelMode,
    distanceMeters,
    durationMillis,
    path,
    steps,
    isOfflineEstimate: true,
    computedAt: Date.now(),
  };
}
