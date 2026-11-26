import { LatLng, TripGeofence } from '../types/travel';

const EARTH_RADIUS_METERS = 6371000;

export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function computeBearingDegrees(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function bearingToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatDuration(millis: number): string {
  const mins = Math.max(1, Math.round(millis / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export interface GeofenceTransition {
  geofence: TripGeofence;
  event: 'enter' | 'exit';
  distanceMeters: number;
  dwellDurationSeconds?: number;
  visitSessionId: string;
  idempotencyKey: string;
}

export interface GeofenceEvaluatorState {
  insideSet: Set<string>;
  enteredAt: Map<string, number>;
  visitSessionIds: Map<string, string>;
  pendingEnterHits: Map<string, number>;
  lastFiredAt: Map<string, number>;
}

export function createGeofenceEvaluatorState(): GeofenceEvaluatorState {
  return {
    insideSet: new Set(),
    enteredAt: new Map(),
    visitSessionIds: new Map(),
    pendingEnterHits: new Map(),
    lastFiredAt: new Map(),
  };
}

export interface EvaluateGeofenceOptions {
  /** GPS horizontal accuracy in meters. Pass 0 for simulated/exact taps. */
  accuracyMeters?: number;
  /** True for user-triggered simulated taps (skips multi-fix dwell confirmation & cooldown). */
  isSimulated?: boolean;
  /** Minimum ms between consecutive triggers for the same zone in live GPS mode (default 45s). */
  cooldownMs?: number;
  /** Consecutive inside fixes required for real GPS entry confirmation (default 2). */
  requiredEnterFixes?: number;
  now?: number;
}

/**
 * Evaluates active geofences with:
 * - GPS accuracy gating (rejects noisy fixes where accuracy > max(80m, 0.8 * radius))
 * - Hysteresis exit buffer (exits only past radius + max(15m, min(accuracy, 60m)))
 * - Multi-fix dwell confirmation & per-zone cooldown for live GPS
 * - Visit session tracking with dwellDurationSeconds on exit & idempotency keys
 */
export function evaluateGeofences(
  position: LatLng,
  geofences: TripGeofence[],
  state: GeofenceEvaluatorState,
  options: EvaluateGeofenceOptions = {}
): {
  transitions: GeofenceTransition[];
  nextState: GeofenceEvaluatorState;
  rejectedForAccuracy: boolean;
} {
  const now = options.now ?? Date.now();
  const accuracyMeters = Math.max(0, options.accuracyMeters ?? 0);
  const isSimulated = Boolean(options.isSimulated);
  const cooldownMs = isSimulated ? 0 : options.cooldownMs ?? 45_000;
  const requiredEnterFixes = isSimulated ? 1 : options.requiredEnterFixes ?? 2;

  const nextState: GeofenceEvaluatorState = {
    insideSet: new Set(state.insideSet),
    enteredAt: new Map(state.enteredAt),
    visitSessionIds: new Map(state.visitSessionIds),
    pendingEnterHits: new Map(state.pendingEnterHits),
    lastFiredAt: new Map(state.lastFiredAt),
  };

  const transitions: GeofenceTransition[] = [];
  let rejectedForAccuracy = false;

  for (const gf of geofences) {
    if (!gf.active) continue;

    // 1. Accuracy Gate: ignore wildly inaccurate live GPS fixes
    const maxAcceptableAccuracy = Math.max(80, gf.radiusMeters * 0.8);
    if (!isSimulated && accuracyMeters > maxAcceptableAccuracy) {
      rejectedForAccuracy = true;
      continue;
    }

    const dist = haversineDistanceMeters(position, { lat: gf.lat, lng: gf.lng });
    const wasInside = state.insideSet.has(gf.id);

    // 2. Hysteresis Buffer: require clearing radius + buffer before firing exit
    const hysteresisBuffer = isSimulated ? 0 : Math.max(15, Math.min(accuracyMeters || 15, 60));
    const exitThreshold = gf.radiusMeters + hysteresisBuffer;

    const lastFired = state.lastFiredAt.get(gf.id) || 0;
    const withinCooldown = cooldownMs > 0 && now - lastFired < cooldownMs;

    if (!wasInside) {
      if (dist <= gf.radiusMeters) {
        const hits = (state.pendingEnterHits.get(gf.id) || 0) + 1;
        if (hits >= requiredEnterFixes) {
          nextState.insideSet.add(gf.id);
          nextState.pendingEnterHits.delete(gf.id);
          const sessionId = `visit_${now}_${gf.id.slice(-6)}`;
          nextState.enteredAt.set(gf.id, now);
          nextState.visitSessionIds.set(gf.id, sessionId);

          if (!withinCooldown && (gf.triggerOn === 'enter' || gf.triggerOn === 'both')) {
            nextState.lastFiredAt.set(gf.id, now);
            transitions.push({
              geofence: gf,
              event: 'enter',
              distanceMeters: dist,
              visitSessionId: sessionId,
              idempotencyKey: `${gf.tripId}:${gf.id}:enter:${sessionId}`,
            });
          }
        } else {
          nextState.pendingEnterHits.set(gf.id, hits);
        }
      } else {
        nextState.pendingEnterHits.delete(gf.id);
      }
    } else {
      // Currently inside — remain inside unless past the hysteresis exit threshold
      if (dist > exitThreshold) {
        nextState.insideSet.delete(gf.id);
        nextState.pendingEnterHits.delete(gf.id);
        const enteredTs = state.enteredAt.get(gf.id) || now;
        const dwellDurationSeconds = Math.max(1, Math.round((now - enteredTs) / 1000));
        const sessionId = state.visitSessionIds.get(gf.id) || `visit_${enteredTs}_${gf.id.slice(-6)}`;
        nextState.enteredAt.delete(gf.id);
        nextState.visitSessionIds.delete(gf.id);

        if (!withinCooldown && (gf.triggerOn === 'exit' || gf.triggerOn === 'both')) {
          nextState.lastFiredAt.set(gf.id, now);
          transitions.push({
            geofence: gf,
            event: 'exit',
            distanceMeters: dist,
            dwellDurationSeconds,
            visitSessionId: sessionId,
            idempotencyKey: `${gf.tripId}:${gf.id}:exit:${sessionId}`,
          });
        }
      }
    }
  }

  return { transitions, nextState, rejectedForAccuracy };
}
