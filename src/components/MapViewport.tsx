import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  MapCameraChangedEvent,
  Pin,
  useAdvancedMarkerRef,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Building2,
  Compass,
  ExternalLink,
  LocateFixed,
  Navigation,
  Plus,
  Radio,
  RefreshCw,
  Route as RouteIcon,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import {
  CachedRoute,
  DiscoveredPlace,
  EnterpriseConnectorStatus,
  EnterpriseMapPin,
  GeofenceEntryCue,
  LatLng,
  OfflineRouteStep,
  TravelMode,
  TripGeofence,
  TripStop,
} from '../types/travel';
import { formatDistance, formatDuration, haversineDistanceMeters } from '../utils/geofence';
import { triggerHaptic } from '../utils/haptics';
import { buildRouteCacheKey, computeOfflineFallbackRoute } from '../utils/offlineStorage';
import { sanitizeExternalUrl } from '../utils/url';
import { PlaceAutocompleteBar } from './PlaceAutocompleteBar';

interface MapViewportProps {
  center: LatLng;
  onCenterChanged: (center: LatLng) => void;
  stops: TripStop[];
  discoveredPlaces: DiscoveredPlace[];
  geofences: TripGeofence[];
  userLocation: LatLng | null;
  activeRouteRequest: {
    origin: LatLng;
    destination: LatLng;
    originName: string;
    destinationName: string;
    travelMode: TravelMode;
  } | null;
  cachedRoutes: CachedRoute[];
  onRouteComputed: (route: CachedRoute) => void;
  onClearRoute: () => void;
  onAddPlaceToItinerary: (place: DiscoveredPlace) => void;
  onCreateGeofenceAt: (lat: number, lng: number, label: string) => void;
  onStartRouteTo: (dest: LatLng, name: string) => void;
  onPlaceSelected: (place: DiscoveredPlace) => void;
  onQuickCategorySearch: (query: string, includedTypes: string[]) => void;
  isDark: boolean;
  isOffline: boolean;
  simulateClickMode: boolean;
  onSimulateLocation: (pos: LatLng) => void;
  highlightNormalTasks: boolean;
  enterpriseStatus: EnterpriseConnectorStatus;
  jiraPins: EnterpriseMapPin[];
  salesforcePins: EnterpriseMapPin[];
  showJiraLayer: boolean;
  showSalesforceLayer: boolean;
  enterpriseLoading: { jira: boolean; salesforce: boolean };
  onToggleJiraLayer: () => void;
  onToggleSalesforceLayer: () => void;
  onLogEnterprisePinCheckIn: (pin: EnterpriseMapPin) => Promise<void>;
  onAddEnterprisePinToItinerary?: (pin: EnterpriseMapPin) => void;
  onBoundsChanged?: (bounds: { north: number; south: number; east: number; west: number }) => void;
  onSyncAreaEnterprise?: () => Promise<void>;
  onBuildFieldDayFromMap?: () => Promise<void>;
  buildingFieldDay?: boolean;
  triggeredGeofenceCues?: GeofenceEntryCue[];
}

function findMatchingEntryCue(
  point: LatLng,
  cues: GeofenceEntryCue[],
  stopId?: string
): GeofenceEntryCue | undefined {
  if (!cues.length) return undefined;
  let matched: GeofenceEntryCue | undefined;
  for (const cue of cues) {
    const byStop = Boolean(stopId && cue.linkedStopId && cue.linkedStopId === stopId);
    const byDistance =
      !byStop &&
      haversineDistanceMeters(point, { lat: cue.lat, lng: cue.lng }) <=
        Math.max(cue.radiusMeters, 150);
    if (byStop || byDistance) {
      if (!matched || cue.triggeredAt > matched.triggeredAt) {
        matched = cue;
      }
    }
  }
  return matched;
}

const Pin3DAnimationWrapper: React.FC<{
  cue?: GeofenceEntryCue;
  children: React.ReactNode;
}> = ({ cue, children }) => {
  if (!cue) {
    return <>{children}</>;
  }
  return (
    <div key={cue.id} className="geofence-pin-3d-stage" data-geofence-entry-active="true">
      <span aria-hidden="true" className="geofence-pin-3d-ring" />
      <span aria-hidden="true" className="geofence-pin-3d-ring geofence-pin-3d-ring-delayed" />
      <span className="geofence-pin-3d-badge rounded-full bg-emerald-400 text-slate-950 border border-emerald-100/90 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase shadow-lg">
        Arrived
      </span>
      <div className="geofence-pin-3d-body">{children}</div>
    </div>
  );
};

const GeofenceCirclesLayer: React.FC<{
  geofences: TripGeofence[];
  triggeredGeofenceIds: Set<string>;
}> = ({ geofences, triggeredGeofenceIds }) => {
  const map = useMap();
  const circlesRef = useRef<google.maps.Circle[]>([]);

  useEffect(() => {
    circlesRef.current.forEach((c) => c.setMap(null));
    circlesRef.current = [];
    if (!map) return;

    const created = geofences
      .filter((g) => g.active)
      .map((g) => {
        const isTriggered = triggeredGeofenceIds.has(g.id);
        return new google.maps.Circle({
          map,
          center: { lat: g.lat, lng: g.lng },
          radius: g.radiusMeters,
          strokeColor: isTriggered ? '#34D399' : '#10B981',
          strokeOpacity: isTriggered ? 1 : 0.85,
          strokeWeight: isTriggered ? 3 : 1.5,
          fillColor: isTriggered ? '#38BDF8' : '#10B981',
          fillOpacity: isTriggered ? 0.24 : 0.14,
          clickable: false,
        });
      });

    circlesRef.current = created;
    return () => {
      created.forEach((c) => c.setMap(null));
    };
  }, [map, geofences, triggeredGeofenceIds]);

  return null;
};

const RouteLayer: React.FC<{
  routeRequest: MapViewportProps['activeRouteRequest'];
  cachedRoutes: CachedRoute[];
  isOffline: boolean;
  tripId: string;
  onRouteComputed: (route: CachedRoute) => void;
  onActiveRouteChange: (route: CachedRoute | null, error: string | null, loading: boolean) => void;
}> = ({ routeRequest, cachedRoutes, isOffline, tripId, onRouteComputed, onActiveRouteChange }) => {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const polylinesRef = useRef<google.maps.Polyline[]>([]);
  const cachedRoutesRef = useRef(cachedRoutes);
  cachedRoutesRef.current = cachedRoutes;
  const onRouteComputedRef = useRef(onRouteComputed);
  onRouteComputedRef.current = onRouteComputed;
  const onActiveRouteChangeRef = useRef(onActiveRouteChange);
  onActiveRouteChangeRef.current = onActiveRouteChange;

  useEffect(() => {
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    if (!routeRequest) {
      onActiveRouteChangeRef.current(null, null, false);
      return;
    }

    const cacheKey = buildRouteCacheKey(
      tripId,
      routeRequest.origin,
      routeRequest.destination,
      routeRequest.travelMode
    );
    const cached = cachedRoutesRef.current.find((r) => r.id === cacheKey);

    // Use cached or offline fallback route immediately when offline
    if (isOffline) {
      const offlineRoute =
        cached ||
        computeOfflineFallbackRoute(
          tripId,
          routeRequest.origin,
          routeRequest.destination,
          routeRequest.originName,
          routeRequest.destinationName,
          routeRequest.travelMode
        );

      if (map && typeof google !== 'undefined') {
        const line = new google.maps.Polyline({
          path: offlineRoute.path,
          strokeColor: '#F59E0B',
          strokeOpacity: 0.9,
          strokeWeight: 4,
          map,
        });
        polylinesRef.current = [line];
      }
      onActiveRouteChangeRef.current(offlineRoute, null, false);
      return () => {
        polylinesRef.current.forEach((p) => p.setMap(null));
        polylinesRef.current = [];
      };
    }

    if (!routesLib || !map) return;

    onActiveRouteChangeRef.current(cached || null, null, true);
    let cancelled = false;

    const request = {
      origin: routeRequest.origin,
      destination: routeRequest.destination,
      travelMode: routeRequest.travelMode,
      fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'legs'],
    };

    (routesLib.Route as any)
      .computeRoutes(request)
      .then(({ routes }: { routes: any[] }) => {
        if (cancelled) return;
        if (!routes || routes.length === 0) {
          onActiveRouteChangeRef.current(null, 'No route found for this travel mode.', false);
          return;
        }

        const primaryRoute = routes[0];
        const newPolylines: google.maps.Polyline[] = primaryRoute.createPolylines();
        const extractedPath: LatLng[] = [];

        newPolylines.forEach((polyline: google.maps.Polyline) => {
          polyline.setOptions({
            strokeColor: '#38BDF8',
            strokeWeight: 5,
            strokeOpacity: 0.92,
          });
          polyline.setMap(map);
          const pts = polyline.getPath()?.getArray?.() || [];
          pts.forEach((pt: google.maps.LatLng) => {
            extractedPath.push({ lat: pt.lat(), lng: pt.lng() });
          });
        });
        polylinesRef.current = newPolylines;

        if (primaryRoute.viewport) {
          map.fitBounds(primaryRoute.viewport);
        }

        const steps: OfflineRouteStep[] = [];
        if (Array.isArray(primaryRoute.legs)) {
          for (const leg of primaryRoute.legs) {
            if (Array.isArray(leg.steps)) {
              for (const st of leg.steps) {
                const instr = st.instructions || st.navigationInstruction?.instructions;
                if (instr) {
                  steps.push({
                    instruction: String(instr),
                    distanceMeters: Number(st.distanceMeters || 0),
                    durationSeconds: Math.round(Number(st.staticDurationMillis || st.durationMillis || 0) / 1000),
                  });
                }
              }
            }
          }
        }

        const routeObj: CachedRoute = {
          id: cacheKey,
          tripId,
          originName: routeRequest.originName,
          destinationName: routeRequest.destinationName,
          origin: routeRequest.origin,
          destination: routeRequest.destination,
          travelMode: routeRequest.travelMode,
          distanceMeters: Number(primaryRoute.distanceMeters || 0),
          durationMillis: Number(primaryRoute.durationMillis || 0),
          path: extractedPath.length > 0 ? extractedPath : [routeRequest.origin, routeRequest.destination],
          steps:
            steps.length > 0
              ? steps
              : [
                  {
                    instruction: `Follow ${routeRequest.travelMode.toLowerCase()} route to ${routeRequest.destinationName}`,
                    distanceMeters: Number(primaryRoute.distanceMeters || 0),
                    durationSeconds: Math.round(Number(primaryRoute.durationMillis || 0) / 1000),
                  },
                ],
          isOfflineEstimate: false,
          computedAt: Date.now(),
        };

        onRouteComputedRef.current(routeObj);
        onActiveRouteChangeRef.current(routeObj, null, false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        const msg = String(err?.message || err || '');
        if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        const fallback =
          cached ||
          computeOfflineFallbackRoute(
            tripId,
            routeRequest.origin,
            routeRequest.destination,
            routeRequest.originName,
            routeRequest.destinationName,
            routeRequest.travelMode
          );
        onActiveRouteChangeRef.current(fallback, null, false);
      });

    return () => {
      cancelled = true;
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [routesLib, map, routeRequest, isOffline, tripId]);

  return null;
};

interface SelectedPinItem {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
  rating?: number;
  category?: string;
  googleMapsUri?: string;
  isSavedStop: boolean;
  priority?: TripStop['priority'];
  enterprisePin?: EnterpriseMapPin;
}

const StopMarker: React.FC<{
  stop: TripStop;
  highlightNormal: boolean;
  entryCue?: GeofenceEntryCue;
  onSelect: (item: SelectedPinItem, marker: google.maps.marker.AdvancedMarkerElement | null) => void;
}> = ({ stop, highlightNormal, entryCue, onSelect }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();

  const colors = useMemo(() => {
    if (entryCue) {
      return { bg: '#10B981', border: '#38BDF8', glyph: '#0B0F17' };
    }
    if (stop.status === 'completed') {
      return { bg: '#10B981', border: '#047857', glyph: '#FFFFFF' };
    }
    if (stop.priority === 'high') {
      return { bg: '#EF4444', border: '#B91C1C', glyph: '#FFFFFF' };
    }
    if (stop.priority === 'normal' && highlightNormal) {
      return { bg: '#F59E0B', border: '#B45309', glyph: '#0B0F17' };
    }
    return { bg: '#475569', border: '#1E293B', glyph: '#F8FAFC' };
  }, [stop.status, stop.priority, highlightNormal, entryCue]);

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: stop.lat, lng: stop.lng }}
      title={stop.name}
      zIndex={entryCue ? 500 : undefined}
      onClick={() => {
        triggerHaptic('light');
        onSelect(
          {
            id: stop.id,
            name: stop.name,
            address: stop.address,
            lat: stop.lat,
            lng: stop.lng,
            placeId: stop.placeId,
            rating: stop.rating,
            category: stop.category,
            googleMapsUri: stop.googleMapsUri,
            isSavedStop: true,
            priority: stop.priority,
          },
          marker
        );
      }}
    >
      <Pin3DAnimationWrapper cue={entryCue}>
        <Pin
          background={colors.bg}
          borderColor={colors.border}
          glyphColor={colors.glyph}
          scale={entryCue ? 1.2 : stop.priority === 'normal' && highlightNormal ? 1.15 : 1}
        >
          {String(stop.orderIndex + 1)}
        </Pin>
      </Pin3DAnimationWrapper>
    </AdvancedMarker>
  );
};

const DiscoveredMarker: React.FC<{
  place: DiscoveredPlace;
  entryCue?: GeofenceEntryCue;
  onSelect: (item: SelectedPinItem, marker: google.maps.marker.AdvancedMarkerElement | null) => void;
}> = ({ place, entryCue, onSelect }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: place.lat, lng: place.lng }}
      title={place.name}
      zIndex={entryCue ? 480 : undefined}
      onClick={() => {
        triggerHaptic('light');
        onSelect(
          {
            id: place.placeId || place.name,
            name: place.name,
            address: place.address,
            lat: place.lat,
            lng: place.lng,
            placeId: place.placeId,
            rating: place.rating,
            category: place.primaryType,
            googleMapsUri: place.googleMapsUri,
            isSavedStop: false,
          },
          marker
        );
      }}
    >
      <Pin3DAnimationWrapper cue={entryCue}>
        <Pin
          background="#10B981"
          borderColor={entryCue ? '#38BDF8' : '#065F46'}
          glyphColor="#0B0F17"
          scale={entryCue ? 1.15 : 0.95}
        />
      </Pin3DAnimationWrapper>
    </AdvancedMarker>
  );
};

const EnterpriseMarker: React.FC<{
  pin: EnterpriseMapPin;
  entryCue?: GeofenceEntryCue;
  onSelect: (item: SelectedPinItem, marker: google.maps.marker.AdvancedMarkerElement | null) => void;
}> = ({ pin, entryCue, onSelect }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const isJira = pin.source === 'jira';

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: pin.lat, lng: pin.lng }}
      title={`${isJira ? 'Jira' : 'Salesforce'}: ${pin.title}`}
      zIndex={entryCue ? 490 : undefined}
      onClick={() => {
        triggerHaptic('light');
        onSelect(
          {
            id: pin.id,
            name: pin.title,
            address: pin.address,
            lat: pin.lat,
            lng: pin.lng,
            placeId: pin.id,
            category: [
              isJira ? `Jira ${pin.externalKey}` : 'Salesforce Account',
              pin.status,
              pin.priority,
            ]
              .filter(Boolean)
              .join(' · '),
            isSavedStop: false,
            enterprisePin: pin,
          },
          marker
        );
      }}
    >
      <Pin3DAnimationWrapper cue={entryCue}>
        <Pin
          background={isJira ? '#4F46E5' : '#0284C7'}
          borderColor={entryCue ? '#34D399' : isJira ? '#312E81' : '#075985'}
          glyphColor="#FFFFFF"
          scale={entryCue ? 1.2 : 1.05}
        >
          {isJira ? 'J' : 'S'}
        </Pin>
      </Pin3DAnimationWrapper>
    </AdvancedMarker>
  );
};

const GeofenceEntryBeaconMarker: React.FC<{ cue: GeofenceEntryCue }> = ({ cue }) => (
  <AdvancedMarker position={{ lat: cue.lat, lng: cue.lng }} title={`Entered ${cue.label}`} zIndex={510}>
    <Pin3DAnimationWrapper cue={cue}>
      <Pin background="#10B981" borderColor="#38BDF8" glyphColor="#0B0F17" scale={1.15}>
        ★
      </Pin>
    </Pin3DAnimationWrapper>
  </AdvancedMarker>
);

export const MapViewport: React.FC<MapViewportProps> = ({
  center,
  onCenterChanged,
  stops,
  discoveredPlaces,
  geofences,
  userLocation,
  activeRouteRequest,
  cachedRoutes,
  onRouteComputed,
  onClearRoute,
  onAddPlaceToItinerary,
  onCreateGeofenceAt,
  onStartRouteTo,
  onPlaceSelected,
  onQuickCategorySearch,
  isDark,
  isOffline,
  simulateClickMode,
  onSimulateLocation,
  highlightNormalTasks,
  enterpriseStatus,
  jiraPins,
  salesforcePins,
  showJiraLayer,
  showSalesforceLayer,
  enterpriseLoading,
  onToggleJiraLayer,
  onToggleSalesforceLayer,
  onLogEnterprisePinCheckIn,
  onAddEnterprisePinToItinerary,
  onBoundsChanged,
  onSyncAreaEnterprise,
  onBuildFieldDayFromMap,
  buildingFieldDay = false,
  triggeredGeofenceCues = [],
}) => {
  const map = useMap();
  const [selectedPin, setSelectedPin] = useState<{
    item: SelectedPinItem;
    marker: google.maps.marker.AdvancedMarkerElement | null;
  } | null>(null);
  const [loggingPinId, setLoggingPinId] = useState<string | null>(null);
  const [activeRoute, setActiveRoute] = useState<CachedRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const onCenterChangedRef = useRef(onCenterChanged);
  onCenterChangedRef.current = onCenterChanged;
  const onBoundsChangedRef = useRef(onBoundsChanged);
  onBoundsChangedRef.current = onBoundsChanged;
  const lastReportedCenterRef = useRef<LatLng | null>(null);
  const centerDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (centerDebounceRef.current !== null) {
        window.clearTimeout(centerDebounceRef.current);
      }
    };
  }, []);

  const handleCameraChanged = useCallback((ev: MapCameraChangedEvent) => {
    const b = ev.detail?.bounds;
    if (
      onBoundsChangedRef.current &&
      b &&
      typeof b.north === 'number' &&
      typeof b.south === 'number' &&
      typeof b.east === 'number' &&
      typeof b.west === 'number'
    ) {
      onBoundsChangedRef.current(b);
    }

    const c = ev.detail?.center;
    if (c && typeof c.lat === 'number' && typeof c.lng === 'number') {
      const nextCenter = { lat: c.lat, lng: c.lng };
      lastReportedCenterRef.current = nextCenter;
      if (centerDebounceRef.current !== null) {
        window.clearTimeout(centerDebounceRef.current);
      }
      centerDebounceRef.current = window.setTimeout(() => {
        centerDebounceRef.current = null;
        onCenterChangedRef.current(nextCenter);
      }, 180);
    }
  }, []);

  useEffect(() => {
    if (!map || !center) return;
    // Ignore center updates that originated from the map's own camera movement
    const lastCamera = lastReportedCenterRef.current;
    if (
      lastCamera &&
      Math.abs(lastCamera.lat - center.lat) < 1e-5 &&
      Math.abs(lastCamera.lng - center.lng) < 1e-5
    ) {
      return;
    }
    const current = map.getCenter();
    if (current) {
      const dLat = Math.abs(current.lat() - center.lat);
      const dLng = Math.abs(current.lng() - center.lng);
      if (dLat > 0.0005 || dLng > 0.0005) {
        lastReportedCenterRef.current = center;
        map.panTo(center);
      }
    }
  }, [map, center]);

  const handleActiveRouteChange = useCallback(
    (route: CachedRoute | null, error: string | null, loading: boolean) => {
      setActiveRoute(route);
      setRouteError(error);
      setRouteLoading(loading);
    },
    []
  );

  const activeEnterprisePins = useMemo(() => {
    const pins: EnterpriseMapPin[] = [];
    if (showJiraLayer) pins.push(...jiraPins);
    if (showSalesforceLayer) pins.push(...salesforcePins);
    return pins;
  }, [showJiraLayer, showSalesforceLayer, jiraPins, salesforcePins]);

  // Offline SVG Vector Fallback Projection
  const offlineViewportBounds = useMemo(() => {
    const pts: LatLng[] = [
      center,
      ...stops.map((s) => ({ lat: s.lat, lng: s.lng })),
      ...geofences.map((g) => ({ lat: g.lat, lng: g.lng })),
      ...activeEnterprisePins.map((ep) => ({ lat: ep.lat, lng: ep.lng })),
      ...(userLocation ? [userLocation] : []),
    ];
    let minLat = center.lat - 0.015;
    let maxLat = center.lat + 0.015;
    let minLng = center.lng - 0.02;
    let maxLng = center.lng + 0.02;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    const padLat = (maxLat - minLat) * 0.18 || 0.01;
    const padLng = (maxLng - minLng) * 0.18 || 0.01;
    return {
      minLat: minLat - padLat,
      maxLat: maxLat + padLat,
      minLng: minLng - padLng,
      maxLng: maxLng + padLng,
    };
  }, [center, stops, geofences, activeEnterprisePins, userLocation]);

  const projectPoint = useCallback(
    (p: LatLng) => {
      const x =
        ((p.lng - offlineViewportBounds.minLng) /
          (offlineViewportBounds.maxLng - offlineViewportBounds.minLng)) *
        800;
      const y =
        (1 -
          (p.lat - offlineViewportBounds.minLat) /
            (offlineViewportBounds.maxLat - offlineViewportBounds.minLat)) *
        500;
      return { x, y };
    },
    [offlineViewportBounds]
  );

  const tripId = stops[0]?.tripId || 'local';

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-100 dark:bg-[#0B0F17]">
      {/* Online Google Map Canvas */}
      <div className={`w-full h-full ${isOffline ? 'opacity-20 pointer-events-none' : 'opacity-100'}`}>
        <GoogleMap
          mapId="DEMO_MAP_ID"
          colorScheme={isDark ? 'DARK' : 'LIGHT'}
          defaultCenter={center}
          defaultZoom={13}
          gestureHandling="greedy"
          disableDefaultUI={true}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          onCameraChanged={handleCameraChanged}
          onClick={(ev) => {
            if (simulateClickMode && ev.detail?.latLng) {
              triggerHaptic('medium');
              onSimulateLocation({
                lat: ev.detail.latLng.lat,
                lng: ev.detail.latLng.lng,
              });
            } else {
              setSelectedPin(null);
            }
          }}
          className="w-full h-full"
        >
          <GeofenceCirclesLayer
            geofences={geofences}
            triggeredGeofenceIds={new Set(triggeredGeofenceCues.map((c) => c.geofenceId))}
          />
          <RouteLayer
            routeRequest={activeRouteRequest}
            cachedRoutes={cachedRoutes}
            isOffline={isOffline}
            tripId={tripId}
            onRouteComputed={onRouteComputed}
            onActiveRouteChange={handleActiveRouteChange}
          />

          {stops.map((stop) => (
            <StopMarker
              key={stop.id}
              stop={stop}
              highlightNormal={highlightNormalTasks}
              entryCue={findMatchingEntryCue(stop, triggeredGeofenceCues, stop.id)}
              onSelect={(item, marker) => setSelectedPin({ item, marker })}
            />
          ))}

          {discoveredPlaces
            .filter((dp) => !stops.some((s) => s.placeId && s.placeId === dp.placeId))
            .map((place, idx) => (
              <DiscoveredMarker
                key={place.placeId || `${place.name}_${idx}`}
                place={place}
                entryCue={findMatchingEntryCue(place, triggeredGeofenceCues)}
                onSelect={(item, marker) => setSelectedPin({ item, marker })}
              />
            ))}

          {activeEnterprisePins.map((pin) => (
            <EnterpriseMarker
              key={pin.id}
              pin={pin}
              entryCue={findMatchingEntryCue(pin, triggeredGeofenceCues)}
              onSelect={(item, marker) => setSelectedPin({ item, marker })}
            />
          ))}

          {triggeredGeofenceCues
            .filter(
              (cue) =>
                !stops.some(
                  (s) =>
                    (cue.linkedStopId && s.id === cue.linkedStopId) ||
                    haversineDistanceMeters(s, cue) < 80
                )
            )
            .map((cue) => (
              <GeofenceEntryBeaconMarker key={cue.id} cue={cue} />
            ))}

          {userLocation && (
            <AdvancedMarker position={userLocation} title="Current Explorer Location">
              <div className="relative flex items-center justify-center">
                <div className="w-7 h-7 rounded-full bg-sky-500/25 flex items-center justify-center">
                  <div className="w-3.5 h-3.5 rounded-full bg-sky-400 border-2 border-white shadow-md" />
                </div>
              </div>
            </AdvancedMarker>
          )}

          {selectedPin && selectedPin.marker && (
            <InfoWindow
              anchor={selectedPin.marker}
              onCloseClick={() => setSelectedPin(null)}
              maxWidth={280}
            >
              <div className="p-1.5 text-slate-900 space-y-2 min-w-[220px]">
                <div>
                  <h4 className="font-semibold text-sm leading-snug">{selectedPin.item.name}</h4>
                  <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">
                    {selectedPin.item.address || `${selectedPin.item.lat.toFixed(4)}, ${selectedPin.item.lng.toFixed(4)}`}
                  </p>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1 tabular-nums">
                    {selectedPin.item.category && <span>{selectedPin.item.category}</span>}
                    {typeof selectedPin.item.rating === 'number' && (
                      <>
                        {selectedPin.item.category && <span>·</span>}
                        <span>★ {selectedPin.item.rating.toFixed(1)}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-200">
                  {!selectedPin.item.isSavedStop && (
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedPin.item.enterprisePin && onAddEnterprisePinToItinerary) {
                          onAddEnterprisePinToItinerary(selectedPin.item.enterprisePin);
                        } else {
                          onAddPlaceToItinerary({
                            placeId: selectedPin.item.placeId,
                            name: selectedPin.item.name,
                            address: selectedPin.item.address,
                            lat: selectedPin.item.lat,
                            lng: selectedPin.item.lng,
                            rating: selectedPin.item.rating,
                            primaryType: selectedPin.item.category,
                            googleMapsUri: selectedPin.item.googleMapsUri,
                          });
                        }
                        setSelectedPin(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-2.5 py-1.5 text-xs font-medium hover:bg-emerald-700"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add to Trip
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      onStartRouteTo(
                        { lat: selectedPin.item.lat, lng: selectedPin.item.lng },
                        selectedPin.item.name
                      );
                      setSelectedPin(null);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white px-2.5 py-1.5 text-xs font-medium hover:bg-slate-800"
                  >
                    <Navigation className="w-3.5 h-3.5" />
                    Route
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onCreateGeofenceAt(
                        selectedPin.item.lat,
                        selectedPin.item.lng,
                        selectedPin.item.name
                      );
                      setSelectedPin(null);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 text-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100"
                  >
                    <Radio className="w-3.5 h-3.5" />
                    Geofence
                  </button>

                  {selectedPin.item.enterprisePin && (
                    <button
                      type="button"
                      disabled={loggingPinId === selectedPin.item.enterprisePin.id}
                      onClick={async () => {
                        const pin = selectedPin.item.enterprisePin;
                        if (!pin) return;
                        triggerHaptic('medium');
                        setLoggingPinId(pin.id);
                        try {
                          await onLogEnterprisePinCheckIn(pin);
                        } finally {
                          setLoggingPinId(null);
                          setSelectedPin(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 text-white px-2.5 py-1.5 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Building2 className="w-3.5 h-3.5" />
                      {loggingPinId === selectedPin.item.enterprisePin.id
                        ? 'Logging...'
                        : 'Log Check-In'}
                    </button>
                  )}

                  {sanitizeExternalUrl(selectedPin.item.enterprisePin?.externalUrl) && (
                    <a
                      href={sanitizeExternalUrl(selectedPin.item.enterprisePin?.externalUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 text-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100"
                    >
                      <ExternalLink className="w-3 h-3" />
                      {selectedPin.item.enterprisePin?.source === 'jira' ? 'Jira' : 'Salesforce'}
                    </a>
                  )}

                  {sanitizeExternalUrl(selectedPin.item.googleMapsUri) && (
                    <a
                      href={sanitizeExternalUrl(selectedPin.item.googleMapsUri)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 text-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Maps
                    </a>
                  )}
                </div>
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </div>

      {/* Offline Remote Cartographic Vector Overlay */}
      {isOffline && (
        <div className="absolute inset-0 z-10 flex flex-col justify-between bg-[#0B0F17]/95 text-slate-100 p-4">
          <div className="flex items-center justify-between gap-3 pt-16 sm:pt-14">
            <div className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-300">
              <WifiOff className="w-3.5 h-3.5" />
              <span>Offline Vector Grid · Cached Stops, Geofences &amp; Offline Routing</span>
            </div>
          </div>

          <svg
            viewBox="0 0 800 500"
            className="w-full h-full flex-1 my-2 rounded-2xl border border-slate-800 bg-[#0E1420]"
            onClick={(e) => {
              if (!simulateClickMode) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const rx = (e.clientX - rect.left) / rect.width;
              const ry = (e.clientY - rect.top) / rect.height;
              const lng =
                offlineViewportBounds.minLng +
                rx * (offlineViewportBounds.maxLng - offlineViewportBounds.minLng);
              const lat =
                offlineViewportBounds.minLat +
                (1 - ry) * (offlineViewportBounds.maxLat - offlineViewportBounds.minLat);
              triggerHaptic('medium');
              onSimulateLocation({ lat, lng });
            }}
          >
            {/* Subtle Coordinate Grid */}
            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
              <line
                key={`vx_${i}`}
                x1={i * 100}
                y1={0}
                x2={i * 100}
                y2={500}
                stroke="#1E293B"
                strokeWidth="1"
              />
            ))}
            {[1, 2, 3, 4].map((i) => (
              <line
                key={`hy_${i}`}
                x1={0}
                y1={i * 100}
                x2={800}
                y2={i * 100}
                stroke="#1E293B"
                strokeWidth="1"
              />
            ))}

            {/* Geofence Zones */}
            {geofences
              .filter((g) => g.active)
              .map((g) => {
                const pt = projectPoint({ lat: g.lat, lng: g.lng });
                const isTriggered = triggeredGeofenceCues.some((c) => c.geofenceId === g.id);
                return (
                  <g key={g.id}>
                    {isTriggered && (
                      <>
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={30}
                          fill="rgba(16, 185, 129, 0.22)"
                          stroke="#34D399"
                          strokeWidth="2.5"
                          className="geofence-svg-ring-pulse"
                        />
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={30}
                          fill="none"
                          stroke="#38BDF8"
                          strokeWidth="2"
                          className="geofence-svg-ring-pulse geofence-svg-ring-pulse-delayed"
                        />
                      </>
                    )}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={38}
                      fill={isTriggered ? 'rgba(56, 189, 248, 0.22)' : 'rgba(16, 185, 129, 0.14)'}
                      stroke={isTriggered ? '#34D399' : '#10B981'}
                      strokeWidth={isTriggered ? '2.5' : '1.5'}
                      strokeDasharray="4 4"
                    />
                    <text x={pt.x} y={pt.y + 52} textAnchor="middle" fill="#6EE7B7" fontSize="11">
                      {g.label}
                    </text>
                  </g>
                );
              })}

            {/* Cached or Offline Computed Route */}
            {activeRoute && activeRoute.path.length > 1 && (
              <polyline
                fill="none"
                stroke={activeRoute.isOfflineEstimate ? '#F59E0B' : '#38BDF8'}
                strokeWidth="3.5"
                strokeDasharray={activeRoute.isOfflineEstimate ? '6 4' : undefined}
                points={activeRoute.path
                  .map((p) => {
                    const pt = projectPoint(p);
                    return `${pt.x},${pt.y}`;
                  })
                  .join(' ')}
              />
            )}

            {/* Saved Stops */}
            {stops.map((s) => {
              const pt = projectPoint({ lat: s.lat, lng: s.lng });
              const entryCue = findMatchingEntryCue(s, triggeredGeofenceCues, s.id);
              const fill = entryCue
                ? '#10B981'
                : s.priority === 'high'
                ? '#EF4444'
                : s.priority === 'normal' && highlightNormalTasks
                ? '#F59E0B'
                : '#64748B';
              return (
                <g
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => {
                    triggerHaptic('light');
                    onStartRouteTo({ lat: s.lat, lng: s.lng }, s.name);
                  }}
                >
                  {entryCue && (
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={16}
                      fill="rgba(16, 185, 129, 0.28)"
                      stroke="#38BDF8"
                      strokeWidth="2"
                      className="geofence-svg-ring-pulse"
                    />
                  )}
                  <g key={entryCue ? entryCue.id : s.id} className={entryCue ? 'geofence-svg-pin-3d' : undefined}>
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={entryCue ? 13 : 11}
                      fill={fill}
                      stroke={entryCue ? '#38BDF8' : '#0B0F17'}
                      strokeWidth={entryCue ? '2.5' : '2'}
                    />
                    <text x={pt.x} y={pt.y + 4} textAnchor="middle" fill="#0B0F17" fontSize="10" fontWeight="700">
                      {s.orderIndex + 1}
                    </text>
                  </g>
                  {entryCue && (
                    <g>
                      <rect x={pt.x - 28} y={pt.y - 34} width={56} height={15} rx={7.5} fill="#34D399" />
                      <text
                        x={pt.x}
                        y={pt.y - 23.5}
                        textAnchor="middle"
                        fill="#0B0F17"
                        fontSize="8.5"
                        fontWeight="800"
                      >
                        ARRIVED
                      </text>
                    </g>
                  )}
                  <text x={pt.x + 15} y={pt.y + 4} fill="#E2E8F0" fontSize="12" fontWeight="500">
                    {s.name.slice(0, 22)}
                  </text>
                </g>
              );
            })}

            {/* Enterprise Pins (Cached Jira / Salesforce) */}
            {activeEnterprisePins.map((pin) => {
              const pt = projectPoint({ lat: pin.lat, lng: pin.lng });
              const isJira = pin.source === 'jira';
              return (
                <g
                  key={pin.id}
                  className="cursor-pointer"
                  onClick={() => {
                    triggerHaptic('light');
                    onStartRouteTo({ lat: pin.lat, lng: pin.lng }, pin.title);
                  }}
                >
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={10}
                    fill={isJira ? '#4F46E5' : '#0284C7'}
                    stroke="#0B0F17"
                    strokeWidth="2"
                  />
                  <text x={pt.x} y={pt.y + 3.5} textAnchor="middle" fill="#FFFFFF" fontSize="10" fontWeight="700">
                    {isJira ? 'J' : 'S'}
                  </text>
                  <text x={pt.x + 14} y={pt.y + 4} fill="#CBD5E1" fontSize="11" fontWeight="500">
                    {pin.title.slice(0, 22)}
                  </text>
                </g>
              );
            })}

            {/* Live or Simulated Explorer Beacon */}
            {userLocation && (
              <g>
                <circle
                  cx={projectPoint(userLocation).x}
                  cy={projectPoint(userLocation).y}
                  r={14}
                  fill="rgba(56, 189, 248, 0.25)"
                />
                <circle
                  cx={projectPoint(userLocation).x}
                  cy={projectPoint(userLocation).y}
                  r={6}
                  fill="#38BDF8"
                  stroke="#FFFFFF"
                  strokeWidth="2"
                />
              </g>
            )}
          </svg>
        </div>
      )}

      {/* Top Left Search & Category Controls */}
      <div className="absolute top-3 left-3 right-3 sm:right-auto z-20 pointer-events-none flex flex-col gap-2">
        <PlaceAutocompleteBar
          onPlaceSelected={(place) => {
            onPlaceSelected(place);
            if (map) {
              map.panTo({ lat: place.lat, lng: place.lng });
              map.setZoom(15);
            }
          }}
          onQuickCategorySearch={onQuickCategorySearch}
          isOffline={isOffline}
        />

        {/* Toggleable Enterprise Map Pin Layer Controls */}
        {(enterpriseStatus.jira || enterpriseStatus.salesforce) && (
          <div className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {enterpriseStatus.jira && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onToggleJiraLayer();
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors min-h-[36px] whitespace-nowrap shrink-0 tabular-nums ${
                  showJiraLayer
                    ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
                    : 'bg-white/90 dark:bg-[#121824]/90 backdrop-blur-md text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:border-indigo-500/50'
                }`}
              >
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {enterpriseLoading.jira
                    ? 'Loading Jira...'
                    : `Jira Issues${showJiraLayer ? ` (${jiraPins.length})` : ''}`}
                </span>
              </button>
            )}

            {enterpriseStatus.salesforce && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onToggleSalesforceLayer();
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors min-h-[36px] whitespace-nowrap shrink-0 tabular-nums ${
                  showSalesforceLayer
                    ? 'bg-sky-600 text-white border-sky-500 shadow-sm'
                    : 'bg-white/90 dark:bg-[#121824]/90 backdrop-blur-md text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:border-sky-500/50'
                }`}
              >
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {enterpriseLoading.salesforce
                    ? 'Loading Salesforce...'
                    : `Salesforce Accounts${showSalesforceLayer ? ` (${salesforcePins.length})` : ''}`}
                </span>
              </button>
            )}

            {(showJiraLayer || showSalesforceLayer) && !isOffline && onSyncAreaEnterprise && (
              <button
                type="button"
                disabled={enterpriseLoading.jira || enterpriseLoading.salesforce}
                onClick={() => {
                  triggerHaptic('light');
                  void onSyncAreaEnterprise();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border bg-white/90 dark:bg-[#121824]/90 backdrop-blur-md text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:border-emerald-500/50 disabled:opacity-50 min-h-[36px] whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 shrink-0 ${
                    enterpriseLoading.jira || enterpriseLoading.salesforce ? 'animate-spin' : ''
                  }`}
                />
                <span>Sync Area</span>
              </button>
            )}

            {activeEnterprisePins.length > 0 && !isOffline && onBuildFieldDayFromMap && (
              <button
                type="button"
                disabled={buildingFieldDay}
                onClick={() => {
                  triggerHaptic('medium');
                  void onBuildFieldDayFromMap();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 shadow-sm min-h-[36px] whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>{buildingFieldDay ? 'Dispatching...' : 'Build Field Day'}</span>
              </button>
            )}
          </div>
        )}

        {simulateClickMode && (
          <div className="pointer-events-auto inline-flex items-center gap-2 self-start rounded-lg border border-sky-500/40 bg-sky-950/90 text-sky-200 px-3 py-1.5 text-xs font-medium shadow-md">
            <Compass className="w-3.5 h-3.5 text-sky-400" />
            <span>Tap anywhere on the map to simulate your GPS position for geofence testing</span>
          </div>
        )}
      </div>

      {/* Map Floating Recenter Control */}
      <div className="absolute right-3 bottom-24 lg:bottom-6 z-20 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            const target = userLocation || center;
            if (map) {
              map.panTo(target);
              map.setZoom(14);
            }
          }}
          title="Center map on location"
          aria-label="Center map on location"
          className="w-11 h-11 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 backdrop-blur-md text-slate-700 dark:text-slate-200 shadow-lg flex items-center justify-center hover:border-emerald-500/60 transition-colors"
        >
          <LocateFixed className="w-5 h-5" />
        </button>
      </div>

      {/* Active Route & Turn-by-Turn Overlay Card */}
      {(activeRoute || routeLoading || routeError) && (
        <div className="absolute left-3 right-3 sm:right-auto sm:w-96 bottom-20 lg:bottom-6 z-20 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 backdrop-blur-md p-3.5 shadow-xl space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <RouteIcon className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                <span className="truncate">
                  {activeRouteRequest?.travelMode || activeRoute?.travelMode}
                  {activeRoute?.isOfflineEstimate ? ' · Offline Vector Route' : ' · Cached Offline'}
                </span>
              </div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate mt-0.5">
                {activeRouteRequest?.destinationName || activeRoute?.destinationName}
              </h4>
            </div>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onClearRoute();
              }}
              className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 min-h-[36px]"
            >
              Clear
            </button>
          </div>

          {routeLoading && <p className="text-xs text-slate-500">Calculating route via Routes API...</p>}
          {routeError && <p className="text-xs text-rose-500">{routeError}</p>}

          {activeRoute && (
            <>
              <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200">
                <span>{formatDistance(activeRoute.distanceMeters)}</span>
                <span className="text-slate-400">·</span>
                <span>{formatDuration(activeRoute.durationMillis)}</span>
                <span className="text-slate-400">·</span>
                <span>{activeRoute.steps.length} steps</span>
              </div>

              <div className="max-h-28 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80 pr-1">
                {activeRoute.steps.slice(0, 6).map((st, idx) => (
                  <div key={idx} className="py-1.5 flex items-start justify-between gap-2 text-xs">
                    <span className="text-slate-700 dark:text-slate-300 leading-snug">
                      {idx + 1}. {st.instruction.replace(/<[^>]+>/g, '')}
                    </span>
                    <span className="text-slate-400 font-mono tabular-nums shrink-0">
                      {formatDistance(st.distanceMeters)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
