import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ChevronDown,
  Compass,
  Lock,
  LogIn,
  LogOut,
  MessageSquare,
  Moon,
  Radio,
  Share2,
  Sliders,
  Sun,
  X,
} from 'lucide-react';
import { AlertsPanel } from './components/AlertsPanel';
import { ChatPanel } from './components/ChatPanel';
import { DemoVectorMap } from './components/DemoVectorMap';
import { FieldOpsDrawer } from './components/FieldOpsDrawer';
import { GeofencePanel } from './components/GeofencePanel';
import { ItineraryDashboard, ItineraryLayoutMode } from './components/ItineraryDashboard';
import { MapViewport } from './components/MapViewport';
import { OfflineIndicator, useOnlineStatus } from './components/OfflineIndicator';
import { PreferencesModal } from './components/PreferencesModal';
import { PrivacyLocationControl } from './components/PrivacyLocationControl';
import { PWAInstallButton } from './components/PWAInstallButton';
import { ShareEncryptModal } from './components/ShareEncryptModal';
import { useLocationTelemetry } from './hooks/useLocationTelemetry';
import { useWaypostStore } from './hooks/useWaypostStore';
import {
  AgentProposal,
  AlertSeverity,
  CachedRoute,
  DayOptimizationResult,
  DiscoveredPlace,
  DisruptionRecoveryPlan,
  EnterpriseConnectorId,
  EnterpriseConnectorStatus,
  EnterpriseLogResult,
  EnterpriseMapPin,
  EnterprisePreferences,
  EnterpriseRecordLink,
  FieldDispatchResult,
  GeofenceEntryCue,
  GroundingMode,
  LatLng,
  OfflineRouteStep,
  SyncOutboxItem,
  TravelMode,
  TripAlert,
  TripGeofence,
} from './types/travel';
import { authFetch } from './utils/authFetch';
import { GeofenceTransition, haversineDistanceMeters } from './utils/geofence';
import { triggerHaptic } from './utils/haptics';
import {
  buildRouteCacheKey,
  computeOfflineFallbackRoute,
  loadEnterprisePinsCache,
  saveEnterprisePinsCache,
} from './utils/offlineStorage';
import { enqueueEnterpriseLog, flushSyncOutbox } from './utils/offlineSync';

type WorkspaceTab = 'explore' | 'itinerary' | 'geofences' | 'alerts';

const ENTERPRISE_PREFS_KEY = 'waypost_enterprise_prefs_v1';

const DEFAULT_ENTERPRISE_PREFS: EnterprisePreferences = {
  showJiraLayer: false,
  showSalesforceLayer: false,
  autoLogGeofenceCheckins: false,
  autoLogHighSeverityAlerts: false,
  logTargets: ['jira', 'salesforce', 'servicenow'],
  jiraProjectKey: '',
};

function loadEnterprisePrefs(): EnterprisePreferences {
  try {
    const raw = localStorage.getItem(ENTERPRISE_PREFS_KEY);
    if (!raw) return DEFAULT_ENTERPRISE_PREFS;
    return { ...DEFAULT_ENTERPRISE_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_ENTERPRISE_PREFS;
  }
}

function extractServiceNowSysId(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/sys_id=([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

function buildLinksFromResults(
  results: EnterpriseLogResult[],
  eventType: 'geofence_checkin' | 'travel_alert',
  geofenceEvent?: 'enter' | 'exit',
  dwellDurationSeconds?: number
): EnterpriseRecordLink[] {
  return results
    .filter((r) => r.ok && r.recordId)
    .map((r) => ({
      target: r.target,
      recordId: r.recordId!,
      recordUrl: r.recordUrl,
      eventType,
      loggedAt: Date.now(),
      status: geofenceEvent === 'exit' ? 'closed' : 'open',
      dwellDurationSeconds,
    }));
}

const GOOGLE_MAPS_LIBRARIES = ['places', 'routes', 'marker'];

/**
 * Bridge component inside <APIProvider> so we can invoke Routes API (Route.computeRoutes)
 * imperatively when the user clicks "Cache Offline" in the Itinerary Dashboard.
 */
const RoutesLibraryBridge: React.FC<{
  onReady: (routesLib: any | null) => void;
}> = ({ onReady }) => {
  const routesLib = useMapsLibrary('routes');
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current(routesLib || null);
  }, [routesLib]);
  return null;
};

export default function App() {
  const store = useWaypostStore();
  const browserOnline = useOnlineStatus();
  const isOffline = !browserOnline || store.prefs.offlineModePreferred;

  const [mapsApiKey, setMapsApiKey] = useState<string>(
    () => (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string) || ''
  );
  const [mapsKeyLoaded, setMapsKeyLoaded] = useState<boolean>(
    () => Boolean(import.meta.env.VITE_GOOGLE_MAPS_API_KEY)
  );
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('explore');
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showPrefsModal, setShowPrefsModal] = useState(false);
  const [showFieldOps, setShowFieldOps] = useState(false);
  const [fieldOpsTab, setFieldOpsTab] = useState<'audit' | 'outbox' | 'activity'>('audit');
  const [requestedItineraryLayout, setRequestedItineraryLayout] =
    useState<ItineraryLayoutMode | null>(null);
  const [activeRecoveryPlan, setActiveRecoveryPlan] = useState<DisruptionRecoveryPlan | null>(null);
  const [buildingFieldDay, setBuildingFieldDay] = useState(false);
  const [triggeredGeofenceCues, setTriggeredGeofenceCues] = useState<GeofenceEntryCue[]>([]);
  const geofenceCueTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      Object.values(geofenceCueTimersRef.current).forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      geofenceCueTimersRef.current = {};
    };
  }, []);

  const [mapCenter, setMapCenter] = useState<LatLng>({ lat: 37.7749, lng: -122.4194 });
  const [discoveredPlaces, setDiscoveredPlaces] = useState<DiscoveredPlace[]>([]);
  const [activeRouteRequest, setActiveRouteRequest] = useState<{
    origin: LatLng;
    destination: LatLng;
    originName: string;
    destinationName: string;
    travelMode: TravelMode;
  } | null>(null);

  const [enterpriseStatus, setEnterpriseStatus] = useState<EnterpriseConnectorStatus>({
    jira: false,
    salesforce: false,
    servicenow: false,
    authRequired: false,
  });
  const [enterprisePrefs, setEnterprisePrefs] = useState<EnterprisePreferences>(loadEnterprisePrefs);
  const [jiraPins, setJiraPins] = useState<EnterpriseMapPin[]>([]);
  const [salesforcePins, setSalesforcePins] = useState<EnterpriseMapPin[]>([]);
  const [enterpriseLoading, setEnterpriseLoading] = useState({ jira: false, salesforce: false });
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);
  const [enterpriseNotice, setEnterpriseNotice] = useState<string | null>(null);

  const routesLibRef = useRef<any | null>(null);
  const initialNearbyFetchedRef = useRef(false);
  const mapBoundsRef = useRef<{ north: number; south: number; east: number; west: number } | null>(null);
  const activeVisitRecordsRef = useRef<
    Record<
      string,
      {
        jiraIssueKey?: string;
        salesforceRecordId?: string;
        salesforceObjectName?: string;
        servicenowSysId?: string;
      }
    >
  >({});
  const enterpriseStatusRef = useRef(enterpriseStatus);
  enterpriseStatusRef.current = enterpriseStatus;
  const enterprisePrefsRef = useRef(enterprisePrefs);
  enterprisePrefsRef.current = enterprisePrefs;

  // Hydrate offline cached enterprise map pins on startup
  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadEnterprisePinsCache('jira'), loadEnterprisePinsCache('salesforce')]).then(
      ([cachedJira, cachedSf]) => {
        if (cancelled) return;
        if (cachedJira?.pins?.length) setJiraPins(cachedJira.pins);
        if (cachedSf?.pins?.length) setSalesforcePins(cachedSf.pins);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync map center when active trip changes
  useEffect(() => {
    if (store.activeTrip?.center) {
      setMapCenter(store.activeTrip.center);
    }
  }, [store.activeTrip?.id]);

  // Resolve Maps API key from server config if not baked into Vite env
  useEffect(() => {
    if (mapsApiKey) {
      setMapsKeyLoaded(true);
      return;
    }
    let cancelled = false;
    fetch('/api/maps-config')
      .then((res) => (res.ok ? res.json() : { apiKey: '' }))
      .then((data) => {
        if (!cancelled) {
          if (data?.apiKey) setMapsApiKey(String(data.apiKey));
          setMapsKeyLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setMapsKeyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapsApiKey]);

  // Listen for Demo Key Quota Exceeded events (Case A defense)
  useEffect(() => {
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  // Fetch initial real Google Maps POIs near map center once online & key is ready
  useEffect(() => {
    if (!mapsKeyLoaded || !mapsApiKey || isOffline || initialNearbyFetchedRef.current) return;
    if (!store.activeTrip) return;
    initialNearbyFetchedRef.current = true;

    fetch('/api/places/nearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: store.activeTrip.center.lat,
        lng: store.activeTrip.center.lng,
        radiusMeters: 2500,
        includedTypes: ['cafe', 'tourist_attraction', 'park'],
      }),
    })
      .then(async (res) => {
        if (res.status === 429) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data) => {
        if (data?.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        if (Array.isArray(data?.places) && data.places.length > 0) {
          setDiscoveredPlaces(data.places);
        }
      })
      .catch(() => {
        // Non-fatal; user can still search or chat
      });
  }, [mapsKeyLoaded, mapsApiKey, isOffline, store.activeTrip]);

  const updateEnterprisePrefs = useCallback((patch: Partial<EnterprisePreferences>) => {
    setEnterprisePrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(ENTERPRISE_PREFS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage error
      }
      return next;
    });
  }, []);

  const refreshEnterpriseStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.enterpriseConnectors) {
        setEnterpriseStatus({
          jira: Boolean(data.enterpriseConnectors.jira),
          salesforce: Boolean(data.enterpriseConnectors.salesforce),
          servicenow: Boolean(data.enterpriseConnectors.servicenow),
          authRequired: Boolean(data.enterpriseConnectors.authRequired),
        });
      }
    } catch {
      // Offline or server unavailable
    }
  }, []);

  useEffect(() => {
    void refreshEnterpriseStatus();
  }, [refreshEnterpriseStatus]);

  const syncEnterpriseLayer = useCallback(
    async (source: 'jira' | 'salesforce', useViewportBounds = false) => {
      if (isOffline) return;
      setEnterpriseLoading((prev) => ({ ...prev, [source]: true }));
      setEnterpriseError(null);
      try {
        const bounds = useViewportBounds ? mapBoundsRef.current : null;
        const boundsQuery = bounds
          ? `&north=${encodeURIComponent(bounds.north)}&south=${encodeURIComponent(
              bounds.south
            )}&east=${encodeURIComponent(bounds.east)}&west=${encodeURIComponent(bounds.west)}`
          : '';
        const endpoint =
          source === 'jira'
            ? `/api/enterprise/jira/issues?lat=${encodeURIComponent(mapCenter.lat)}&lng=${encodeURIComponent(mapCenter.lng)}${boundsQuery}`
            : `/api/enterprise/salesforce/accounts?lat=${encodeURIComponent(mapCenter.lat)}&lng=${encodeURIComponent(mapCenter.lng)}${boundsQuery}`;
        const res = await authFetch(endpoint);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401 && data?.authRequired) {
            setEnterpriseError('Sign in with Google to access Enterprise Connectors.');
          } else {
            setEnterpriseError(data?.error || `Unable to load ${source} map layer.`);
          }
          return;
        }
        if (source === 'jira') {
          const issues: EnterpriseMapPin[] = Array.isArray(data.issues) ? data.issues : [];
          setJiraPins(issues);
          void saveEnterprisePinsCache('jira', issues);
        } else {
          const accounts: EnterpriseMapPin[] = Array.isArray(data.accounts) ? data.accounts : [];
          setSalesforcePins(accounts);
          void saveEnterprisePinsCache('salesforce', accounts);
        }
      } catch (err) {
        setEnterpriseError(err instanceof Error ? err.message : `Failed to sync ${source} pins.`);
      } finally {
        setEnterpriseLoading((prev) => ({ ...prev, [source]: false }));
      }
    },
    [isOffline, mapCenter.lat, mapCenter.lng]
  );

  const handleSyncAreaEnterprise = useCallback(async () => {
    const tasks: Promise<void>[] = [];
    if (enterprisePrefsRef.current.showJiraLayer && enterpriseStatusRef.current.jira) {
      tasks.push(syncEnterpriseLayer('jira', true));
    }
    if (enterprisePrefsRef.current.showSalesforceLayer && enterpriseStatusRef.current.salesforce) {
      tasks.push(syncEnterpriseLayer('salesforce', true));
    }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
    setEnterpriseNotice('Synced enterprise pins for current map viewport.');
  }, [syncEnterpriseLayer]);

  const canCallEnterpriseApi = !enterpriseStatus.authRequired || Boolean(store.user);

  useEffect(() => {
    if (
      enterprisePrefs.showJiraLayer &&
      enterpriseStatus.jira &&
      canCallEnterpriseApi &&
      !isOffline &&
      jiraPins.length === 0
    ) {
      void syncEnterpriseLayer('jira');
    }
  }, [
    enterprisePrefs.showJiraLayer,
    enterpriseStatus.jira,
    canCallEnterpriseApi,
    isOffline,
    jiraPins.length,
    syncEnterpriseLayer,
  ]);

  useEffect(() => {
    if (
      enterprisePrefs.showSalesforceLayer &&
      enterpriseStatus.salesforce &&
      canCallEnterpriseApi &&
      !isOffline &&
      salesforcePins.length === 0
    ) {
      void syncEnterpriseLayer('salesforce');
    }
  }, [
    enterprisePrefs.showSalesforceLayer,
    enterpriseStatus.salesforce,
    canCallEnterpriseApi,
    isOffline,
    salesforcePins.length,
    syncEnterpriseLayer,
  ]);

  const handleEnterpriseLogSynced = useCallback(
    async (item: SyncOutboxItem, results: EnterpriseLogResult[]) => {
      const p = item.payload as Record<string, any>;
      const linkEntity = p._linkEntity as { type: 'stop' | 'geofence' | 'alert'; id: string } | undefined;
      const eventType =
        p.eventType === 'travel_alert' ? ('travel_alert' as const) : ('geofence_checkin' as const);
      const geofenceEvent =
        p.geofenceEvent === 'enter' || p.geofenceEvent === 'exit' ? p.geofenceEvent : undefined;
      const dwellDurationSeconds =
        typeof p.dwellDurationSeconds === 'number' ? p.dwellDurationSeconds : undefined;

      const links = buildLinksFromResults(results, eventType, geofenceEvent, dwellDurationSeconds);
      if (linkEntity && links.length > 0) {
        await store.attachEnterpriseLinks(linkEntity.type, linkEntity.id, links);
      }

      if (linkEntity?.type === 'geofence' && geofenceEvent === 'enter') {
        const record: {
          jiraIssueKey?: string;
          salesforceRecordId?: string;
          salesforceObjectName?: string;
          servicenowSysId?: string;
        } = {};
        for (const r of results) {
          if (!r.ok || !r.recordId) continue;
          if (r.target === 'jira') record.jiraIssueKey = r.recordId;
          if (r.target === 'salesforce') {
            record.salesforceRecordId = r.recordId;
            record.salesforceObjectName = 'Task';
          }
          if (r.target === 'servicenow') {
            record.servicenowSysId = extractServiceNowSysId(r.recordUrl) || r.recordId;
          }
        }
        if (Object.keys(record).length > 0) {
          activeVisitRecordsRef.current[linkEntity.id] = record;
        }
      }
    },
    [store.attachEnterpriseLinks]
  );

  const handleSyncNow = useCallback(
    async (force = false) => {
      if (!browserOnline) return;
      const outcome = await flushSyncOutbox(
        {
          onEnterpriseLogSynced: handleEnterpriseLogSynced,
          onReplayFirestoreMutation: store.replayFirestoreMutation,
        },
        { force }
      );
      if (outcome.succeeded > 0) {
        store.setSyncNotice(
          `Smart Sync completed: ${outcome.succeeded} queued ${
            outcome.succeeded === 1 ? 'change' : 'changes'
          } synced.`
        );
        triggerHaptic('success');
      }
    },
    [browserOnline, handleEnterpriseLogSynced, store.replayFirestoreMutation, store.setSyncNotice]
  );

  const handleSyncNowRef = useRef(handleSyncNow);
  handleSyncNowRef.current = handleSyncNow;

  // Auto-flush Smart Offline Sync on reconnect, sign-in, tab focus, or backoff retry
  useEffect(() => {
    if (!browserOnline) return;
    void handleSyncNowRef.current(false);
  }, [browserOnline, store.user?.uid]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void handleSyncNowRef.current(false);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!browserOnline || store.smartSync.pendingCount === 0) return;
    const timer = window.setInterval(() => {
      void handleSyncNowRef.current(false);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [browserOnline, store.smartSync.pendingCount]);

  const handleRoutesLibReady = useCallback((lib: any | null) => {
    routesLibRef.current = lib;
  }, []);

  const handleClearRoute = useCallback(() => {
    setActiveRouteRequest(null);
  }, []);

  const handleBoundsChanged = useCallback(
    (bounds: { north: number; south: number; east: number; west: number }) => {
      mapBoundsRef.current = bounds;
    },
    []
  );

  const postEnterpriseLog = useCallback(
    async (payload: {
      targets?: EnterpriseConnectorId[];
      eventType: 'geofence_checkin' | 'travel_alert';
      title: string;
      description: string;
      severity?: string;
      geofenceEvent?: 'enter' | 'exit';
      dwellDurationSeconds?: number;
      idempotencyKey?: string;
      location?: { lat: number; lng: number; label?: string };
      jiraIssueKey?: string;
      salesforceAccountId?: string;
      salesforceRecordId?: string;
      salesforceObjectName?: string;
      servicenowSysId?: string;
      linkEntity?: { type: 'stop' | 'geofence' | 'alert'; id: string };
    }): Promise<EnterpriseLogResult[]> => {
      const status = enterpriseStatusRef.current;
      const ePrefs = enterprisePrefsRef.current;
      const requested = payload.targets || ePrefs.logTargets;
      const activeTargets = requested.filter((t) => status[t]);
      if (activeTargets.length === 0) {
        return [];
      }

      const idempotencyKey =
        payload.idempotencyKey ||
        `ent:${payload.eventType}:${payload.linkEntity?.id || 'manual'}:${Date.now()}`;
      const { linkEntity, ...restPayload } = payload;

      const requestBody = {
        ...restPayload,
        targets: activeTargets,
        idempotencyKey,
        tripTitle: store.activeTrip?.title,
        destination: store.activeTrip?.destination,
        jiraProjectKey: ePrefs.jiraProjectKey || undefined,
      };

      if (isOffline) {
        await enqueueEnterpriseLog({
          idempotencyKey,
          tripId: store.activeTrip?.id,
          label: payload.title,
          payload: {
            ...requestBody,
            ...(linkEntity ? { _linkEntity: linkEntity } : {}),
          },
        });
        setEnterpriseNotice('Queued offline for Smart Sync');
        return [];
      }

      try {
        const res = await authFetch('/api/enterprise/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && data?.authRequired) {
          setEnterpriseNotice('Sign in with Google to use Enterprise Connectors.');
          return [];
        }
        const results: EnterpriseLogResult[] = Array.isArray(data?.results) ? data.results : [];
        const succeeded = results.filter((r) => r.ok);
        if (succeeded.length > 0) {
          const summary = succeeded
            .map((r) => `${r.target} (${r.recordId || 'OK'}${r.updatedExisting ? ' updated' : ''})`)
            .join(', ');
          setEnterpriseNotice(`Logged to ${summary}`);
          triggerHaptic('success');

          if (linkEntity) {
            const links = buildLinksFromResults(
              succeeded,
              payload.eventType,
              payload.geofenceEvent,
              payload.dwellDurationSeconds
            );
            if (links.length > 0) {
              await store.attachEnterpriseLinks(linkEntity.type, linkEntity.id, links);
            }
          }
        } else if (results.length > 0) {
          setEnterpriseNotice(results[0].error || 'Enterprise logging failed.');
        } else if (!res.ok) {
          setEnterpriseNotice(data?.error || 'Enterprise logging failed.');
        }
        return results;
      } catch {
        await enqueueEnterpriseLog({
          idempotencyKey,
          tripId: store.activeTrip?.id,
          label: payload.title,
          payload: {
            ...requestBody,
            ...(linkEntity ? { _linkEntity: linkEntity } : {}),
          },
        });
        setEnterpriseNotice('Network unavailable · Queued for Smart Sync');
        return [];
      }
    },
    [isOffline, store]
  );

  // Closed-loop geofence transition handler (accuracy-gated + hysteresis + dwell tracking)
  const handleGeofenceTransitions = useCallback(
    (transitions: GeofenceTransition[], pos: LatLng) => {
      for (const t of transitions) {
        triggerHaptic('geofence');
        if (t.event === 'enter') {
          const cueId = `cue_${t.geofence.id}_${Date.now()}`;
          const newCue: GeofenceEntryCue = {
            id: cueId,
            geofenceId: t.geofence.id,
            linkedStopId: t.geofence.linkedStopId,
            label: t.geofence.label,
            lat: t.geofence.lat,
            lng: t.geofence.lng,
            radiusMeters: t.geofence.radiusMeters,
            triggeredAt: Date.now(),
          };
          setTriggeredGeofenceCues((prev) => [
            ...prev.filter((c) => c.geofenceId !== t.geofence.id),
            newCue,
          ]);
          const existingTimer = geofenceCueTimersRef.current[t.geofence.id];
          if (existingTimer) {
            window.clearTimeout(existingTimer);
          }
          geofenceCueTimersRef.current[t.geofence.id] = window.setTimeout(() => {
            setTriggeredGeofenceCues((prev) => prev.filter((c) => c.id !== cueId));
            delete geofenceCueTimersRef.current[t.geofence.id];
          }, 6500);
        }

        const dwellLabel =
          t.event === 'exit' && typeof t.dwellDurationSeconds === 'number' && t.dwellDurationSeconds > 0
            ? ` · Dwell ${Math.max(1, Math.round(t.dwellDurationSeconds / 60))}m`
            : '';
        const eventTitle =
          t.event === 'enter' ? `Entered ${t.geofence.label}` : `Exited ${t.geofence.label}`;
        const eventBody = `${t.geofence.alertMessage} (${Math.round(t.distanceMeters)}m from center${dwellLabel})`;

        void store.emitAlert({
          severity: 'normal',
          category: 'geofence',
          scheduleDeltaMinutes: 0,
          title: eventTitle,
          body: eventBody,
        });

        // Silently persist signed-in user's geofence telemetry to Cloud SQL when online
        if (store.user && !isOffline && store.activeTrip) {
          void authFetch('/api/sql/geofence-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tripId: store.activeTrip.id,
              geofenceId: t.geofence.id,
              geofenceLabel: t.geofence.label,
              stopId: t.geofence.linkedStopId ?? null,
              eventType: t.event,
              lat: pos.lat,
              lng: pos.lng,
              distanceMeters: t.distanceMeters,
              dwellDurationSeconds: t.dwellDurationSeconds ?? null,
            }),
          }).catch(() => {
            // Non-blocking background persistence
          });
        }

        if (enterprisePrefsRef.current.autoLogGeofenceCheckins) {
          if (t.event === 'enter') {
            void postEnterpriseLog({
              eventType: 'geofence_checkin',
              geofenceEvent: 'enter',
              idempotencyKey: t.idempotencyKey,
              title: eventTitle,
              description: eventBody,
              location: { lat: pos.lat, lng: pos.lng, label: t.geofence.label },
              linkEntity: { type: 'geofence', id: t.geofence.id },
            }).then((results) => {
              const visitRec: {
                jiraIssueKey?: string;
                salesforceRecordId?: string;
                salesforceObjectName?: string;
                servicenowSysId?: string;
              } = {};
              for (const r of results) {
                if (!r.ok || !r.recordId) continue;
                if (r.target === 'jira') visitRec.jiraIssueKey = r.recordId;
                if (r.target === 'salesforce') {
                  visitRec.salesforceRecordId = r.recordId;
                  visitRec.salesforceObjectName = 'Task';
                }
                if (r.target === 'servicenow') {
                  visitRec.servicenowSysId = extractServiceNowSysId(r.recordUrl) || r.recordId;
                }
              }
              if (Object.keys(visitRec).length > 0) {
                activeVisitRecordsRef.current[t.geofence.id] = visitRec;
              }
            });
          } else {
            // Closed-loop exit: update the open visit record created on enter
            const activeRec = activeVisitRecordsRef.current[t.geofence.id];
            const openJira =
              activeRec?.jiraIssueKey ||
              t.geofence.enterpriseLinks?.find((l) => l.target === 'jira' && l.status !== 'closed')
                ?.recordId;
            const openSf =
              activeRec?.salesforceRecordId ||
              t.geofence.enterpriseLinks?.find(
                (l) => l.target === 'salesforce' && l.status !== 'closed'
              )?.recordId;
            const openSnowLink = t.geofence.enterpriseLinks?.find(
              (l) => l.target === 'servicenow' && l.status !== 'closed'
            );
            const openSnowSysId =
              activeRec?.servicenowSysId || extractServiceNowSysId(openSnowLink?.recordUrl);

            delete activeVisitRecordsRef.current[t.geofence.id];

            void postEnterpriseLog({
              eventType: 'geofence_checkin',
              geofenceEvent: 'exit',
              dwellDurationSeconds: t.dwellDurationSeconds,
              idempotencyKey: t.idempotencyKey,
              title: eventTitle,
              description: eventBody,
              location: { lat: pos.lat, lng: pos.lng, label: t.geofence.label },
              jiraIssueKey: openJira,
              salesforceRecordId: openSf,
              salesforceObjectName: openSf ? activeRec?.salesforceObjectName || 'Task' : undefined,
              servicenowSysId: openSnowSysId,
              linkEntity: { type: 'geofence', id: t.geofence.id },
            });
          }
        }

        // Hands-Free Closed-Loop Auto-Pilot: exiting a stop-linked geofence marks the stop completed
        if (t.event === 'exit') {
          const matchedStop =
            (t.geofence.linkedStopId
              ? store.stops.find((s) => s.id === t.geofence.linkedStopId)
              : undefined) ||
            store.stops.find(
              (s) =>
                s.status !== 'completed' &&
                haversineDistanceMeters(
                  { lat: s.lat, lng: s.lng },
                  { lat: t.geofence.lat, lng: t.geofence.lng }
                ) < 150
            );
          if (matchedStop && matchedStop.status !== 'completed') {
            void store.updateStop(matchedStop.id, { status: 'completed' }, true);
            store.setSyncNotice(`Auto-completed ${matchedStop.name} on geofence exit.`);
          }
        }
      }
    },
    [store, postEnterpriseLog, isOffline]
  );

  const handleGpsError = useCallback(
    (message: string) => {
      void store.emitAlert({
        severity: 'normal',
        category: 'geofence',
        scheduleDeltaMinutes: 0,
        title: 'GPS Permission Needed',
        body: message,
      });
    },
    [store]
  );

  const telemetry = useLocationTelemetry({
    geofences: store.geofences,
    onTransitions: handleGeofenceTransitions,
    onGpsError: handleGpsError,
  });

  const { userLocation, gpsAccuracyMeters, gpsTrackingEnabled, setGpsTrackingEnabled, simulateClickMode, setSimulateClickMode, processLocationUpdate, resetGeofenceState } = telemetry;

  useEffect(() => {
    resetGeofenceState();
    activeVisitRecordsRef.current = {};
    setTriggeredGeofenceCues([]);
  }, [store.activeTrip?.id, resetGeofenceState]);

  const handleQuickCategorySearch = useCallback(
    async (categoryQuery: string, includedTypes: string[]) => {
      if (isOffline) return;
      try {
        const res = await fetch('/api/places/nearby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: mapCenter.lat,
            lng: mapCenter.lng,
            radiusMeters: 3000,
            includedTypes,
          }),
        });
        if (res.status === 429) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          return;
        }
        const data = await res.json();
        if (Array.isArray(data?.places) && data.places.length > 0) {
          setDiscoveredPlaces(data.places);
          triggerHaptic('success');
          return;
        }

        // Fallback to text search if nearby returns empty for sparse areas
        const fallbackRes = await fetch('/api/places/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: categoryQuery,
            lat: mapCenter.lat,
            lng: mapCenter.lng,
            radiusMeters: 5000,
          }),
        });
        if (fallbackRes.ok) {
          const fb = await fallbackRes.json();
          if (Array.isArray(fb?.places)) {
            setDiscoveredPlaces(fb.places);
          }
        }
      } catch {
        // Non-fatal
      }
    },
    [isOffline, mapCenter]
  );

  const handlePlaceSelected = useCallback((place: DiscoveredPlace) => {
    setMapCenter({ lat: place.lat, lng: place.lng });
    setDiscoveredPlaces((prev) => {
      const exists = prev.some((p) => p.placeId && p.placeId === place.placeId);
      return exists ? prev : [place, ...prev];
    });
  }, []);

  const handleAddPlaceToItinerary = useCallback(
    (place: DiscoveredPlace) => {
      void store.addStop({
        name: place.name,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        placeId: place.placeId,
        category: place.primaryType || 'Point of Interest',
        priority: 'normal',
        rating: place.rating,
        googleMapsUri: place.googleMapsUri,
      });
    },
    [store]
  );

  const handleStartRouteTo = useCallback(
    (dest: LatLng, name: string) => {
      const origin = userLocation || mapCenter;
      const originName = userLocation ? 'Current Location' : 'Map Center';
      setActiveRouteRequest({
        origin,
        destination: dest,
        originName,
        destinationName: name,
        travelMode: store.prefs.travelMode,
      });
    },
    [userLocation, mapCenter, store.prefs.travelMode]
  );

  const handleRouteLeg = useCallback(
    (origin: LatLng, destination: LatLng, originName: string, destinationName: string) => {
      setActiveRouteRequest({
        origin,
        destination,
        originName,
        destinationName,
        travelMode: store.prefs.travelMode,
      });
      if (window.innerWidth < 1024) {
        setMobileSheetOpen(false);
      }
    },
    [store.prefs.travelMode]
  );

  const handleCreateGeofenceAt = useCallback(
    (lat: number, lng: number, label: string) => {
      void store.addGeofence({
        lat,
        lng,
        radiusMeters: 350,
        triggerOn: 'both',
        label,
        alertMessage: `Proximity alert: ${label}`,
      });
      setActiveTab('geofences');
      if (window.innerWidth < 1024) {
        setMobileSheetOpen(true);
      }
    },
    [store]
  );

  const handleSendChatMessage = useCallback(
    async (text: string, groundingMode: GroundingMode) => {
      const senderName = store.user?.displayName || 'Explorer';
      const senderUid = store.user?.uid || 'local_explorer';

      await store.appendChatMessage({
        senderUid,
        senderName,
        role: 'user',
        text,
      });

      const historyPayload = [
        ...store.messages.map((m) => ({ role: m.role, text: m.text })),
        { role: 'user', text },
      ];

      const visibleEnterprisePins = [
        ...(enterprisePrefsRef.current.showJiraLayer ? jiraPins : []),
        ...(enterprisePrefsRef.current.showSalesforceLayer ? salesforcePins : []),
      ]
        .slice(0, 10)
        .map((p) => ({
          source: p.source,
          key: p.externalKey,
          title: p.title,
          lat: p.lat,
          lng: p.lng,
          address: p.address,
        }));

      const res = await authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyPayload,
          userLocation: userLocation || mapCenter,
          groundingMode,
          tripContext: {
            destination: store.activeTrip?.destination,
            travelMode: store.prefs.travelMode,
            interests: store.prefs.interests,
            stopNames: store.stops.map((s) => s.name),
            enterprisePins: visibleEnterprisePins,
          },
        }),
      });

      const data = await res.json();
      if (data?.quotaExceeded) {
        window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      }
      if (!res.ok) {
        throw new Error(data?.error || 'Could not reach GeoInteract AI.');
      }

      const newPlaces: DiscoveredPlace[] = Array.isArray(data.discoveredPlaces)
        ? data.discoveredPlaces
        : [];
      if (newPlaces.length > 0) {
        setDiscoveredPlaces((prev) => {
          const existingIds = new Set(prev.map((p) => p.placeId).filter(Boolean));
          const merged = [...prev];
          for (const np of newPlaces) {
            if (!np.placeId || !existingIds.has(np.placeId)) {
              merged.unshift(np);
              if (np.placeId) existingIds.add(np.placeId);
            }
          }
          return merged.slice(0, 24);
        });
        setMapCenter({ lat: newPlaces[0].lat, lng: newPlaces[0].lng });
      }

      const proposals: AgentProposal[] = Array.isArray(data.proposals) ? data.proposals : [];

      await store.appendChatMessage({
        senderUid: 'assistant',
        senderName: 'GeoInteract AI',
        role: 'assistant',
        text: String(data.text || 'Here are the locations I found.'),
        groundingLinks: Array.isArray(data.groundingLinks) ? data.groundingLinks : [],
        discoveredPlaces: newPlaces,
        proposals,
      });
      triggerHaptic('success');
    },
    [store, userLocation, mapCenter, jiraPins, salesforcePins]
  );

  const handleOptimizeDay = useCallback(
    async (dayIndex: number): Promise<DayOptimizationResult | null> => {
      if (!store.activeTrip || isOffline) return null;
      const dayStops = store.stops
        .filter((s) => s.dayIndex === dayIndex)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      if (dayStops.length < 2) return null;

      try {
        const res = await authFetch('/api/routes/optimize-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tripId: store.activeTrip.id,
            dayIndex,
            travelMode: store.prefs.travelMode,
            avoidTolls: store.prefs.avoidTolls,
            stops: dayStops.map((s) => ({
              id: s.id,
              name: s.name,
              lat: s.lat,
              lng: s.lng,
            })),
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || data?.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          return null;
        }
        if (!res.ok) {
          store.setSyncNotice(data?.error || 'Unable to optimize day route right now.');
          return null;
        }

        const result = data as DayOptimizationResult;
        if (Array.isArray(result.orderedStopIds) && result.orderedStopIds.length > 0) {
          await store.reorderDayStops(dayIndex, result.orderedStopIds);
        }
        if (Array.isArray(result.legs)) {
          for (const leg of result.legs) {
            await store.cacheRouteOffline(leg);
          }
        }
        const savedKm =
          result.savedDistanceMeters > 100
            ? ` · Saved ${(result.savedDistanceMeters / 1000).toFixed(1)} km`
            : '';
        store.setSyncNotice(`Optimized Day ${dayIndex + 1} (${result.legs.length} legs cached offline${savedKm})`);
        triggerHaptic('success');
        return result;
      } catch (err) {
        store.setSyncNotice(
          err instanceof Error ? err.message : 'Day route optimization failed.'
        );
        return null;
      }
    },
    [store, isOffline]
  );

  const handleApplyProposal = useCallback(
    async (messageId: string, proposal: AgentProposal) => {
      if (proposal.applied) return;
      if (proposal.kind === 'add_stops' && Array.isArray(proposal.stops)) {
        const targetDay = proposal.dayIndex ?? 0;
        for (const s of proposal.stops) {
          await store.addStop({
            name: s.name,
            address: s.address,
            lat: s.lat,
            lng: s.lng,
            placeId: s.placeId,
            category: s.category || 'Curated Stop',
            priority: s.priority || 'normal',
            dayIndex: targetDay,
            notes: s.notes,
            rating: s.rating,
            googleMapsUri: s.googleMapsUri,
          });
        }
        if (proposal.stops[0]) {
          setMapCenter({ lat: proposal.stops[0].lat, lng: proposal.stops[0].lng });
        }
        store.setSyncNotice(`Added ${proposal.stops.length} stop(s) to Day ${targetDay + 1}.`);
      } else if (proposal.kind === 'create_geofence' && proposal.geofence) {
        await store.addGeofence({
          lat: proposal.geofence.lat,
          lng: proposal.geofence.lng,
          radiusMeters: proposal.geofence.radiusMeters,
          triggerOn: proposal.geofence.triggerOn,
          label: proposal.geofence.label,
          alertMessage: proposal.geofence.alertMessage,
        });
        setMapCenter({ lat: proposal.geofence.lat, lng: proposal.geofence.lng });
        store.setSyncNotice(`Created geofence "${proposal.geofence.label}".`);
      } else if (proposal.kind === 'optimize_day') {
        await handleOptimizeDay(proposal.dayIndex ?? 0);
      }

      store.markProposalApplied(messageId, proposal.id);
      triggerHaptic('success');
    },
    [store, handleOptimizeDay]
  );

  const handleCacheAllOfflineRoutes = useCallback(async (): Promise<number> => {
    if (!store.activeTrip || store.stops.length < 2) return 0;
    const sorted = [...store.stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
    let savedCount = 0;
    const routesLib = routesLibRef.current;

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const origin: LatLng = { lat: a.lat, lng: a.lng };
      const destination: LatLng = { lat: b.lat, lng: b.lng };

      if (!isOffline && routesLib?.Route?.computeRoutes) {
        try {
          const { routes } = await routesLib.Route.computeRoutes({
            origin,
            destination,
            travelMode: store.prefs.travelMode,
            fields: ['path', 'distanceMeters', 'durationMillis', 'legs'],
          });
          if (routes && routes.length > 0) {
            const r = routes[0];
            const polylines = r.createPolylines?.() || [];
            const path: LatLng[] = [];
            for (const pl of polylines) {
              const arr = pl.getPath?.()?.getArray?.() || [];
              for (const pt of arr) {
                path.push({ lat: pt.lat(), lng: pt.lng() });
              }
              pl.setMap(null);
            }

            const steps: OfflineRouteStep[] = [];
            if (Array.isArray(r.legs)) {
              for (const leg of r.legs) {
                for (const st of leg.steps || []) {
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

            const cached: CachedRoute = {
              id: buildRouteCacheKey(store.activeTrip.id, origin, destination, store.prefs.travelMode),
              tripId: store.activeTrip.id,
              originName: a.name,
              destinationName: b.name,
              origin,
              destination,
              travelMode: store.prefs.travelMode,
              distanceMeters: Number(r.distanceMeters || 0),
              durationMillis: Number(r.durationMillis || 0),
              path: path.length > 1 ? path : [origin, destination],
              steps:
                steps.length > 0
                  ? steps
                  : [
                      {
                        instruction: `Follow route from ${a.name} to ${b.name}`,
                        distanceMeters: Number(r.distanceMeters || 0),
                        durationSeconds: Math.round(Number(r.durationMillis || 0) / 1000),
                      },
                    ],
              isOfflineEstimate: false,
              computedAt: Date.now(),
            };
            await store.cacheRouteOffline(cached);
            savedCount++;
            continue;
          }
        } catch {
          // Fall back to offline corridor route calculation
        }
      }

      const fallback = computeOfflineFallbackRoute(
        store.activeTrip.id,
        origin,
        destination,
        a.name,
        b.name,
        store.prefs.travelMode
      );
      await store.cacheRouteOffline(fallback);
      savedCount++;
    }

    return savedCount;
  }, [store, isOffline]);

  const handleCheckTravelAlerts = useCallback(async () => {
    if (!store.activeTrip || isOffline) return;
    const res = await authFetch('/api/alerts/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: store.activeTrip.destination,
        stops: store.stops.map((s) => s.name),
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const summary = String(data.summary || '');
    const sourceUri = Array.isArray(data.groundingLinks) ? data.groundingLinks[0]?.uri : undefined;
    const lines = summary
      .split('\n')
      .map((l) => l.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);

    let dispatched = 0;
    for (const line of lines.slice(0, 3)) {
      let severity: AlertSeverity = 'normal';
      let delta = 15;
      if (line.includes('[LAST_MINUTE]')) {
        severity = 'last_minute_alert';
        delta = 45;
      } else if (line.includes('[SCHEDULE_IMPACT]')) {
        severity = 'schedule_impact';
        delta = 20;
      } else if (line.includes('[MINOR]')) {
        severity = 'minor';
        delta = 3;
      }
      const clean = line.replace(/\[(LAST_MINUTE|SCHEDULE_IMPACT|MINOR)\]\s*/g, '').trim();
      if (!clean) continue;

      const alertTitle =
        severity === 'last_minute_alert'
          ? 'Last-Minute Travel Alert'
          : severity === 'schedule_impact'
          ? 'Schedule Impact Advisory'
          : 'Minor Travel Note';

      const createdAlert = await store.emitAlert({
        severity,
        category: severity === 'last_minute_alert' ? 'transit' : 'schedule',
        scheduleDeltaMinutes: delta,
        title: alertTitle,
        body: clean,
        sourceUri,
      });

      if (
        enterprisePrefsRef.current.autoLogHighSeverityAlerts &&
        (severity === 'last_minute_alert' || severity === 'schedule_impact')
      ) {
        void postEnterpriseLog({
          eventType: 'travel_alert',
          severity,
          title: `${alertTitle}: ${store.activeTrip.destination}`,
          description: sourceUri ? `${clean}\nSource: ${sourceUri}` : clean,
          location: { lat: mapCenter.lat, lng: mapCenter.lng, label: store.activeTrip.destination },
          linkEntity: createdAlert ? { type: 'alert', id: createdAlert.id } : undefined,
        });
      }
      dispatched++;
    }

    if (dispatched === 0 && summary.trim()) {
      await store.emitAlert({
        severity: 'minor',
        category: 'schedule',
        scheduleDeltaMinutes: 0,
        title: 'Destination Status Check',
        body: summary.slice(0, 280),
        sourceUri,
      });
    }
  }, [store, isOffline, mapCenter.lat, mapCenter.lng, postEnterpriseLog]);

  const hasEnterpriseLogTarget = useMemo(
    () => enterprisePrefs.logTargets.some((t) => enterpriseStatus[t]),
    [enterprisePrefs.logTargets, enterpriseStatus]
  );

  const handleLogGeofenceCheckIn = useCallback(
    async (gf: TripGeofence, event: 'enter' | 'exit') => {
      const openJira =
        event === 'exit'
          ? gf.enterpriseLinks?.find((l) => l.target === 'jira' && l.status !== 'closed')?.recordId
          : undefined;
      const openSf =
        event === 'exit'
          ? gf.enterpriseLinks?.find((l) => l.target === 'salesforce' && l.status !== 'closed')
              ?.recordId
          : undefined;
      const openSnow =
        event === 'exit'
          ? gf.enterpriseLinks?.find((l) => l.target === 'servicenow' && l.status !== 'closed')
          : undefined;

      await postEnterpriseLog({
        eventType: 'geofence_checkin',
        geofenceEvent: event,
        title: `${event === 'enter' ? 'Check-In' : 'Check-Out'}: ${gf.label}`,
        description: gf.alertMessage || `Geofence ${event} logged at ${gf.label}.`,
        location: { lat: gf.lat, lng: gf.lng, label: gf.label },
        jiraIssueKey: openJira,
        salesforceRecordId: openSf,
        salesforceObjectName: openSf ? 'Task' : undefined,
        servicenowSysId: extractServiceNowSysId(openSnow?.recordUrl),
        linkEntity: { type: 'geofence', id: gf.id },
      });
    },
    [postEnterpriseLog]
  );

  const handleLogAlertToEnterprise = useCallback(
    async (alert: TripAlert) => {
      await postEnterpriseLog({
        eventType: 'travel_alert',
        severity: alert.severity,
        title: alert.title,
        description: alert.sourceUri ? `${alert.body}\nSource: ${alert.sourceUri}` : alert.body,
        location: {
          lat: (userLocation || mapCenter).lat,
          lng: (userLocation || mapCenter).lng,
          label: store.activeTrip?.destination,
        },
        linkEntity: { type: 'alert', id: alert.id },
      });
    },
    [postEnterpriseLog, userLocation, mapCenter, store.activeTrip?.destination]
  );

  const handleLogEnterprisePinCheckIn = useCallback(
    async (pin: EnterpriseMapPin) => {
      await postEnterpriseLog({
        targets: [pin.source],
        eventType: 'geofence_checkin',
        geofenceEvent: 'enter',
        title: `Site Check-In: ${pin.title}`,
        description: `Field check-in recorded at ${pin.title} (${pin.address}).`,
        location: { lat: pin.lat, lng: pin.lng, label: pin.title },
        jiraIssueKey: pin.source === 'jira' ? pin.externalKey : undefined,
        salesforceAccountId: pin.source === 'salesforce' ? pin.externalKey : undefined,
      });
    },
    [postEnterpriseLog]
  );

  const handleAddEnterprisePinToItinerary = useCallback(
    (pin: EnterpriseMapPin) => {
      void store.addStop({
        name: pin.title,
        address: pin.address,
        lat: pin.lat,
        lng: pin.lng,
        placeId: `ent_${pin.source}_${pin.externalKey}`,
        category: pin.source === 'jira' ? 'Jira Site' : 'Salesforce Account',
        priority: 'high',
        notes: [pin.subtitle, pin.status ? `Status: ${pin.status}` : ''].filter(Boolean).join(' · '),
        enterpriseLinks: [
          {
            target: pin.source,
            recordId: pin.externalKey,
            recordUrl: pin.externalUrl,
            eventType: 'geofence_checkin',
            loggedAt: Date.now(),
            status: 'open',
          },
        ],
      });
      store.setSyncNotice(`Added ${pin.externalKey} to itinerary.`);
    },
    [store]
  );

  const handleSendTestEnterpriseLog = useCallback(async () => {
    const pos = userLocation || mapCenter;
    return postEnterpriseLog({
      eventType: 'geofence_checkin',
      geofenceEvent: 'enter',
      title: `GeoInteract Connection Check-In`,
      description: `Test check-in dispatched from GeoInteract Preferences for ${store.activeTrip?.destination || 'current map area'}.`,
      location: { lat: pos.lat, lng: pos.lng, label: store.activeTrip?.destination || 'Map Center' },
    });
  }, [postEnterpriseLog, userLocation, mapCenter, store.activeTrip?.destination]);

  const activeEnterprisePins = useMemo(() => {
    const list: EnterpriseMapPin[] = [];
    if (enterprisePrefs.showJiraLayer) list.push(...jiraPins);
    if (enterprisePrefs.showSalesforceLayer) list.push(...salesforcePins);
    return list;
  }, [enterprisePrefs.showJiraLayer, enterprisePrefs.showSalesforceLayer, jiraPins, salesforcePins]);

  const handleBuildFieldDay = useCallback(
    async (dayIndex = 0): Promise<FieldDispatchResult | null> => {
      if (!store.activeTrip || isOffline || activeEnterprisePins.length === 0) return null;
      setBuildingFieldDay(true);
      try {
        const res = await authFetch('/api/enterprise/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tripId: store.activeTrip.id,
            dayIndex,
            travelMode: store.prefs.travelMode,
            avoidTolls: store.prefs.avoidTolls,
            origin: userLocation || mapCenter,
            pins: activeEnterprisePins.slice(0, 10),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || data?.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          return null;
        }
        if (!res.ok) {
          setEnterpriseNotice(data?.error || 'Could not dispatch Field Day.');
          return null;
        }

        const result = data as FieldDispatchResult;
        let autoGeofenced = 0;
        for (const sp of result.orderedStops) {
          const created = await store.addStop({
            name: sp.name,
            address: sp.address,
            lat: sp.lat,
            lng: sp.lng,
            placeId: `ent_${sp.source}_${sp.externalKey}`,
            category: sp.category,
            priority: sp.priority,
            dayIndex,
            notes: sp.notes,
            enterpriseLinks: [
              {
                target: sp.source,
                recordId: sp.externalKey,
                recordUrl: sp.externalUrl,
                eventType: 'geofence_checkin',
                loggedAt: Date.now(),
                status: 'open',
              },
            ],
          });

          if (created) {
            const alreadyCovered = store.geofences.some(
              (gf) =>
                gf.linkedStopId === created.id ||
                haversineDistanceMeters({ lat: gf.lat, lng: gf.lng }, { lat: sp.lat, lng: sp.lng }) <
                  120
            );
            if (!alreadyCovered) {
              await store.addGeofence({
                lat: sp.lat,
                lng: sp.lng,
                radiusMeters: sp.geofenceRadiusMeters || 250,
                triggerOn: 'both',
                label: sp.name,
                alertMessage: `Auto-Pilot check-in zone for ${sp.externalKey} (${sp.name})`,
                linkedStopId: created.id,
              });
              autoGeofenced++;
            }
          }
        }

        if (Array.isArray(result.legs)) {
          for (const leg of result.legs) {
            await store.cacheRouteOffline(leg);
          }
        }

        setActiveTab('itinerary');
        setRequestedItineraryLayout('map_view');
        if (window.innerWidth < 1024) setMobileSheetOpen(true);
        store.setSyncNotice(
          `Dispatched ${result.orderedStops.length} field stop(s) & ${autoGeofenced} Auto-Pilot geofence(s).`
        );
        triggerHaptic('success');
        return result;
      } catch (err) {
        setEnterpriseNotice(err instanceof Error ? err.message : 'Field dispatch failed.');
        return null;
      } finally {
        setBuildingFieldDay(false);
      }
    },
    [store, isOffline, activeEnterprisePins, userLocation, mapCenter]
  );

  const handleAutoProvisionGeofences = useCallback(async (): Promise<number> => {
    let createdCount = 0;
    for (const stop of store.stops) {
      if (stop.status === 'completed' || stop.status === 'skipped') continue;
      const alreadyCovered = store.geofences.some(
        (gf) =>
          gf.linkedStopId === stop.id ||
          haversineDistanceMeters({ lat: gf.lat, lng: gf.lng }, { lat: stop.lat, lng: stop.lng }) <
            120
      );
      if (alreadyCovered) continue;
      await store.addGeofence({
        lat: stop.lat,
        lng: stop.lng,
        radiusMeters: 250,
        triggerOn: 'both',
        label: stop.name,
        alertMessage: `Auto-Pilot proximity zone: ${stop.name}`,
        linkedStopId: stop.id,
      });
      createdCount++;
    }
    if (createdCount > 0) {
      store.setSyncNotice(
        `Auto-provisioned ${createdCount} linked Auto-Pilot geofence${createdCount === 1 ? '' : 's'}.`
      );
      triggerHaptic('success');
    }
    return createdCount;
  }, [store]);

  const handlePlanRecovery = useCallback(
    async (alert: TripAlert): Promise<DisruptionRecoveryPlan | null> => {
      if (!store.activeTrip || isOffline || store.stops.length === 0) return null;
      // Pick the first day that still has incomplete stops, or Day 0
      const incompleteStop = store.stops.find((s) => s.status !== 'completed');
      const targetDayIndex = incompleteStop ? incompleteStop.dayIndex : store.stops[0].dayIndex;
      const dayStops = store.stops
        .filter((s) => s.dayIndex === targetDayIndex)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      if (dayStops.length === 0) return null;

      try {
        const res = await authFetch('/api/alerts/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tripId: store.activeTrip.id,
            dayIndex: targetDayIndex,
            destination: store.activeTrip.destination,
            travelMode: store.prefs.travelMode,
            interests: store.prefs.interests,
            alert: {
              id: alert.id,
              title: alert.title,
              body: alert.body,
              severity: alert.severity,
              category: alert.category,
            },
            stops: dayStops.map((s) => ({
              id: s.id,
              name: s.name,
              address: s.address,
              lat: s.lat,
              lng: s.lng,
              category: s.category,
              priority: s.priority,
              status: s.status,
              placeId: s.placeId,
              notes: s.notes,
              rating: s.rating,
              googleMapsUri: s.googleMapsUri,
            })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || data?.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          return null;
        }
        if (!res.ok) {
          store.setSyncNotice(data?.error || 'Unable to generate disruption recovery plan.');
          return null;
        }
        const plan = data as DisruptionRecoveryPlan;
        setActiveRecoveryPlan(plan);
        triggerHaptic('success');
        return plan;
      } catch (err) {
        store.setSyncNotice(err instanceof Error ? err.message : 'Recovery planner failed.');
        return null;
      }
    },
    [store, isOffline]
  );

  const handlePreviewRecoveryOnMap = useCallback((plan: DisruptionRecoveryPlan) => {
    setActiveRecoveryPlan(plan);
    setActiveTab('itinerary');
    setRequestedItineraryLayout('map_view');
    if (window.innerWidth < 1024) setMobileSheetOpen(true);
  }, []);

  const handleApplyRecoveryPlan = useCallback(
    async (plan: DisruptionRecoveryPlan, escalateToEnterprise: boolean) => {
      await store.applyDisruptionRecovery(plan);
      if (escalateToEnterprise && hasEnterpriseLogTarget) {
        await postEnterpriseLog({
          eventType: 'travel_alert',
          severity: 'schedule_impact',
          title: `Recovery Applied: Day ${plan.dayIndex + 1} (${store.activeTrip?.destination || 'Trip'})`,
          description: plan.escalationMessage || plan.summary,
          location: {
            lat: (userLocation || mapCenter).lat,
            lng: (userLocation || mapCenter).lng,
            label: store.activeTrip?.destination,
          },
          linkEntity: { type: 'alert', id: plan.alertId },
        });
      }
      setActiveRecoveryPlan(null);
      store.setSyncNotice(
        `Applied recovery plan for Day ${plan.dayIndex + 1} (${plan.replacements.length} replacement${
          plan.replacements.length === 1 ? '' : 's'
        }).`
      );
      triggerHaptic('success');
    },
    [store, hasEnterpriseLogTarget, postEnterpriseLog, userLocation, mapCenter]
  );

  const openFieldOpsConsole = useCallback((initial: 'audit' | 'outbox' | 'activity' = 'audit') => {
    setFieldOpsTab(initial);
    setShowFieldOps(true);
  }, []);

  const handleLoadInteractiveDemo = useCallback(async () => {
    // Never turn on real GPS when launching Safe Demo
    setGpsTrackingEnabled(false);
    const demo = await store.loadInteractiveDemoTrip();
    setMapCenter(demo.trip.center);
    // Position simulated explorer just outside Stop 1 so "Sim Arrival" triggers an immediate entry event
    processLocationUpdate(
      { lat: demo.trip.center.lat - 0.0045, lng: demo.trip.center.lng - 0.0045 },
      { isSimulated: true }
    );
    setActiveTab('itinerary');
  }, [store, setGpsTrackingEnabled, processLocationUpdate]);

  const handleSimulateGeofenceEvent = useCallback(
    (mode: 'enter' | 'exit') => {
      const targetGf = store.geofences.find((g) => g.active);
      if (!targetGf) return;
      // Ensure live GPS stays off when simulating
      setGpsTrackingEnabled(false);
      if (mode === 'enter') {
        processLocationUpdate({ lat: targetGf.lat, lng: targetGf.lng }, { isSimulated: true });
      } else {
        // Move ~750m outside radius so hysteresis exit + Auto-Pilot stop completion fires cleanly
        const offsetDeg = Math.max(0.006, (targetGf.radiusMeters * 2.2) / 111_000);
        processLocationUpdate(
          { lat: targetGf.lat + offsetDeg, lng: targetGf.lng + offsetDeg },
          { isSimulated: true }
        );
      }
    },
    [store.geofences, setGpsTrackingEnabled, processLocationUpdate]
  );

  const activeAlertCount = useMemo(
    () => store.alerts.filter((a) => !a.suppressed && a.severity !== 'minor').length,
    [store.alerts]
  );

  const isDark = store.prefs.theme === 'dark';

  const handleTabSelect = (tab: WorkspaceTab) => {
    triggerHaptic('light');
    if (window.innerWidth < 1024) {
      if (activeTab === tab && mobileSheetOpen) {
        setMobileSheetOpen(false);
      } else {
        setActiveTab(tab);
        setMobileSheetOpen(true);
      }
    } else {
      setActiveTab(tab);
    }
  };

  const renderPanelContent = () => {
    switch (activeTab) {
      case 'explore':
        return (
          <ChatPanel
            messages={store.messages}
            activeTrip={store.activeTrip}
            stops={store.stops}
            userLocation={userLocation || mapCenter}
            prefs={store.prefs}
            isOffline={isOffline}
            onSendMessage={handleSendChatMessage}
            onAddPlace={handleAddPlaceToItinerary}
            onFocusPlace={(place) => {
              setMapCenter({ lat: place.lat, lng: place.lng });
              setDiscoveredPlaces((prev) => {
                const exists = prev.some((p) => p.placeId && p.placeId === place.placeId);
                return exists ? prev : [place, ...prev];
              });
              if (window.innerWidth < 1024) setMobileSheetOpen(false);
            }}
            onRouteToPlace={(place) => {
              handleStartRouteTo({ lat: place.lat, lng: place.lng }, place.name);
              if (window.innerWidth < 1024) setMobileSheetOpen(false);
            }}
            onApplyProposal={handleApplyProposal}
          />
        );
      case 'itinerary':
        return (
          <ItineraryDashboard
            trips={store.trips}
            activeTrip={store.activeTrip}
            stops={store.stops}
            geofences={store.geofences}
            alerts={store.alerts}
            members={store.members}
            currentUserUid={store.user?.uid}
            cachedRoutes={store.cachedRoutes}
            prefs={store.prefs}
            isOffline={isOffline}
            enterprisePinCount={activeEnterprisePins.length}
            hasEnterpriseLogTarget={hasEnterpriseLogTarget}
            onSelectTrip={store.setActiveTripId}
            onCreateTrip={store.createTrip}
            onUpdateStop={store.updateStop}
            onReorderDayStops={store.reorderDayStops}
            onMoveStopToDay={store.moveStopToDay}
            onRemoveStop={store.removeStop}
            onRouteLeg={handleRouteLeg}
            onCacheAllOfflineRoutes={handleCacheAllOfflineRoutes}
            onOptimizeDay={handleOptimizeDay}
            onBuildFieldDay={handleBuildFieldDay}
            onCheckTravelAlerts={handleCheckTravelAlerts}
            onFocusStop={(pos) => {
              setMapCenter(pos);
              if (window.innerWidth < 1024) setMobileSheetOpen(false);
            }}
            recoveryPreview={activeRecoveryPlan}
            onApplyRecovery={
              activeRecoveryPlan
                ? (escalate) => handleApplyRecoveryPlan(activeRecoveryPlan, escalate)
                : undefined
            }
            onDismissRecovery={() => setActiveRecoveryPlan(null)}
            requestedLayoutMode={requestedItineraryLayout}
            onConsumeRequestedLayout={() => setRequestedItineraryLayout(null)}
            mapCenter={mapCenter}
          />
        );
      case 'geofences':
        return (
          <GeofencePanel
            geofences={store.geofences}
            stops={store.stops}
            mapCenter={mapCenter}
            userLocation={userLocation}
            gpsAccuracyMeters={gpsAccuracyMeters}
            gpsTrackingEnabled={gpsTrackingEnabled}
            simulateClickMode={simulateClickMode}
            hasEnterpriseLogTarget={hasEnterpriseLogTarget}
            onToggleGpsTracking={() => setGpsTrackingEnabled((v) => !v)}
            onToggleSimulateClickMode={() => setSimulateClickMode((v) => !v)}
            onSimulatePosition={(pos) => processLocationUpdate(pos, { isSimulated: true })}
            onAddGeofence={store.addGeofence}
            onAutoProvisionGeofences={handleAutoProvisionGeofences}
            onToggleGeofence={store.toggleGeofence}
            onRemoveGeofence={store.removeGeofence}
            onLogGeofenceCheckIn={handleLogGeofenceCheckIn}
            onOpenPreferences={() => setShowPrefsModal(true)}
          />
        );
      case 'alerts':
        return (
          <AlertsPanel
            alerts={store.alerts}
            prefs={store.prefs}
            hasEnterpriseLogTarget={hasEnterpriseLogTarget}
            activeDayStopCount={store.stops.length}
            isOffline={isOffline}
            activeRecoveryPlan={activeRecoveryPlan}
            onPlanRecovery={handlePlanRecovery}
            onPreviewRecoveryOnMap={handlePreviewRecoveryOnMap}
            onApplyRecoveryPlan={handleApplyRecoveryPlan}
            onDismissRecoveryPlan={() => setActiveRecoveryPlan(null)}
            onLogAlertToEnterprise={handleLogAlertToEnterprise}
            onOpenPreferences={() => setShowPrefsModal(true)}
            onOpenFieldOps={() => openFieldOpsConsole('audit')}
          />
        );
    }
  };

  return (
    <div className="h-[100dvh] w-screen overflow-hidden flex flex-col bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100">
      {/* Demo Key Quota Defense Sticky Banner (Case A) */}
      {quotaExceeded && (
        <div
          role="alert"
          className="z-50 px-4 py-2 bg-amber-500 text-slate-950 text-xs font-medium flex flex-wrap items-center justify-between gap-2 shrink-0"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              The demo Google Maps quota has been temporarily exceeded. Switch to your own Google Maps Platform API key in Settings to restore full live tiles and Places searches.
            </span>
          </span>
          <a
            href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-semibold whitespace-nowrap"
          >
            Quota Help
          </a>
        </div>
      )}

      {/* Top Bar (3-Zone Contract: Wordmark | View Navigation | Primary Share/Account/Settings) */}
      <header className="h-14 shrink-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 backdrop-blur-md px-3 sm:px-4 flex items-center justify-between gap-3">
        {/* Left: Wordmark */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500 text-slate-950 flex items-center justify-center shrink-0">
            <Compass className="w-5 h-5" />
          </div>
          <span className="font-display font-bold text-base tracking-tight text-slate-900 dark:text-slate-100">
            GeoInteract
          </span>
          {store.activeTrip && (
            <span className="hidden xl:inline-flex items-center gap-1 text-xs text-slate-400 border-l border-slate-200 dark:border-slate-800 pl-2.5 truncate max-w-[190px]">
              <Lock className="w-3 h-3 text-emerald-500 shrink-0" />
              <span className="truncate">{store.activeTrip.title}</span>
            </span>
          )}
        </div>

        {/* Center: Desktop View Switcher */}
        <nav
          aria-label="Workspace views"
          className="hidden lg:flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800"
        >
          {(
            [
              { id: 'explore', label: 'Explore', icon: MessageSquare },
              { id: 'itinerary', label: 'Itinerary', icon: CalendarDays },
              { id: 'geofences', label: 'Geofences', icon: Radio },
              { id: 'alerts', label: 'Alerts', icon: Bell },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleTabSelect(item.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
                {item.id === 'alerts' && activeAlertCount > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded bg-rose-500 text-white text-[10px] font-mono leading-none">
                    {activeAlertCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right: Primary Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <PWAInstallButton />

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              void store.updatePreferences({ theme: isDark ? 'light' : 'dark' });
            }}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light mode' : 'Dark mode'}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-emerald-500/50 min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setShowPrefsModal(true);
            }}
            aria-label="Open preferences"
            title="Preferences & Notification Rules"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-emerald-500/50 min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            <Sliders className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium');
              setShowShareModal(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-2 text-xs font-semibold hover:bg-emerald-400 transition-colors min-h-[40px] whitespace-nowrap"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Share</span>
          </button>

          {store.user ? (
            <button
              type="button"
              onClick={() => void store.signOutUser()}
              title={`Signed in as ${store.user.displayName || store.user.email} (Sign out)`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-rose-500/50 min-h-[40px]"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline max-w-[90px] truncate">
                {store.user.displayName?.split(' ')[0] || 'Account'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void store.signInWithGoogle()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[40px] whitespace-nowrap"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign In</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Split Workspace */}
      <main className="relative flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Map Canvas Column */}
        <div className="relative flex-1 min-h-0">
          {/* Floating Privacy, Demo, Offline & Sync Controls */}
          <div className="absolute top-3 right-3 z-30 flex flex-col items-end gap-2 pointer-events-none max-w-[90vw]">
            <PrivacyLocationControl
              gpsTrackingEnabled={gpsTrackingEnabled}
              gpsAccuracyMeters={gpsAccuracyMeters}
              userLocation={userLocation}
              simulateClickMode={simulateClickMode}
              offlineSimulated={store.prefs.offlineModePreferred}
              geofences={store.geofences}
              hasStops={store.stops.length > 0}
              onToggleGpsTracking={() => setGpsTrackingEnabled((v) => !v)}
              onToggleSimulateClickMode={() => setSimulateClickMode((v) => !v)}
              onToggleOfflineSimulated={() =>
                void store.updatePreferences({
                  offlineModePreferred: !store.prefs.offlineModePreferred,
                })
              }
              onLoadInteractiveDemo={handleLoadInteractiveDemo}
              onSimulateGeofenceEvent={handleSimulateGeofenceEvent}
              onOpenShareVault={() => setShowShareModal(true)}
            />

            <div className="pointer-events-auto">
              <OfflineIndicator
                offlineSimulated={store.prefs.offlineModePreferred}
                smartSync={store.smartSync}
                onSyncNow={() => void handleSyncNow(true)}
                onInspectQueue={() => openFieldOpsConsole('outbox')}
              />
            </div>

            {store.syncNotice && (
              <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-[#121824]/95 text-slate-100 px-3 py-2 text-xs shadow-lg">
                <span>{store.syncNotice}</span>
                <button
                  type="button"
                  onClick={store.dismissSyncNotice}
                  aria-label="Dismiss notice"
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {enterpriseNotice && (
              <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-sky-500/40 bg-[#121824]/95 text-slate-100 px-3 py-2 text-xs shadow-lg">
                <span>{enterpriseNotice}</span>
                <button
                  type="button"
                  onClick={() => setEnterpriseNotice(null)}
                  aria-label="Dismiss enterprise notice"
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {store.bannerAlert && (
              <div
                role="status"
                className={`pointer-events-auto w-72 sm:w-80 rounded-xl border p-3 shadow-xl backdrop-blur-md space-y-1 ${
                  store.bannerAlert.severity === 'last_minute_alert'
                    ? 'border-rose-500/60 bg-rose-950/95 text-rose-100'
                    : 'border-amber-500/50 bg-[#121824]/95 text-slate-100'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{store.bannerAlert.title}</span>
                  <button
                    type="button"
                    onClick={store.dismissBannerAlert}
                    aria-label="Dismiss alert"
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-xs opacity-90 leading-snug">{store.bannerAlert.body}</p>
              </div>
            )}
          </div>

          {mapsKeyLoaded && mapsApiKey ? (
            <APIProvider apiKey={mapsApiKey} libraries={GOOGLE_MAPS_LIBRARIES}>
              <RoutesLibraryBridge onReady={handleRoutesLibReady} />
              <MapViewport
                center={mapCenter}
                onCenterChanged={setMapCenter}
                stops={store.stops}
                discoveredPlaces={discoveredPlaces}
                geofences={store.geofences}
                userLocation={userLocation}
                activeRouteRequest={activeRouteRequest}
                cachedRoutes={store.cachedRoutes}
                onRouteComputed={store.cacheRouteOffline}
                onClearRoute={handleClearRoute}
                onAddPlaceToItinerary={handleAddPlaceToItinerary}
                onCreateGeofenceAt={handleCreateGeofenceAt}
                onStartRouteTo={handleStartRouteTo}
                onPlaceSelected={handlePlaceSelected}
                onQuickCategorySearch={(q, types) => void handleQuickCategorySearch(q, types)}
                isDark={isDark}
                isOffline={isOffline}
                simulateClickMode={simulateClickMode}
                onSimulateLocation={(pos) => {
                  setSimulateClickMode(false);
                  processLocationUpdate(pos, { isSimulated: true });
                }}
                highlightNormalTasks={store.prefs.highlightNormalTasks}
                enterpriseStatus={enterpriseStatus}
                jiraPins={jiraPins}
                salesforcePins={salesforcePins}
                showJiraLayer={enterprisePrefs.showJiraLayer}
                showSalesforceLayer={enterprisePrefs.showSalesforceLayer}
                enterpriseLoading={enterpriseLoading}
                onToggleJiraLayer={() =>
                  updateEnterprisePrefs({ showJiraLayer: !enterprisePrefs.showJiraLayer })
                }
                onToggleSalesforceLayer={() =>
                  updateEnterprisePrefs({ showSalesforceLayer: !enterprisePrefs.showSalesforceLayer })
                }
                onLogEnterprisePinCheckIn={handleLogEnterprisePinCheckIn}
                onAddEnterprisePinToItinerary={handleAddEnterprisePinToItinerary}
                onBoundsChanged={handleBoundsChanged}
                onSyncAreaEnterprise={handleSyncAreaEnterprise}
                onBuildFieldDayFromMap={async () => {
                  await handleBuildFieldDay(0);
                }}
                buildingFieldDay={buildingFieldDay}
                triggeredGeofenceCues={triggeredGeofenceCues}
              />
            </APIProvider>
          ) : mapsKeyLoaded ? (
            <DemoVectorMap
              center={mapCenter}
              stops={store.stops}
              geofences={store.geofences}
              userLocation={userLocation}
              highlightNormalTasks={store.prefs.highlightNormalTasks}
              simulateClickMode={simulateClickMode}
              onSimulateLocation={(pos) => {
                setSimulateClickMode(false);
                processLocationUpdate(pos, { isSimulated: true });
              }}
              onSelectStop={(stop) => {
                setMapCenter({ lat: stop.lat, lng: stop.lng });
                setActiveTab('itinerary');
                if (window.innerWidth < 1024) setMobileSheetOpen(true);
              }}
              onLoadInteractiveDemo={() => void handleLoadInteractiveDemo()}
              reasonLabel="Live Maps API Key Not Configured"
              triggeredGeofenceCues={triggeredGeofenceCues}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-[#0B0F17] text-slate-300 p-6">
              <div className="max-w-sm text-center space-y-2">
                <Compass className="w-8 h-8 text-emerald-500 mx-auto animate-pulse" />
                <p className="text-sm font-medium">Initializing GeoInteract cartography...</p>
              </div>
            </div>
          )}
        </div>

        {/* Desktop Side Drawer */}
        <aside className="hidden lg:flex lg:w-[420px] xl:w-[460px] shrink-0 flex-col border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] min-h-0">
          {renderPanelContent()}
        </aside>

        {/* Mobile Expandable Drawer */}
        {mobileSheetOpen && (
          <div className="lg:hidden fixed inset-x-0 bottom-16 z-30 h-[66dvh] rounded-t-2xl border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] shadow-2xl flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {activeTab === 'explore'
                  ? 'GeoInteract AI Concierge'
                  : activeTab === 'itinerary'
                  ? 'Trip Itinerary'
                  : activeTab === 'geofences'
                  ? 'Geofence Radar'
                  : 'Smart Alerts'}
              </span>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setMobileSheetOpen(false);
                }}
                aria-label="Collapse panel"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 min-h-[36px] min-w-[36px] flex items-center justify-center"
              >
                <ChevronDown className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">{renderPanelContent()}</div>
          </div>
        )}
      </main>

      {/* Mobile Bottom Thumb-Zone Navigation (<= 15% sticky height cap, 44px+ targets) */}
      <nav
        aria-label="Mobile navigation"
        className="lg:hidden h-16 pb-safe shrink-0 z-40 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 backdrop-blur-md grid grid-cols-4"
      >
        {(
          [
            { id: 'explore', label: 'Explore', icon: MessageSquare },
            { id: 'itinerary', label: 'Itinerary', icon: CalendarDays },
            { id: 'geofences', label: 'Geofences', icon: Radio },
            { id: 'alerts', label: 'Alerts', icon: Bell },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = mobileSheetOpen && activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleTabSelect(item.id)}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium min-h-[44px] relative ${
                active
                  ? 'text-emerald-500'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
              {item.id === 'alerts' && activeAlertCount > 0 && (
                <span className="absolute top-1.5 right-6 px-1 rounded bg-rose-500 text-white text-[9px] font-mono leading-tight">
                  {activeAlertCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Pending Encrypted Invite Acceptance Modal */}
      {store.pendingJoin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-500 flex items-center justify-center">
                <Lock className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Join Encrypted Group Trip
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Decryption key imported locally via URL fragment.
                </p>
              </div>
            </div>

            {!store.user ? (
              <div className="space-y-3">
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Sign in with Google to accept this invite and sync the encrypted itinerary in real time.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={store.dismissPendingJoin}
                    className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 py-2.5 text-xs font-medium min-h-[44px]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void store.signInWithGoogle()}
                    className="flex-1 rounded-xl bg-emerald-500 text-slate-950 py-2.5 text-xs font-semibold min-h-[44px]"
                  >
                    Sign In to Join
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={store.dismissPendingJoin}
                  className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 py-2.5 text-xs font-medium min-h-[44px]"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => void store.acceptPendingJoin()}
                  className="flex-1 rounded-xl bg-emerald-500 text-slate-950 py-2.5 text-xs font-semibold min-h-[44px]"
                >
                  Accept &amp; Decrypt Trip
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Share & E2EE Modal */}
      <ShareEncryptModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        activeTrip={store.activeTrip}
        user={store.user}
        members={store.members}
        onSignIn={store.signInWithGoogle}
        onSyncLocalTrip={store.syncLocalTripToCloud}
        onCreateShareLink={store.createEncryptedShareLink}
        onKeyRestored={(_tripId, fingerprint) => {
          store.setSyncNotice(
            `Restored encrypted trip key (${fingerprint}) into device vault.`
          );
        }}
      />

      {/* Preferences & Smart Notification Filter Modal */}
      <PreferencesModal
        isOpen={showPrefsModal}
        onClose={() => setShowPrefsModal(false)}
        prefs={store.prefs}
        onUpdatePrefs={store.updatePreferences}
        isSignedIn={Boolean(store.user)}
        onSignIn={store.signInWithGoogle}
        smartSync={store.smartSync}
        onSyncNow={() => handleSyncNow(true)}
        enterpriseStatus={enterpriseStatus}
        enterprisePrefs={enterprisePrefs}
        enterpriseCounts={{ jira: jiraPins.length, salesforce: salesforcePins.length }}
        enterpriseLoading={enterpriseLoading}
        enterpriseError={enterpriseError}
        onUpdateEnterprisePrefs={updateEnterprisePrefs}
        onRefreshEnterpriseStatus={refreshEnterpriseStatus}
        onSyncEnterpriseLayer={syncEnterpriseLayer}
        onSendTestEnterpriseLog={handleSendTestEnterpriseLog}
        onOpenFieldOps={() => openFieldOpsConsole('audit')}
      />

      {/* Unified Field Ops, Audit Trail & Sync Outbox Console */}
      <FieldOpsDrawer
        isOpen={showFieldOps}
        onClose={() => setShowFieldOps(false)}
        initialTab={fieldOpsTab}
        isOffline={isOffline}
        smartSync={store.smartSync}
        onSyncNow={() => handleSyncNow(true)}
        stops={store.stops}
        geofences={store.geofences}
        alerts={store.alerts}
        members={store.members}
        currentUserUid={store.user?.uid}
      />
    </div>
  );
}
