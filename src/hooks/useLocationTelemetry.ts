import { useCallback, useEffect, useRef, useState } from 'react';
import { LatLng, TripGeofence } from '../types/travel';
import {
  createGeofenceEvaluatorState,
  evaluateGeofences,
  GeofenceEvaluatorState,
  GeofenceTransition,
} from '../utils/geofence';

export interface UseLocationTelemetryOptions {
  geofences: TripGeofence[];
  onTransitions: (transitions: GeofenceTransition[], position: LatLng) => void;
  onGpsError?: (message: string) => void;
  onFixRejectedForAccuracy?: (accuracyMeters: number) => void;
}

export function useLocationTelemetry({
  geofences,
  onTransitions,
  onGpsError,
  onFixRejectedForAccuracy,
}: UseLocationTelemetryOptions) {
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [gpsAccuracyMeters, setGpsAccuracyMeters] = useState<number | null>(null);
  const [gpsTrackingEnabled, setGpsTrackingEnabled] = useState(false);
  const [simulateClickMode, setSimulateClickMode] = useState(false);

  const geofenceStateRef = useRef<GeofenceEvaluatorState>(createGeofenceEvaluatorState());
  const geofencesRef = useRef<TripGeofence[]>(geofences);
  geofencesRef.current = geofences;

  const onTransitionsRef = useRef(onTransitions);
  onTransitionsRef.current = onTransitions;

  const onGpsErrorRef = useRef(onGpsError);
  onGpsErrorRef.current = onGpsError;

  const onRejectedRef = useRef(onFixRejectedForAccuracy);
  onRejectedRef.current = onFixRejectedForAccuracy;

  const processLocationUpdate = useCallback(
    (pos: LatLng, options: { accuracyMeters?: number; isSimulated?: boolean } = {}) => {
      const accuracy = options.isSimulated ? 0 : options.accuracyMeters ?? 0;
      setUserLocation(pos);
      setGpsAccuracyMeters(options.isSimulated ? 0 : Math.round(accuracy));

      const { transitions, nextState, rejectedForAccuracy } = evaluateGeofences(
        pos,
        geofencesRef.current,
        geofenceStateRef.current,
        {
          accuracyMeters: accuracy,
          isSimulated: options.isSimulated,
        }
      );

      geofenceStateRef.current = nextState;

      if (rejectedForAccuracy && !options.isSimulated && onRejectedRef.current) {
        onRejectedRef.current(Math.round(accuracy));
      }

      if (transitions.length > 0) {
        onTransitionsRef.current(transitions, pos);
      }
    },
    []
  );

  useEffect(() => {
    if (!gpsTrackingEnabled || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        processLocationUpdate(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          { accuracyMeters: pos.coords.accuracy, isSimulated: false }
        );
      },
      (err) => {
        setGpsTrackingEnabled(false);
        onGpsErrorRef.current?.(
          err?.message || 'GPS permission denied or unavailable. Use Simulate Position on the map to test geofences.'
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [gpsTrackingEnabled, processLocationUpdate]);

  const resetGeofenceState = useCallback(() => {
    geofenceStateRef.current = createGeofenceEvaluatorState();
  }, []);

  return {
    userLocation,
    gpsAccuracyMeters,
    gpsTrackingEnabled,
    setGpsTrackingEnabled,
    simulateClickMode,
    setSimulateClickMode,
    processLocationUpdate,
    resetGeofenceState,
  };
}
