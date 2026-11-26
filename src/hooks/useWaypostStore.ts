import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../firebase/client';
import {
  AlertCategory,
  AlertSeverity,
  CachedRoute,
  ChatMessage,
  CollaboratorMember,
  DisruptionRecoveryPlan,
  EnterpriseRecordLink,
  GeofenceTrigger,
  LatLng,
  PriorityLevel,
  SmartSyncStatus,
  StopStatus,
  SyncOutboxItem,
  TravelMode,
  Trip,
  TripAlert,
  TripGeofence,
  TripStop,
  UserPreferences,
} from '../types/travel';
import {
  decryptJson,
  encryptJson,
  getOrCreateTripKey,
  importTripKey,
  migrateAllLegacyKeysToVault,
  saveTripKeyLocally,
  toCoarsePrivacyCoord,
} from '../utils/e2ee';
import { setHapticsEnabled, triggerHaptic } from '../utils/haptics';
import { dispatchSmartNotification } from '../utils/notifications';
import {
  loadCachedRoutesForTrip,
  loadOfflineTripBundles,
  OfflineTripBundle,
  saveCachedRoute,
  saveOfflineTripBundle,
} from '../utils/offlineStorage';
import {
  enqueueFirestoreMutation,
  getSmartSyncStatus,
  refreshSyncStatus,
  subscribeSmartSyncStatus,
} from '../utils/offlineSync';

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  hapticsEnabled: true,
  offlineModePreferred: false,
  travelMode: 'WALKING',
  avoidTolls: false,
  ecoRouting: true,
  suppressMinorAlerts: true,
  notifyScheduleImpact: true,
  notifyLastMinuteAlerts: true,
  notifyGeofence: true,
  notifyCollab: true,
  highlightNormalTasks: true,
  interests: 'coffee, architecture, scenic walks, local dining',
};

const PREFS_STORAGE_KEY = 'waypost_user_prefs_v1';
const LOCAL_TRIPS_KEY = 'waypost_local_trips_v1';

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function loadLocalPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function saveLocalPrefs(prefs: UserPreferences) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage error
  }
}

function isNetworkOrOfflineError(err: any): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = String(err?.code || '').toLowerCase();
  return code === 'unavailable' || code === 'deadline-exceeded' || code === 'failed-precondition';
}

export interface InAppBannerAlert {
  id: string;
  title: string;
  body: string;
  severity: AlertSeverity;
}

export function useWaypostStore() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences>(loadLocalPrefs);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [activeTripId, setActiveTripId] = useState<string>('');
  const [stops, setStops] = useState<TripStop[]>([]);
  const [geofences, setGeofences] = useState<TripGeofence[]>([]);
  const [alerts, setAlerts] = useState<TripAlert[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<CollaboratorMember[]>([]);
  const [cachedRoutes, setCachedRoutes] = useState<CachedRoute[]>([]);
  const [bannerAlert, setBannerAlert] = useState<InAppBannerAlert | null>(null);
  const [pendingJoin, setPendingJoin] = useState<{ tripId: string; code: string; keyRaw: string } | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [smartSync, setSmartSync] = useState<SmartSyncStatus>(getSmartSyncStatus);

  const tripKeysRef = useRef<Record<string, CryptoKey>>({});
  const prefsRef = useRef<UserPreferences>(prefs);
  prefsRef.current = prefs;
  const activeBundleRef = useRef<OfflineTripBundle | null>(null);
  const backfilledCollabSigRef = useRef<Record<string, string>>({});

  // Subscribe to Smart Offline Sync status
  useEffect(() => {
    const unsub = subscribeSmartSyncStatus(setSmartSync);
    void refreshSyncStatus();
    return unsub;
  }, []);

  // Apply theme & haptics immediately
  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    setHapticsEnabled(prefs.hapticsEnabled);
    saveLocalPrefs(prefs);
  }, [prefs]);

  // Check URL for E2EE invite params: ?joinTrip=...&code=...#key=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tripId = params.get('joinTrip');
    const code = params.get('code');
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const keyRaw = hashParams.get('key');
    if (tripId && code && keyRaw) {
      void saveTripKeyLocally(tripId, keyRaw).catch(() => {});
      setPendingJoin({ tripId, code, keyRaw });
    }
  }, []);

  // Ensure initial starter trip in local mode if none exist & migrate any legacy keys
  useEffect(() => {
    let cancelled = false;
    async function initOfflineState() {
      await migrateAllLegacyKeysToVault();
      const bundles = await loadOfflineTripBundles();
      if (cancelled) return;
      if (bundles.length > 0) {
        setTrips(bundles.map((b) => b.trip));
        const first = bundles[0];
        setActiveTripId((prev) => prev || first.trip.id);
        setStops(first.stops);
        setGeofences(first.geofences);
        setAlerts(first.alerts);
        setMessages(first.messages);
        const routes = await loadCachedRoutesForTrip(first.trip.id);
        if (!cancelled) setCachedRoutes(routes);
        return;
      }

      // Check legacy localStorage fallback
      try {
        const rawLocal = localStorage.getItem(LOCAL_TRIPS_KEY);
        if (rawLocal) {
          const parsed = JSON.parse(rawLocal) as OfflineTripBundle[];
          if (parsed.length > 0) {
            setTrips(parsed.map((b) => b.trip));
            setActiveTripId(parsed[0].trip.id);
            setStops(parsed[0].stops);
            setGeofences(parsed[0].geofences);
            setAlerts(parsed[0].alerts);
            setMessages(parsed[0].messages);
            return;
          }
        }
      } catch {
        // Ignore parse error
      }

      // Create clean starter trip without hallucinated POI data
      const starterId = makeId('trip');
      const { key, fingerprint } = await getOrCreateTripKey(starterId);
      tripKeysRef.current[starterId] = key;

      const today = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

      const starterTrip: Trip = {
        id: starterId,
        ownerId: 'local_explorer',
        collaboratorUids: ['local_explorer'],
        title: 'City Explorer Itinerary',
        destination: 'Current Map Area',
        startDate: today,
        endDate: nextWeek,
        center: { lat: 37.7749, lng: -122.4194 },
        travelMode: 'WALKING',
        notes: 'Ask GeoInteract AI or search Google Maps to pin curated stops.',
        status: 'active',
        keyFingerprint: fingerprint,
        encryptionAlgo: 'AES-GCM-256',
        updatedAt: Date.now(),
      };

      const welcomeMsg: ChatMessage = {
        id: makeId('msg'),
        tripId: starterId,
        senderUid: 'assistant',
        senderName: 'GeoInteract AI',
        role: 'assistant',
        text: 'Welcome to GeoInteract. Ask me to plan stops, set geofences, optimize a day loop, or check real-time advisories near the map—I use live Google Maps Places and Search data and can apply changes to your trip in one tap.',
        createdAt: Date.now(),
      };

      const bundle: OfflineTripBundle = {
        trip: starterTrip,
        stops: [],
        geofences: [],
        alerts: [],
        messages: [welcomeMsg],
        updatedAt: Date.now(),
      };

      await saveOfflineTripBundle(bundle);
      if (!cancelled) {
        setTrips([starterTrip]);
        setActiveTripId(starterId);
        setMessages([welcomeMsg]);
      }
    }

    void initOfflineState();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTrip = trips.find((t) => t.id === activeTripId) || trips[0] || null;

  // Debounced encrypted IndexedDB vault persistence (450ms + immediate flush on pagehide/visibilitychange)
  useEffect(() => {
    if (!activeTrip) return;
    const bundle: OfflineTripBundle = {
      trip: activeTrip,
      stops,
      geofences,
      alerts,
      messages,
      updatedAt: Date.now(),
    };
    activeBundleRef.current = bundle;

    const timer = window.setTimeout(() => {
      if (activeBundleRef.current) {
        void saveOfflineTripBundle(activeBundleRef.current);
      }
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTrip, stops, geofences, alerts, messages]);

  useEffect(() => {
    const flushVault = () => {
      if (activeBundleRef.current) {
        void saveOfflineTripBundle(activeBundleRef.current);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushVault();
    };
    window.addEventListener('pagehide', flushVault);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushVault);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Load cached routes when active trip changes
  useEffect(() => {
    if (!activeTripId) return;
    void loadCachedRoutesForTrip(activeTripId).then(setCachedRoutes);
  }, [activeTripId]);

  // Firebase Auth listener & user profile/prefs sync
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);

      if (!firebaseUser) return;

      try {
        await setDoc(
          doc(db, 'users', firebaseUser.uid, 'public', 'profile'),
          {
            uid: firebaseUser.uid,
            displayName: (firebaseUser.displayName || 'Traveler').slice(0, 100),
            photoUrl: (firebaseUser.photoURL || '').slice(0, 500),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        if (firebaseUser.email) {
          await setDoc(
            doc(db, 'users', firebaseUser.uid, 'private', 'info'),
            {
              uid: firebaseUser.uid,
              email: firebaseUser.email.slice(0, 254),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        }

        const prefRef = doc(db, 'users', firebaseUser.uid, 'preferences', 'settings');
        const prefSnap = await getDoc(prefRef);
        if (prefSnap.exists()) {
          const data = prefSnap.data() as Partial<UserPreferences>;
          setPrefs((prev) => ({
            ...prev,
            theme: data.theme === 'light' ? 'light' : 'dark',
            hapticsEnabled: typeof data.hapticsEnabled === 'boolean' ? data.hapticsEnabled : prev.hapticsEnabled,
            offlineModePreferred: typeof data.offlineModePreferred === 'boolean' ? data.offlineModePreferred : prev.offlineModePreferred,
            travelMode: data.travelMode || prev.travelMode,
            avoidTolls: typeof data.avoidTolls === 'boolean' ? data.avoidTolls : prev.avoidTolls,
            ecoRouting: typeof data.ecoRouting === 'boolean' ? data.ecoRouting : prev.ecoRouting,
            suppressMinorAlerts: typeof data.suppressMinorAlerts === 'boolean' ? data.suppressMinorAlerts : prev.suppressMinorAlerts,
            notifyScheduleImpact: typeof data.notifyScheduleImpact === 'boolean' ? data.notifyScheduleImpact : prev.notifyScheduleImpact,
            notifyLastMinuteAlerts: typeof data.notifyLastMinuteAlerts === 'boolean' ? data.notifyLastMinuteAlerts : prev.notifyLastMinuteAlerts,
            notifyGeofence: typeof data.notifyGeofence === 'boolean' ? data.notifyGeofence : prev.notifyGeofence,
            notifyCollab: typeof data.notifyCollab === 'boolean' ? data.notifyCollab : prev.notifyCollab,
            highlightNormalTasks: typeof data.highlightNormalTasks === 'boolean' ? data.highlightNormalTasks : prev.highlightNormalTasks,
            interests: typeof data.interests === 'string' ? data.interests : prev.interests,
          }));
        } else {
          await setDoc(prefRef, {
            uid: firebaseUser.uid,
            ...prefsRef.current,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err: any) {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.WRITE, `users/${firebaseUser.uid}`);
        }
      }
    });
    return () => unsub();
  }, []);

  const ensureTripKey = useCallback(async (tripId: string): Promise<CryptoKey> => {
    if (tripKeysRef.current[tripId]) return tripKeysRef.current[tripId];
    const { key } = await getOrCreateTripKey(tripId);
    tripKeysRef.current[tripId] = key;
    return key;
  }, []);

  // Automatic collaboratorUids backfill on shared E2EE trips (owner updates existing stops/geofences/alerts/messages)
  const backfillCollaboratorUids = useCallback(
    async (trip: Trip) => {
      if (!user || trip.ownerId !== user.uid || trip.collaboratorUids.length <= 1) return;
      const sig = [...trip.collaboratorUids].sort().join(',');
      if (backfilledCollabSigRef.current[trip.id] === sig) return;
      backfilledCollabSigRef.current[trip.id] = sig;

      const subcollections = ['stops', 'geofences', 'alerts', 'messages'] as const;
      try {
        for (const sub of subcollections) {
          const q = query(
            collection(db, 'trips', trip.id, sub),
            where('ownerId', '==', user.uid)
          );
          const snap = await getDocs(q);
          const toUpdate = snap.docs.filter((d) => {
            const existing = Array.isArray(d.data().collaboratorUids)
              ? (d.data().collaboratorUids as string[])
              : [];
            return trip.collaboratorUids.some((uid) => !existing.includes(uid));
          });

          if (toUpdate.length === 0) continue;
          // Chunk into Firestore batch limits (<= 400 per commit)
          for (let i = 0; i < toUpdate.length; i += 400) {
            const batch = writeBatch(db);
            for (const docSnap of toUpdate.slice(i, i + 400)) {
              batch.update(docSnap.ref, {
                collaboratorUids: trip.collaboratorUids,
                updatedAt: serverTimestamp(),
              });
            }
            await batch.commit();
          }
        }
      } catch {
        // Retry on next snapshot if offline or transient error
        delete backfilledCollabSigRef.current[trip.id];
      }
    },
    [user]
  );

  // Real-time Firestore listener for user's trips (owned + collaborative)
  useEffect(() => {
    if (!authReady || !user) return;

    const tripsQuery = query(
      collection(db, 'trips'),
      where('collaboratorUids', 'array-contains', user.uid)
    );

    const unsub = onSnapshot(
      tripsQuery,
      async (snap) => {
        if (snap.empty) return;
        const decryptedTrips: Trip[] = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          try {
            const key = await ensureTripKey(d.id);
            const payload = await decryptJson<{
              title: string;
              destination: string;
              startDate: string;
              endDate: string;
              center: LatLng;
              travelMode: TravelMode;
              notes: string;
            }>(key, d.encryptedPayload, d.iv);

            const tripObj: Trip = {
              id: d.id,
              ownerId: d.ownerId,
              collaboratorUids: d.collaboratorUids || [d.ownerId],
              title: payload.title,
              destination: payload.destination,
              startDate: payload.startDate,
              endDate: payload.endDate,
              center: payload.center,
              travelMode: payload.travelMode || 'WALKING',
              notes: payload.notes || '',
              status: d.status || 'active',
              keyFingerprint: d.keyFingerprint,
              encryptionAlgo: d.encryptionAlgo || 'AES-GCM-256',
              updatedAt: d.updatedAt?.toMillis?.() || Date.now(),
            };
            decryptedTrips.push(tripObj);
            if (tripObj.ownerId === user.uid && tripObj.collaboratorUids.length > 1) {
              void backfillCollaboratorUids(tripObj);
            }
          } catch {
            decryptedTrips.push({
              id: d.id,
              ownerId: d.ownerId,
              collaboratorUids: d.collaboratorUids || [d.ownerId],
              title: 'Encrypted Trip (Key Needed)',
              destination: 'Encrypted',
              startDate: '',
              endDate: '',
              center: { lat: 37.7749, lng: -122.4194 },
              travelMode: 'WALKING',
              notes: 'Import the E2EE invite key to decrypt this shared trip.',
              status: d.status || 'active',
              keyFingerprint: d.keyFingerprint || 'LOCKED',
              encryptionAlgo: 'AES-GCM-256',
              updatedAt: d.updatedAt?.toMillis?.() || Date.now(),
            });
          }
        }

        setTrips(decryptedTrips);
        setActiveTripId((prev) =>
          decryptedTrips.some((t) => t.id === prev) ? prev : decryptedTrips[0]?.id || prev
        );
      },
      (err) => {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.LIST, 'trips');
        }
      }
    );

    return () => unsub();
  }, [authReady, user, ensureTripKey, backfillCollaboratorUids]);

  const activeTripIsMember = Boolean(
    user && activeTrip && activeTrip.collaboratorUids.includes(user.uid)
  );
  const subscribedTripId = activeTrip?.id || '';

  // Real-time subcollection listeners for active cloud trip
  useEffect(() => {
    if (!authReady || !user || !subscribedTripId || !activeTripIsMember) return;

    const tripId = subscribedTripId;
    let cancelled = false;

    const unsubStops = onSnapshot(
      query(collection(db, 'trips', tripId, 'stops'), where('collaboratorUids', 'array-contains', user.uid)),
      async (snap) => {
        if (cancelled) return;
        const key = await ensureTripKey(tripId);
        const list: TripStop[] = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          try {
            const p = await decryptJson<{
              name: string;
              address: string;
              category: string;
              lat?: number;
              lng?: number;
              placeId?: string;
              timeWindow?: string;
              notes?: string;
              rating?: number;
              googleMapsUri?: string;
              enterpriseLinks?: EnterpriseRecordLink[];
            }>(key, d.encryptedPayload, d.iv);
            list.push({
              id: d.id,
              tripId: d.tripId,
              dayIndex: d.dayIndex,
              orderIndex: d.orderIndex,
              priority: d.priority,
              status: d.status,
              lat: typeof p.lat === 'number' ? p.lat : d.lat,
              lng: typeof p.lng === 'number' ? p.lng : d.lng,
              placeId: p.placeId || d.placeId,
              name: p.name,
              address: p.address,
              category: p.category,
              timeWindow: p.timeWindow,
              notes: p.notes,
              rating: p.rating,
              googleMapsUri: p.googleMapsUri,
              enterpriseLinks: p.enterpriseLinks,
              createdBy: d.createdBy,
              updatedAt: d.updatedAt?.toMillis?.() || Date.now(),
            });
          } catch {
            // Skip undecryptable stop
          }
        }
        list.sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
        setStops(list);
      },
      (err) => {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.LIST, `trips/${tripId}/stops`);
        }
      }
    );

    const unsubGeofences = onSnapshot(
      query(collection(db, 'trips', tripId, 'geofences'), where('collaboratorUids', 'array-contains', user.uid)),
      async (snap) => {
        if (cancelled) return;
        const key = await ensureTripKey(tripId);
        const list: TripGeofence[] = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          try {
            const p = await decryptJson<{
              label: string;
              alertMessage: string;
              lat?: number;
              lng?: number;
              radiusMeters?: number;
              linkedStopId?: string;
              enterpriseLinks?: EnterpriseRecordLink[];
            }>(key, d.encryptedPayload, d.iv);
            list.push({
              id: d.id,
              tripId: d.tripId,
              lat: typeof p.lat === 'number' ? p.lat : d.lat,
              lng: typeof p.lng === 'number' ? p.lng : d.lng,
              radiusMeters: typeof p.radiusMeters === 'number' ? p.radiusMeters : d.radiusMeters,
              triggerOn: d.triggerOn,
              active: d.active,
              label: p.label,
              alertMessage: p.alertMessage,
              linkedStopId: p.linkedStopId,
              enterpriseLinks: p.enterpriseLinks,
              createdBy: d.createdBy,
              updatedAt: d.updatedAt?.toMillis?.() || Date.now(),
            });
          } catch {
            // Skip undecryptable geofence
          }
        }
        setGeofences(list);
      },
      (err) => {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.LIST, `trips/${tripId}/geofences`);
        }
      }
    );

    const unsubAlerts = onSnapshot(
      query(collection(db, 'trips', tripId, 'alerts'), where('collaboratorUids', 'array-contains', user.uid)),
      async (snap) => {
        if (cancelled) return;
        const key = await ensureTripKey(tripId);
        const list: TripAlert[] = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          try {
            const p = await decryptJson<{
              title: string;
              body: string;
              sourceUri?: string;
              enterpriseLinks?: EnterpriseRecordLink[];
            }>(key, d.encryptedPayload, d.iv);
            list.push({
              id: d.id,
              tripId: d.tripId,
              severity: d.severity,
              category: d.category,
              scheduleDeltaMinutes: d.scheduleDeltaMinutes,
              title: p.title,
              body: p.body,
              sourceUri: p.sourceUri,
              enterpriseLinks: p.enterpriseLinks,
              createdAt: d.createdAt?.toMillis?.() || Date.now(),
            });
          } catch {
            // Skip
          }
        }
        list.sort((a, b) => b.createdAt - a.createdAt);
        setAlerts(list);
      },
      (err) => {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.LIST, `trips/${tripId}/alerts`);
        }
      }
    );

    const unsubMessages = onSnapshot(
      query(collection(db, 'trips', tripId, 'messages'), where('collaboratorUids', 'array-contains', user.uid)),
      async (snap) => {
        if (cancelled) return;
        const key = await ensureTripKey(tripId);
        const list: ChatMessage[] = [];
        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          try {
            const p = await decryptJson<{
              senderName: string;
              text: string;
              groundingLinks?: ChatMessage['groundingLinks'];
              discoveredPlaces?: ChatMessage['discoveredPlaces'];
              proposals?: ChatMessage['proposals'];
            }>(key, d.encryptedPayload, d.iv);
            list.push({
              id: d.id,
              tripId: d.tripId,
              senderUid: d.senderUid,
              senderName: p.senderName,
              role: d.role,
              text: p.text,
              groundingLinks: p.groundingLinks,
              discoveredPlaces: p.discoveredPlaces,
              proposals: p.proposals,
              createdAt: d.createdAt?.toMillis?.() || Date.now(),
            });
          } catch {
            // Skip
          }
        }
        list.sort((a, b) => a.createdAt - b.createdAt);
        if (list.length > 0) setMessages(list);
      },
      (err) => {
        if (err?.code === 'permission-denied') {
          handleFirestoreError(err, OperationType.LIST, `trips/${tripId}/messages`);
        }
      }
    );

    const unsubMembers = onSnapshot(
      query(collection(db, 'trips', tripId, 'members'), where('uid', '==', user.uid)),
      (snap) => {
        if (cancelled) return;
        const list: CollaboratorMember[] = snap.docs.map((docSnap) => {
          const d = docSnap.data();
          return {
            uid: d.uid,
            tripId: d.tripId,
            role: d.role,
            displayName: d.displayName,
            joinedAt: d.joinedAt?.toMillis?.() || Date.now(),
          };
        });
        setMembers(list);
      }
    );

    return () => {
      cancelled = true;
      unsubStops();
      unsubGeofences();
      unsubAlerts();
      unsubMessages();
      unsubMembers();
    };
  }, [authReady, user, subscribedTripId, activeTripIsMember, ensureTripKey]);

  // Helper to encrypt stop payload with exact coordinates inside E2EE ciphertext
  const buildStopFirestoreDoc = useCallback(
    async (trip: Trip, s: TripStop, actorUid: string) => {
      const key = await ensureTripKey(trip.id);
      const enc = await encryptJson(key, {
        name: s.name,
        address: s.address,
        category: s.category,
        lat: s.lat,
        lng: s.lng,
        placeId: s.placeId,
        timeWindow: s.timeWindow,
        notes: s.notes,
        rating: s.rating,
        googleMapsUri: s.googleMapsUri,
        enterpriseLinks: s.enterpriseLinks,
      });
      return {
        id: s.id,
        tripId: trip.id,
        ownerId: trip.ownerId,
        collaboratorUids: trip.collaboratorUids,
        createdBy: actorUid,
        dayIndex: s.dayIndex,
        orderIndex: s.orderIndex,
        priority: s.priority,
        lat: toCoarsePrivacyCoord(s.lat),
        lng: toCoarsePrivacyCoord(s.lng),
        placeId: 'encrypted',
        status: s.status,
        encryptedPayload: enc.encryptedPayload,
        iv: enc.iv,
      };
    },
    [ensureTripKey]
  );

  const buildGeofenceFirestoreDoc = useCallback(
    async (trip: Trip, gf: TripGeofence, actorUid: string) => {
      const key = await ensureTripKey(trip.id);
      const enc = await encryptJson(key, {
        label: gf.label,
        alertMessage: gf.alertMessage,
        lat: gf.lat,
        lng: gf.lng,
        radiusMeters: gf.radiusMeters,
        linkedStopId: gf.linkedStopId,
        enterpriseLinks: gf.enterpriseLinks,
      });
      return {
        id: gf.id,
        tripId: trip.id,
        ownerId: trip.ownerId,
        collaboratorUids: trip.collaboratorUids,
        createdBy: actorUid,
        lat: toCoarsePrivacyCoord(gf.lat),
        lng: toCoarsePrivacyCoord(gf.lng),
        radiusMeters: gf.radiusMeters,
        triggerOn: gf.triggerOn,
        active: gf.active,
        encryptedPayload: enc.encryptedPayload,
        iv: enc.iv,
      };
    },
    [ensureTripKey]
  );

  // Replay handler for Smart Offline Sync outbox Firestore mutations
  const replayFirestoreMutation = useCallback(
    async (item: SyncOutboxItem): Promise<boolean> => {
      if (!user) return false;
      const p = item.payload as Record<string, any>;
      const op = String(p.op || '');
      const tripId = String(p.tripId || item.tripId || '');
      if (!tripId) return true;

      const tripObj = trips.find((t) => t.id === tripId);
      if (!tripObj || !tripObj.collaboratorUids.includes(user.uid)) {
        return true; // Local-only trip or no longer member
      }

      try {
        if (op === 'set_stop') {
          const stop = p.stop as TripStop;
          const docData = await buildStopFirestoreDoc(tripObj, stop, user.uid);
          await setDoc(doc(db, 'trips', tripId, 'stops', stop.id), {
            ...docData,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'update_stop') {
          const stop = p.stop as TripStop;
          const docData = await buildStopFirestoreDoc(tripObj, stop, user.uid);
          await updateDoc(doc(db, 'trips', tripId, 'stops', stop.id), {
            dayIndex: docData.dayIndex,
            orderIndex: docData.orderIndex,
            priority: docData.priority,
            status: docData.status,
            encryptedPayload: docData.encryptedPayload,
            iv: docData.iv,
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'delete_stop') {
          await deleteDoc(doc(db, 'trips', tripId, 'stops', String(p.stopId)));
          return true;
        }
        if (op === 'set_geofence') {
          const gf = p.geofence as TripGeofence;
          const docData = await buildGeofenceFirestoreDoc(tripObj, gf, user.uid);
          await setDoc(doc(db, 'trips', tripId, 'geofences', gf.id), {
            ...docData,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'update_geofence') {
          const gf = p.geofence as TripGeofence;
          const docData = await buildGeofenceFirestoreDoc(tripObj, gf, user.uid);
          await updateDoc(doc(db, 'trips', tripId, 'geofences', gf.id), {
            active: docData.active,
            radiusMeters: docData.radiusMeters,
            triggerOn: docData.triggerOn,
            encryptedPayload: docData.encryptedPayload,
            iv: docData.iv,
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'delete_geofence') {
          await deleteDoc(doc(db, 'trips', tripId, 'geofences', String(p.geofenceId)));
          return true;
        }
        if (op === 'set_alert') {
          const alert = p.alert as TripAlert;
          const key = await ensureTripKey(tripId);
          const enc = await encryptJson(key, {
            title: alert.title,
            body: alert.body,
            sourceUri: alert.sourceUri,
            enterpriseLinks: alert.enterpriseLinks,
          });
          await setDoc(doc(db, 'trips', tripId, 'alerts', alert.id), {
            id: alert.id,
            tripId,
            ownerId: tripObj.ownerId,
            collaboratorUids: tripObj.collaboratorUids,
            createdBy: user.uid,
            severity: alert.severity,
            category: alert.category,
            scheduleDeltaMinutes: alert.scheduleDeltaMinutes,
            encryptedPayload: enc.encryptedPayload,
            iv: enc.iv,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'update_alert') {
          const alert = p.alert as TripAlert;
          const key = await ensureTripKey(tripId);
          const enc = await encryptJson(key, {
            title: alert.title,
            body: alert.body,
            sourceUri: alert.sourceUri,
            enterpriseLinks: alert.enterpriseLinks,
          });
          await updateDoc(doc(db, 'trips', tripId, 'alerts', alert.id), {
            encryptedPayload: enc.encryptedPayload,
            iv: enc.iv,
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        if (op === 'set_message') {
          const msg = p.message as ChatMessage;
          const key = await ensureTripKey(tripId);
          const enc = await encryptJson(key, {
            senderName: msg.senderName,
            text: msg.text,
            groundingLinks: msg.groundingLinks,
            discoveredPlaces: msg.discoveredPlaces,
            proposals: msg.proposals,
          });
          await setDoc(doc(db, 'trips', tripId, 'messages', msg.id), {
            id: msg.id,
            tripId,
            ownerId: tripObj.ownerId,
            collaboratorUids: tripObj.collaboratorUids,
            senderUid: user.uid,
            role: msg.role,
            encryptedPayload: enc.encryptedPayload,
            iv: enc.iv,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return true;
        }
        return true;
      } catch (err: any) {
        if (err?.code === 'not-found') return true;
        return false;
      }
    },
    [user, trips, buildStopFirestoreDoc, buildGeofenceFirestoreDoc, ensureTripKey]
  );

  const signInWithGoogle = useCallback(async () => {
    triggerHaptic('medium');
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      setSyncNotice(`Signed in as ${cred.user.displayName || cred.user.email}`);
      triggerHaptic('success');
    } catch (err: any) {
      setSyncNotice(err?.message || 'Google sign-in cancelled.');
    }
  }, []);

  const signOutUser = useCallback(async () => {
    triggerHaptic('light');
    await signOut(auth);
    setSyncNotice('Signed out. Local encrypted vault remains active.');
  }, []);

  const updatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      const next = { ...prefsRef.current, ...patch };
      setPrefs(next);
      if (user) {
        try {
          await setDoc(
            doc(db, 'users', user.uid, 'preferences', 'settings'),
            {
              uid: user.uid,
              ...next,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } catch (err: any) {
          if (err?.code === 'permission-denied') {
            handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/preferences/settings`);
          }
        }
      }
    },
    [user]
  );

  const createTrip = useCallback(
    async (input: {
      title: string;
      destination: string;
      startDate: string;
      endDate: string;
      center: LatLng;
      travelMode: TravelMode;
      notes?: string;
    }) => {
      triggerHaptic('success');
      const tripId = makeId('trip');
      const { key, fingerprint } = await getOrCreateTripKey(tripId);
      tripKeysRef.current[tripId] = key;

      const ownerId = user?.uid || 'local_explorer';
      const newTrip: Trip = {
        id: tripId,
        ownerId,
        collaboratorUids: [ownerId],
        title: input.title,
        destination: input.destination,
        startDate: input.startDate,
        endDate: input.endDate,
        center: input.center,
        travelMode: input.travelMode,
        notes: input.notes || '',
        status: 'active',
        keyFingerprint: fingerprint,
        encryptionAlgo: 'AES-GCM-256',
        updatedAt: Date.now(),
      };

      setTrips((prev) => [newTrip, ...prev]);
      setActiveTripId(tripId);
      setStops([]);
      setGeofences([]);
      setAlerts([]);
      setMessages([]);

      if (user) {
        try {
          const { encryptedPayload, iv } = await encryptJson(key, {
            title: newTrip.title,
            destination: newTrip.destination,
            startDate: newTrip.startDate,
            endDate: newTrip.endDate,
            center: newTrip.center,
            travelMode: newTrip.travelMode,
            notes: newTrip.notes,
          });
          const batch = writeBatch(db);
          batch.set(doc(db, 'trips', tripId), {
            id: tripId,
            ownerId: user.uid,
            collaboratorUids: [user.uid],
            encryptedPayload,
            iv,
            keyFingerprint: fingerprint,
            encryptionAlgo: 'AES-GCM-256',
            status: 'active',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          batch.set(doc(db, 'trips', tripId, 'members', user.uid), {
            uid: user.uid,
            tripId,
            role: 'owner',
            displayName: (user.displayName || 'Owner').slice(0, 100),
            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
        } catch (err: any) {
          if (err?.code === 'permission-denied') {
            handleFirestoreError(err, OperationType.CREATE, `trips/${tripId}`);
          }
        }
      }

      return newTrip;
    },
    [user]
  );

  // Sync current local trip to cloud right after user signs in
  const syncLocalTripToCloud = useCallback(async () => {
    if (!user || !activeTrip) return;
    if (activeTrip.ownerId === user.uid) return;
    triggerHaptic('medium');
    const tripId = activeTrip.id;
    const key = await ensureTripKey(tripId);
    const { fingerprint } = await getOrCreateTripKey(tripId);
    const ownerTrip: Trip = {
      ...activeTrip,
      ownerId: user.uid,
      collaboratorUids: [user.uid],
      keyFingerprint: fingerprint,
    };

    try {
      const { encryptedPayload, iv } = await encryptJson(key, {
        title: ownerTrip.title,
        destination: ownerTrip.destination,
        startDate: ownerTrip.startDate,
        endDate: ownerTrip.endDate,
        center: ownerTrip.center,
        travelMode: ownerTrip.travelMode,
        notes: ownerTrip.notes,
      });
      const batch = writeBatch(db);
      batch.set(doc(db, 'trips', tripId), {
        id: tripId,
        ownerId: user.uid,
        collaboratorUids: [user.uid],
        encryptedPayload,
        iv,
        keyFingerprint: fingerprint,
        encryptionAlgo: 'AES-GCM-256',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'trips', tripId, 'members', user.uid), {
        uid: user.uid,
        tripId,
        role: 'owner',
        displayName: (user.displayName || 'Owner').slice(0, 100),
        joinedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      for (const s of stops) {
        const stopDoc = await buildStopFirestoreDoc(ownerTrip, s, user.uid);
        batch.set(doc(db, 'trips', tripId, 'stops', s.id), {
          ...stopDoc,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      for (const gf of geofences) {
        const gfDoc = await buildGeofenceFirestoreDoc(ownerTrip, gf, user.uid);
        batch.set(doc(db, 'trips', tripId, 'geofences', gf.id), {
          ...gfDoc,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      setTrips((prev) => prev.map((t) => (t.id === tripId ? ownerTrip : t)));
      setSyncNotice('Encrypted trip synced to cloud.');
      triggerHaptic('success');
    } catch (err: any) {
      if (err?.code === 'permission-denied') {
        handleFirestoreError(err, OperationType.WRITE, `trips/${tripId}`);
      }
    }
  }, [user, activeTrip, stops, geofences, ensureTripKey, buildStopFirestoreDoc, buildGeofenceFirestoreDoc]);

  const emitAlert = useCallback(
    async (input: {
      severity: AlertSeverity;
      category: AlertCategory;
      scheduleDeltaMinutes: number;
      title: string;
      body: string;
      sourceUri?: string;
    }): Promise<TripAlert | null> => {
      if (!activeTrip) return null;
      const alertId = makeId('alert');
      const alert: TripAlert = {
        id: alertId,
        tripId: activeTrip.id,
        severity: input.severity,
        category: input.category,
        scheduleDeltaMinutes: input.scheduleDeltaMinutes,
        title: input.title,
        body: input.body,
        sourceUri: input.sourceUri,
        createdAt: Date.now(),
      };

      const { delivered, suppressed } = await dispatchSmartNotification(alert, prefsRef.current);
      const storedAlert: TripAlert = { ...alert, suppressed };
      setAlerts((prev) => [storedAlert, ...prev]);

      if (delivered) {
        setBannerAlert({
          id: alert.id,
          title: alert.title,
          body: alert.body,
          severity: alert.severity,
        });
      }

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:alert:${alertId}`,
            tripId: activeTrip.id,
            label: `Sync alert: ${alert.title}`,
            payload: { op: 'set_alert', tripId: activeTrip.id, alert },
          });
        } else {
          try {
            const key = await ensureTripKey(activeTrip.id);
            const enc = await encryptJson(key, {
              title: alert.title,
              body: alert.body,
              sourceUri: alert.sourceUri,
            });
            await setDoc(doc(db, 'trips', activeTrip.id, 'alerts', alertId), {
              id: alertId,
              tripId: activeTrip.id,
              ownerId: activeTrip.ownerId,
              collaboratorUids: activeTrip.collaboratorUids,
              createdBy: user.uid,
              severity: alert.severity,
              category: alert.category,
              scheduleDeltaMinutes: alert.scheduleDeltaMinutes,
              encryptedPayload: enc.encryptedPayload,
              iv: enc.iv,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:alert:${alertId}`,
                tripId: activeTrip.id,
                label: `Sync alert: ${alert.title}`,
                payload: { op: 'set_alert', tripId: activeTrip.id, alert },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.CREATE, `trips/${activeTrip.id}/alerts/${alertId}`);
            }
          }
        }
      }

      return storedAlert;
    },
    [activeTrip, user, ensureTripKey]
  );

  const addStop = useCallback(
    async (input: {
      name: string;
      address: string;
      lat: number;
      lng: number;
      placeId: string;
      category: string;
      priority?: PriorityLevel;
      dayIndex?: number;
      timeWindow?: string;
      notes?: string;
      rating?: number;
      googleMapsUri?: string;
      enterpriseLinks?: EnterpriseRecordLink[];
    }) => {
      if (!activeTrip) return null;
      triggerHaptic('success');
      const stopId = makeId('stop');
      const dayIndex = input.dayIndex ?? 0;
      const dayStops = stops.filter((s) => s.dayIndex === dayIndex);

      const newStop: TripStop = {
        id: stopId,
        tripId: activeTrip.id,
        dayIndex,
        orderIndex: dayStops.length,
        priority: input.priority || 'normal',
        status: 'planned',
        lat: input.lat,
        lng: input.lng,
        placeId: input.placeId || stopId,
        name: input.name,
        address: input.address,
        category: input.category || 'Point of Interest',
        timeWindow: input.timeWindow || '',
        notes: input.notes || '',
        rating: input.rating,
        googleMapsUri: input.googleMapsUri,
        enterpriseLinks: input.enterpriseLinks,
        createdBy: user?.uid || 'local_explorer',
        updatedAt: Date.now(),
      };

      setStops((prev) => [...prev, newStop]);

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:stop:set:${stopId}`,
            tripId: activeTrip.id,
            label: `Sync stop: ${newStop.name}`,
            payload: { op: 'set_stop', tripId: activeTrip.id, stop: newStop },
          });
        } else {
          try {
            const docData = await buildStopFirestoreDoc(activeTrip, newStop, user.uid);
            await setDoc(doc(db, 'trips', activeTrip.id, 'stops', stopId), {
              ...docData,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:stop:set:${stopId}`,
                tripId: activeTrip.id,
                label: `Sync stop: ${newStop.name}`,
                payload: { op: 'set_stop', tripId: activeTrip.id, stop: newStop },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.CREATE, `trips/${activeTrip.id}/stops/${stopId}`);
            }
          }
        }
      }

      if (activeTrip.collaboratorUids.length > 1) {
        void emitAlert({
          severity: 'normal',
          category: 'collab',
          scheduleDeltaMinutes: 20,
          title: 'Itinerary stop added',
          body: `${newStop.name} added to Day ${dayIndex + 1}.`,
        });
      }

      return newStop;
    },
    [activeTrip, stops, user, buildStopFirestoreDoc, emitAlert]
  );

  const updateStop = useCallback(
    async (
      stopId: string,
      patch: Partial<
        Pick<TripStop, 'priority' | 'status' | 'dayIndex' | 'orderIndex' | 'timeWindow' | 'notes'>
      >,
      isMinorEdit = false
    ) => {
      if (!activeTrip) return;
      triggerHaptic('light');
      const existingStop = stops.find((s) => s.id === stopId);
      if (!existingStop) return;
      const updated: TripStop = { ...existingStop, ...patch, updatedAt: Date.now() };
      setStops((prev) => prev.map((s) => (s.id === stopId ? updated : s)));

      if (isMinorEdit) {
        void emitAlert({
          severity: 'minor',
          category: 'schedule',
          scheduleDeltaMinutes: 0,
          title: `Updated ${updated.name}`,
          body: 'Minor stop adjustment (suppressed from push alerts).',
        });
      }

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:stop:upd:${stopId}`,
            tripId: activeTrip.id,
            label: `Update stop: ${updated.name}`,
            payload: { op: 'update_stop', tripId: activeTrip.id, stop: updated },
          });
        } else {
          try {
            const docData = await buildStopFirestoreDoc(activeTrip, updated, user.uid);
            await updateDoc(doc(db, 'trips', activeTrip.id, 'stops', stopId), {
              dayIndex: docData.dayIndex,
              orderIndex: docData.orderIndex,
              priority: docData.priority,
              status: docData.status,
              encryptedPayload: docData.encryptedPayload,
              iv: docData.iv,
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:stop:upd:${stopId}`,
                tripId: activeTrip.id,
                label: `Update stop: ${updated.name}`,
                payload: { op: 'update_stop', tripId: activeTrip.id, stop: updated },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.UPDATE, `trips/${activeTrip.id}/stops/${stopId}`);
            }
          }
        }
      }
    },
    [activeTrip, stops, user, buildStopFirestoreDoc, emitAlert]
  );

  const reorderDayStops = useCallback(
    async (dayIndex: number, orderedStopIds: string[]) => {
      if (!activeTrip || orderedStopIds.length === 0) return;
      triggerHaptic('success');

      const orderMap = new Map<string, number>();
      orderedStopIds.forEach((id, idx) => orderMap.set(id, idx));

      const updatedDayStops: TripStop[] = [];
      setStops((prev) => {
        const next = prev.map((s) => {
          if (s.dayIndex !== dayIndex) return s;
          const newOrder = orderMap.get(s.id);
          if (newOrder === undefined) return s;
          const updated = { ...s, orderIndex: newOrder, updatedAt: Date.now() };
          updatedDayStops.push(updated);
          return updated;
        });
        next.sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
        return next;
      });

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        const dayStopsToSync = stops
          .filter((s) => s.dayIndex === dayIndex && orderMap.has(s.id))
          .map((s) => ({ ...s, orderIndex: orderMap.get(s.id)!, updatedAt: Date.now() }));

        if (!navigator.onLine) {
          for (const st of dayStopsToSync) {
            await enqueueFirestoreMutation({
              idempotencyKey: `fs:stop:upd:${st.id}`,
              tripId: activeTrip.id,
              label: `Reorder stop: ${st.name}`,
              payload: { op: 'update_stop', tripId: activeTrip.id, stop: st },
            });
          }
        } else {
          try {
            const batch = writeBatch(db);
            for (const st of dayStopsToSync) {
              batch.update(doc(db, 'trips', activeTrip.id, 'stops', st.id), {
                orderIndex: st.orderIndex,
                updatedAt: serverTimestamp(),
              });
            }
            await batch.commit();
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              for (const st of dayStopsToSync) {
                await enqueueFirestoreMutation({
                  idempotencyKey: `fs:stop:upd:${st.id}`,
                  tripId: activeTrip.id,
                  label: `Reorder stop: ${st.name}`,
                  payload: { op: 'update_stop', tripId: activeTrip.id, stop: st },
                });
              }
            }
          }
        }
      }
    },
    [activeTrip, stops, user]
  );

  const moveStopToDay = useCallback(
    async (stopId: string, targetDayIndex: number) => {
      if (!activeTrip) return;
      const targetStop = stops.find((s) => s.id === stopId);
      if (!targetStop || targetStop.dayIndex === targetDayIndex) return;
      triggerHaptic('light');

      const now = Date.now();
      const sourceDay = targetStop.dayIndex;
      const destDayStops = stops
        .filter((s) => s.dayIndex === targetDayIndex)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      const sourceRemaining = stops
        .filter((s) => s.dayIndex === sourceDay && s.id !== stopId)
        .sort((a, b) => a.orderIndex - b.orderIndex);

      const movedStop: TripStop = {
        ...targetStop,
        dayIndex: targetDayIndex,
        orderIndex: destDayStops.length,
        updatedAt: now,
      };
      const reindexedSource = sourceRemaining.map((s, idx) => ({
        ...s,
        orderIndex: idx,
        updatedAt: now,
      }));
      const changedMap = new Map<string, TripStop>([[movedStop.id, movedStop]]);
      for (const s of reindexedSource) changedMap.set(s.id, s);

      setStops((prev) => {
        const next = prev.map((s) => changedMap.get(s.id) || s);
        next.sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
        return next;
      });

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        const changedList = Array.from(changedMap.values());
        if (!navigator.onLine) {
          for (const st of changedList) {
            await enqueueFirestoreMutation({
              idempotencyKey: `fs:stop:upd:${st.id}`,
              tripId: activeTrip.id,
              label: `Move stop: ${st.name}`,
              payload: { op: 'update_stop', tripId: activeTrip.id, stop: st },
            });
          }
        } else {
          try {
            const batch = writeBatch(db);
            for (const st of changedList) {
              batch.update(doc(db, 'trips', activeTrip.id, 'stops', st.id), {
                dayIndex: st.dayIndex,
                orderIndex: st.orderIndex,
                updatedAt: serverTimestamp(),
              });
            }
            await batch.commit();
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              for (const st of changedList) {
                await enqueueFirestoreMutation({
                  idempotencyKey: `fs:stop:upd:${st.id}`,
                  tripId: activeTrip.id,
                  label: `Move stop: ${st.name}`,
                  payload: { op: 'update_stop', tripId: activeTrip.id, stop: st },
                });
              }
            }
          }
        }
      }
    },
    [activeTrip, stops, user]
  );

  const applyDisruptionRecovery = useCallback(
    async (plan: DisruptionRecoveryPlan) => {
      if (!activeTrip) return;
      triggerHaptic('success');

      const now = Date.now();
      const dayStops = stops.filter((s) => s.dayIndex === plan.dayIndex);
      const existingById = new Map(dayStops.map((s) => [s.id, s]));
      const keptIds = new Set<string>();
      const nextDayStops: TripStop[] = [];

      for (let i = 0; i < plan.proposedStops.length; i++) {
        const prop = plan.proposedStops[i];
        const existing = existingById.get(prop.id);
        if (existing && !prop.isReplacement) {
          keptIds.add(existing.id);
          nextDayStops.push({
            ...existing,
            orderIndex: i,
            notes: prop.notes ?? existing.notes,
            updatedAt: now,
          });
        } else {
          const newId = makeId('stop');
          nextDayStops.push({
            id: newId,
            tripId: activeTrip.id,
            dayIndex: plan.dayIndex,
            orderIndex: i,
            priority: prop.priority || 'normal',
            status: 'planned',
            lat: prop.lat,
            lng: prop.lng,
            placeId: prop.placeId || newId,
            name: prop.name,
            address: prop.address,
            category: prop.category || 'Recovery Stop',
            timeWindow: '',
            notes: prop.notes || 'Added via GeoInteract Disruption Recovery',
            rating: prop.rating,
            googleMapsUri: prop.googleMapsUri,
            createdBy: user?.uid || 'local_explorer',
            updatedAt: now,
          });
        }
      }

      const removedStops = dayStops.filter((s) => !keptIds.has(s.id));

      setStops((prev) => {
        const otherDays = prev.filter((s) => s.dayIndex !== plan.dayIndex);
        const merged = [...otherDays, ...nextDayStops];
        merged.sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
        return merged;
      });

      if (Array.isArray(plan.legs)) {
        for (const leg of plan.legs) {
          await saveCachedRoute(leg);
        }
        setCachedRoutes((prev) => {
          const newIds = new Set(plan.legs.map((l) => l.id));
          return [...plan.legs, ...prev.filter((r) => !newIds.has(r.id))];
        });
      }

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        const syncOffline = async () => {
          for (const rem of removedStops) {
            await enqueueFirestoreMutation({
              idempotencyKey: `fs:stop:del:${rem.id}`,
              tripId: activeTrip.id,
              label: `Remove impacted stop: ${rem.name}`,
              payload: { op: 'delete_stop', tripId: activeTrip.id, stopId: rem.id },
            });
          }
          for (const st of nextDayStops) {
            const isExisting = keptIds.has(st.id);
            await enqueueFirestoreMutation({
              idempotencyKey: isExisting ? `fs:stop:upd:${st.id}` : `fs:stop:set:${st.id}`,
              tripId: activeTrip.id,
              label: isExisting ? `Reorder stop: ${st.name}` : `Add recovery stop: ${st.name}`,
              payload: {
                op: isExisting ? 'update_stop' : 'set_stop',
                tripId: activeTrip.id,
                stop: st,
              },
            });
          }
        };

        if (!navigator.onLine) {
          await syncOffline();
        } else {
          try {
            const batch = writeBatch(db);
            for (const rem of removedStops) {
              batch.delete(doc(db, 'trips', activeTrip.id, 'stops', rem.id));
            }
            for (const st of nextDayStops) {
              if (keptIds.has(st.id)) {
                const docData = await buildStopFirestoreDoc(activeTrip, st, user.uid);
                batch.update(doc(db, 'trips', activeTrip.id, 'stops', st.id), {
                  orderIndex: docData.orderIndex,
                  encryptedPayload: docData.encryptedPayload,
                  iv: docData.iv,
                  updatedAt: serverTimestamp(),
                });
              } else {
                const docData = await buildStopFirestoreDoc(activeTrip, st, user.uid);
                batch.set(doc(db, 'trips', activeTrip.id, 'stops', st.id), {
                  ...docData,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
              }
            }
            await batch.commit();
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await syncOffline();
            }
          }
        }
      }
    },
    [activeTrip, stops, user, buildStopFirestoreDoc]
  );

  const removeStop = useCallback(
    async (stopId: string) => {
      if (!activeTrip) return;
      triggerHaptic('medium');
      setStops((prev) => prev.filter((s) => s.id !== stopId));
      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:stop:del:${stopId}`,
            tripId: activeTrip.id,
            label: 'Remove itinerary stop',
            payload: { op: 'delete_stop', tripId: activeTrip.id, stopId },
          });
        } else {
          try {
            await deleteDoc(doc(db, 'trips', activeTrip.id, 'stops', stopId));
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:stop:del:${stopId}`,
                tripId: activeTrip.id,
                label: 'Remove itinerary stop',
                payload: { op: 'delete_stop', tripId: activeTrip.id, stopId },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.DELETE, `trips/${activeTrip.id}/stops/${stopId}`);
            }
          }
        }
      }
    },
    [activeTrip, user]
  );

  const addGeofence = useCallback(
    async (input: {
      lat: number;
      lng: number;
      radiusMeters: number;
      triggerOn: GeofenceTrigger;
      label: string;
      alertMessage: string;
      linkedStopId?: string;
    }) => {
      if (!activeTrip) return null;
      triggerHaptic('success');
      const geofenceId = makeId('gf');
      const gf: TripGeofence = {
        id: geofenceId,
        tripId: activeTrip.id,
        lat: input.lat,
        lng: input.lng,
        radiusMeters: input.radiusMeters,
        triggerOn: input.triggerOn,
        active: true,
        label: input.label,
        alertMessage: input.alertMessage,
        linkedStopId: input.linkedStopId,
        createdBy: user?.uid || 'local_explorer',
        updatedAt: Date.now(),
      };
      setGeofences((prev) => [...prev, gf]);

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:gf:set:${geofenceId}`,
            tripId: activeTrip.id,
            label: `Sync geofence: ${gf.label}`,
            payload: { op: 'set_geofence', tripId: activeTrip.id, geofence: gf },
          });
        } else {
          try {
            const docData = await buildGeofenceFirestoreDoc(activeTrip, gf, user.uid);
            await setDoc(doc(db, 'trips', activeTrip.id, 'geofences', geofenceId), {
              ...docData,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:gf:set:${geofenceId}`,
                tripId: activeTrip.id,
                label: `Sync geofence: ${gf.label}`,
                payload: { op: 'set_geofence', tripId: activeTrip.id, geofence: gf },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.CREATE, `trips/${activeTrip.id}/geofences/${geofenceId}`);
            }
          }
        }
      }

      return gf;
    },
    [activeTrip, user, buildGeofenceFirestoreDoc]
  );

  const toggleGeofence = useCallback(
    async (geofenceId: string) => {
      if (!activeTrip) return;
      triggerHaptic('light');
      const existingGf = geofences.find((g) => g.id === geofenceId);
      if (!existingGf) return;
      const updated = { ...existingGf, active: !existingGf.active, updatedAt: Date.now() };
      setGeofences((prev) => prev.map((g) => (g.id === geofenceId ? updated : g)));

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:gf:upd:${geofenceId}`,
            tripId: activeTrip.id,
            label: `Toggle geofence: ${updated.label}`,
            payload: { op: 'update_geofence', tripId: activeTrip.id, geofence: updated },
          });
        } else {
          try {
            await updateDoc(doc(db, 'trips', activeTrip.id, 'geofences', geofenceId), {
              active: updated.active,
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:gf:upd:${geofenceId}`,
                tripId: activeTrip.id,
                label: `Toggle geofence: ${updated.label}`,
                payload: { op: 'update_geofence', tripId: activeTrip.id, geofence: updated },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.UPDATE, `trips/${activeTrip.id}/geofences/${geofenceId}`);
            }
          }
        }
      }
    },
    [activeTrip, geofences, user]
  );

  const removeGeofence = useCallback(
    async (geofenceId: string) => {
      if (!activeTrip) return;
      triggerHaptic('medium');
      setGeofences((prev) => prev.filter((g) => g.id !== geofenceId));
      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:gf:del:${geofenceId}`,
            tripId: activeTrip.id,
            label: 'Remove geofence',
            payload: { op: 'delete_geofence', tripId: activeTrip.id, geofenceId },
          });
        } else {
          try {
            await deleteDoc(doc(db, 'trips', activeTrip.id, 'geofences', geofenceId));
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:gf:del:${geofenceId}`,
                tripId: activeTrip.id,
                label: 'Remove geofence',
                payload: { op: 'delete_geofence', tripId: activeTrip.id, geofenceId },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.DELETE, `trips/${activeTrip.id}/geofences/${geofenceId}`);
            }
          }
        }
      }
    },
    [activeTrip, user]
  );

  // Closed-loop enterprise record linking across stops, geofences, and alerts
  const attachEnterpriseLinks = useCallback(
    async (
      entityType: 'stop' | 'geofence' | 'alert',
      entityId: string,
      newLinks: EnterpriseRecordLink[]
    ) => {
      if (!activeTrip || newLinks.length === 0) return;

      const mergeLinks = (existing: EnterpriseRecordLink[] = []): EnterpriseRecordLink[] => {
        const merged = [...existing];
        for (const nl of newLinks) {
          const idx = merged.findIndex(
            (e) => e.target === nl.target && e.recordId === nl.recordId
          );
          if (idx >= 0) {
            merged[idx] = { ...merged[idx], ...nl };
          } else {
            merged.unshift(nl);
          }
        }
        return merged.slice(0, 12);
      };

      if (entityType === 'stop') {
        const current = stops.find((s) => s.id === entityId);
        if (!current) return;
        const updated: TripStop = {
          ...current,
          enterpriseLinks: mergeLinks(current.enterpriseLinks),
          updatedAt: Date.now(),
        };
        setStops((prev) => prev.map((s) => (s.id === entityId ? updated : s)));

        if (user && activeTrip.collaboratorUids.includes(user.uid)) {
          try {
            const docData = await buildStopFirestoreDoc(activeTrip, updated, user.uid);
            await updateDoc(doc(db, 'trips', activeTrip.id, 'stops', entityId), {
              encryptedPayload: docData.encryptedPayload,
              iv: docData.iv,
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:stop:upd:${entityId}`,
                tripId: activeTrip.id,
                label: `Link enterprise record on ${updated.name}`,
                payload: { op: 'update_stop', tripId: activeTrip.id, stop: updated },
              });
            }
          }
        }
      } else if (entityType === 'geofence') {
        const current = geofences.find((g) => g.id === entityId);
        if (!current) return;
        const updated: TripGeofence = {
          ...current,
          enterpriseLinks: mergeLinks(current.enterpriseLinks),
          updatedAt: Date.now(),
        };
        setGeofences((prev) => prev.map((g) => (g.id === entityId ? updated : g)));

        if (user && activeTrip.collaboratorUids.includes(user.uid)) {
          try {
            const docData = await buildGeofenceFirestoreDoc(activeTrip, updated, user.uid);
            await updateDoc(doc(db, 'trips', activeTrip.id, 'geofences', entityId), {
              encryptedPayload: docData.encryptedPayload,
              iv: docData.iv,
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:gf:upd:${entityId}`,
                tripId: activeTrip.id,
                label: `Link enterprise record on ${updated.label}`,
                payload: { op: 'update_geofence', tripId: activeTrip.id, geofence: updated },
              });
            }
          }
        }
      } else if (entityType === 'alert') {
        const current = alerts.find((a) => a.id === entityId);
        if (!current) return;
        const updated: TripAlert = {
          ...current,
          enterpriseLinks: mergeLinks(current.enterpriseLinks),
        };
        setAlerts((prev) => prev.map((a) => (a.id === entityId ? updated : a)));

        if (user && activeTrip.collaboratorUids.includes(user.uid)) {
          try {
            const key = await ensureTripKey(activeTrip.id);
            const enc = await encryptJson(key, {
              title: updated.title,
              body: updated.body,
              sourceUri: updated.sourceUri,
              enterpriseLinks: updated.enterpriseLinks,
            });
            await updateDoc(doc(db, 'trips', activeTrip.id, 'alerts', entityId), {
              encryptedPayload: enc.encryptedPayload,
              iv: enc.iv,
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:alert:upd:${entityId}`,
                tripId: activeTrip.id,
                label: `Link enterprise record on alert`,
                payload: { op: 'update_alert', tripId: activeTrip.id, alert: updated },
              });
            }
          }
        }
      }
    },
    [activeTrip, stops, geofences, alerts, user, buildStopFirestoreDoc, buildGeofenceFirestoreDoc, ensureTripKey]
  );

  const appendChatMessage = useCallback(
    async (msg: Omit<ChatMessage, 'id' | 'tripId' | 'createdAt'>) => {
      if (!activeTrip) return null;
      const messageId = makeId('msg');
      const full: ChatMessage = {
        ...msg,
        id: messageId,
        tripId: activeTrip.id,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, full]);

      if (user && activeTrip.collaboratorUids.includes(user.uid)) {
        if (!navigator.onLine) {
          await enqueueFirestoreMutation({
            idempotencyKey: `fs:msg:set:${messageId}`,
            tripId: activeTrip.id,
            label: 'Sync chat message',
            payload: { op: 'set_message', tripId: activeTrip.id, message: full },
          });
        } else {
          try {
            const key = await ensureTripKey(activeTrip.id);
            const enc = await encryptJson(key, {
              senderName: full.senderName,
              text: full.text,
              groundingLinks: full.groundingLinks,
              discoveredPlaces: full.discoveredPlaces,
              proposals: full.proposals,
            });
            await setDoc(doc(db, 'trips', activeTrip.id, 'messages', messageId), {
              id: messageId,
              tripId: activeTrip.id,
              ownerId: activeTrip.ownerId,
              collaboratorUids: activeTrip.collaboratorUids,
              senderUid: user.uid,
              role: full.role,
              encryptedPayload: enc.encryptedPayload,
              iv: enc.iv,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err: any) {
            if (isNetworkOrOfflineError(err)) {
              await enqueueFirestoreMutation({
                idempotencyKey: `fs:msg:set:${messageId}`,
                tripId: activeTrip.id,
                label: 'Sync chat message',
                payload: { op: 'set_message', tripId: activeTrip.id, message: full },
              });
            } else if (err?.code === 'permission-denied') {
              handleFirestoreError(err, OperationType.CREATE, `trips/${activeTrip.id}/messages/${messageId}`);
            }
          }
        }
      }
      return full;
    },
    [activeTrip, user, ensureTripKey]
  );

  const markProposalApplied = useCallback((messageId: string, proposalId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId || !m.proposals) return m;
        return {
          ...m,
          proposals: m.proposals.map((p) => (p.id === proposalId ? { ...p, applied: true } : p)),
        };
      })
    );
  }, []);

  const createEncryptedShareLink = useCallback(
    async (role: 'editor' | 'viewer' = 'editor'): Promise<string> => {
      if (!activeTrip) throw new Error('No active trip');
      if (!user) throw new Error('Sign in with Google to generate a real-time collaborative link.');
      if (activeTrip.ownerId !== user.uid) {
        await syncLocalTripToCloud();
      }

      const inviteCode = makeId('inv');
      await setDoc(doc(db, 'trips', activeTrip.id, 'invites', inviteCode), {
        inviteCode,
        tripId: activeTrip.id,
        createdBy: user.uid,
        role,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const { rawBase64 } = await getOrCreateTripKey(activeTrip.id);
      const base = `${window.location.origin}${window.location.pathname}`;
      return `${base}?joinTrip=${encodeURIComponent(activeTrip.id)}&code=${encodeURIComponent(inviteCode)}#key=${encodeURIComponent(rawBase64)}`;
    },
    [activeTrip, user, syncLocalTripToCloud]
  );

  const acceptPendingJoin = useCallback(async () => {
    if (!pendingJoin || !user) return;
    triggerHaptic('medium');
    try {
      const { tripId, code, keyRaw } = pendingJoin;
      const { key } = await importTripKey(keyRaw);
      await saveTripKeyLocally(tripId, keyRaw);
      tripKeysRef.current[tripId] = key;

      const inviteSnap = await getDoc(doc(db, 'trips', tripId, 'invites', code));
      if (!inviteSnap.exists() || inviteSnap.data()?.active !== true) {
        setSyncNotice('This invite link is expired or inactive.');
        setPendingJoin(null);
        return;
      }
      const role = inviteSnap.data().role || 'editor';

      const batch = writeBatch(db);
      batch.set(doc(db, 'trips', tripId, 'members', user.uid), {
        uid: user.uid,
        tripId,
        role,
        displayName: (user.displayName || 'Collaborator').slice(0, 100),
        inviteCode: code,
        joinedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'trips', tripId), {
        collaboratorUids: arrayUnion(user.uid),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      setActiveTripId(tripId);
      setPendingJoin(null);
      window.history.replaceState({}, document.title, window.location.pathname);
      setSyncNotice('Joined shared E2EE trip! Owner history syncs automatically.');
      triggerHaptic('success');
    } catch (err: any) {
      setSyncNotice(err?.message || 'Unable to join shared trip.');
    }
  }, [pendingJoin, user]);

  const cacheRouteOffline = useCallback(async (route: CachedRoute) => {
    await saveCachedRoute(route);
    setCachedRoutes((prev) => {
      const filtered = prev.filter((r) => r.id !== route.id);
      return [route, ...filtered];
    });
  }, []);

  const loadInteractiveDemoTrip = useCallback(async () => {
    triggerHaptic('success');
    const demoId = 'trip_demo_waterfront_loop';
    const { key, fingerprint } = await getOrCreateTripKey(demoId);
    tripKeysRef.current[demoId] = key;

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const now = Date.now();

    const demoTrip: Trip = {
      id: demoId,
      ownerId: 'local_explorer',
      collaboratorUids: ['local_explorer'],
      title: 'Safe Demo · Waterfront Loop',
      destination: 'San Francisco Embarcadero (Demo)',
      startDate: today,
      endDate: tomorrow,
      center: { lat: 37.7955, lng: -122.3937 },
      travelMode: 'WALKING',
      notes: 'Local-only encrypted demo itinerary. Real GPS stays off; test simulated geofences, map view, offline mode, and E2EE key backup safely.',
      status: 'active',
      keyFingerprint: fingerprint,
      encryptionAlgo: 'AES-GCM-256',
      updatedAt: now,
    };

    const s1Id = 'demo_stop_ferry_building';
    const s2Id = 'demo_stop_exploratorium';
    const s3Id = 'demo_stop_coit_tower';
    const s4Id = 'demo_stop_north_beach';

    const demoStops: TripStop[] = [
      {
        id: s1Id,
        tripId: demoId,
        dayIndex: 0,
        orderIndex: 0,
        priority: 'high',
        lat: 37.7955,
        lng: -122.3937,
        placeId: 'demo_place_ferry',
        status: 'active',
        name: 'Ferry Building Marketplace',
        address: '1 Ferry Building, San Francisco, CA',
        category: 'Landmark & Coffee',
        timeWindow: '09:00 – 10:15',
        notes: 'Start here. Linked geofence triggers arrival check-in & Auto-Pilot completion on exit.',
        rating: 4.7,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
      {
        id: s2Id,
        tripId: demoId,
        dayIndex: 0,
        orderIndex: 1,
        priority: 'normal',
        lat: 37.8017,
        lng: -122.3973,
        placeId: 'demo_place_exploratorium',
        status: 'planned',
        name: 'Pier 15 Bayfront Overlook',
        address: 'Pier 15 Embarcadero, San Francisco, CA',
        category: 'Scenic Walk',
        timeWindow: '10:30 – 12:00',
        notes: 'Flat waterfront promenade with Bay Bridge views.',
        rating: 4.8,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
      {
        id: s3Id,
        tripId: demoId,
        dayIndex: 0,
        orderIndex: 2,
        priority: 'normal',
        lat: 37.8024,
        lng: -122.4058,
        placeId: 'demo_place_coit',
        status: 'planned',
        name: 'Telegraph Hill & Coit Tower',
        address: '1 Telegraph Hill Blvd, San Francisco, CA',
        category: 'Viewpoint',
        timeWindow: '12:30 – 13:45',
        notes: 'Panoramic lookout stop; tap Plan Recovery in Alerts to preview indoor alternatives.',
        rating: 4.6,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
      {
        id: s4Id,
        tripId: demoId,
        dayIndex: 0,
        orderIndex: 3,
        priority: 'normal',
        lat: 37.8005,
        lng: -122.4091,
        placeId: 'demo_place_north_beach',
        status: 'planned',
        name: 'Washington Square Cafe Quarter',
        address: 'Filbert St & Stockton St, San Francisco, CA',
        category: 'Local Dining',
        timeWindow: '14:00 – 15:30',
        notes: 'Wrap-up lunch stop with shaded park seating.',
        rating: 4.7,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
    ];

    const demoGeofences: TripGeofence[] = [
      {
        id: 'demo_gf_ferry',
        tripId: demoId,
        lat: 37.7955,
        lng: -122.3937,
        radiusMeters: 300,
        triggerOn: 'both',
        active: true,
        label: 'Ferry Building Check-In Zone',
        alertMessage: 'Demo arrival/departure radar for Ferry Building Marketplace',
        linkedStopId: s1Id,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
      {
        id: 'demo_gf_coit',
        tripId: demoId,
        lat: 37.8024,
        lng: -122.4058,
        radiusMeters: 280,
        triggerOn: 'both',
        active: true,
        label: 'Telegraph Hill Lookout Zone',
        alertMessage: 'Demo perimeter alert near Coit Tower',
        linkedStopId: s3Id,
        createdBy: 'local_explorer',
        updatedAt: now,
      },
    ];

    const demoAlerts: TripAlert[] = [
      {
        id: 'demo_alert_wind',
        tripId: demoId,
        severity: 'schedule_impact',
        category: 'weather',
        scheduleDeltaMinutes: 20,
        title: 'Demo Advisory · Gusty Bayfront Winds',
        body: 'Sample high-impact alert: Coastal gusts near Telegraph Hill may delay outdoor sightseeing by ~20 min. Tap "Plan Recovery" to preview indoor alternatives.',
        createdAt: now,
      },
    ];

    const demoMessages: ChatMessage[] = [
      {
        id: 'demo_msg_welcome',
        tripId: demoId,
        senderUid: 'assistant',
        senderName: 'GeoInteract AI',
        role: 'assistant',
        text: 'Safe Interactive Demo loaded locally in your encrypted IndexedDB vault. Real GPS remains OFF—use the Privacy & Demo control to simulate geofence arrival/exit, toggle Offline Mode, or test E2EE key backup.',
        createdAt: now,
      },
    ];

    setTrips((prev) => {
      const others = prev.filter((t) => t.id !== demoId);
      return [demoTrip, ...others];
    });
    setActiveTripId(demoId);
    setStops(demoStops);
    setGeofences(demoGeofences);
    setAlerts(demoAlerts);
    setMessages(demoMessages);
    setSyncNotice('Safe Interactive Demo loaded locally (GPS remains off).');

    return { trip: demoTrip, stops: demoStops, geofences: demoGeofences };
  }, []);

  const dismissBannerAlert = useCallback(() => setBannerAlert(null), []);
  const dismissPendingJoin = useCallback(() => setPendingJoin(null), []);
  const dismissSyncNotice = useCallback(() => setSyncNotice(null), []);

  return {
    user,
    authReady,
    prefs,
    trips,
    activeTrip,
    activeTripId,
    setActiveTripId,
    stops,
    geofences,
    alerts,
    messages,
    members,
    cachedRoutes,
    smartSync,
    bannerAlert,
    dismissBannerAlert,
    pendingJoin,
    dismissPendingJoin,
    acceptPendingJoin,
    syncNotice,
    setSyncNotice,
    dismissSyncNotice,
    signInWithGoogle,
    signOutUser,
    updatePreferences,
    createTrip,
    loadInteractiveDemoTrip,
    syncLocalTripToCloud,
    addStop,
    updateStop,
    reorderDayStops,
    moveStopToDay,
    applyDisruptionRecovery,
    removeStop,
    addGeofence,
    toggleGeofence,
    removeGeofence,
    attachEnterpriseLinks,
    appendChatMessage,
    markProposalApplied,
    emitAlert,
    createEncryptedShareLink,
    cacheRouteOffline,
    replayFirestoreMutation,
  };
}
