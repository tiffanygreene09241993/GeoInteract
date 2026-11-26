import { desc, eq } from 'drizzle-orm';
import { db } from './index.ts';
import { geofenceEvents, users } from './schema.ts';

export interface RecordGeofenceEventInput {
  userId: number;
  tripId: string;
  geofenceId: string;
  geofenceLabel: string;
  stopId?: string | null;
  eventType: 'enter' | 'exit';
  lat: number;
  lng: number;
  distanceMeters?: number | null;
  dwellDurationSeconds?: number | null;
}

export async function recordGeofenceEvent(input: RecordGeofenceEventInput) {
  try {
    const result = await db
      .insert(geofenceEvents)
      .values({
        userId: input.userId,
        tripId: input.tripId,
        geofenceId: input.geofenceId,
        geofenceLabel: input.geofenceLabel,
        stopId: input.stopId ?? null,
        eventType: input.eventType,
        lat: input.lat,
        lng: input.lng,
        distanceMeters: input.distanceMeters ?? null,
        dwellDurationSeconds: input.dwellDurationSeconds ?? null,
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database insert for geofence_events failed:', error);
    throw new Error('Unable to record geofence event. Please try again later.', {
      cause: error,
    });
  }
}

export async function listUserGeofenceEvents(firebaseUid: string, limit = 50) {
  try {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
    return await db
      .select({
        id: geofenceEvents.id,
        tripId: geofenceEvents.tripId,
        geofenceId: geofenceEvents.geofenceId,
        geofenceLabel: geofenceEvents.geofenceLabel,
        stopId: geofenceEvents.stopId,
        eventType: geofenceEvents.eventType,
        lat: geofenceEvents.lat,
        lng: geofenceEvents.lng,
        distanceMeters: geofenceEvents.distanceMeters,
        dwellDurationSeconds: geofenceEvents.dwellDurationSeconds,
        triggeredAt: geofenceEvents.triggeredAt,
      })
      .from(geofenceEvents)
      .innerJoin(users, eq(geofenceEvents.userId, users.id))
      .where(eq(users.uid, firebaseUid))
      .orderBy(desc(geofenceEvents.triggeredAt))
      .limit(safeLimit);
  } catch (error) {
    console.error('Database query for geofence_events failed:', error);
    throw new Error('Unable to load geofence event history. Please try again later.', {
      cause: error,
    });
  }
}
