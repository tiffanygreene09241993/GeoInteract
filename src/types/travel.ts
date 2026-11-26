export type PriorityLevel = 'low' | 'normal' | 'high';
export type TravelMode = 'WALKING' | 'DRIVING' | 'BICYCLING' | 'TRANSIT';
export type StopStatus = 'planned' | 'active' | 'completed' | 'skipped';
export type AlertSeverity = 'minor' | 'normal' | 'schedule_impact' | 'last_minute_alert';
export type AlertCategory = 'schedule' | 'transit' | 'weather' | 'venue' | 'geofence' | 'collab';
export type GeofenceTrigger = 'enter' | 'exit' | 'both';
export type GroundingMode = 'hybrid' | 'maps';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DiscoveredPlace {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  openNow?: boolean;
  editorialSummary?: string;
  googleMapsUri?: string;
}

export interface GroundingLink {
  title: string;
  uri: string;
  sourceType: 'web' | 'maps';
  reviewSnippets?: string[];
}

export interface EnterpriseRecordLink {
  target: EnterpriseConnectorId;
  recordId: string;
  recordUrl?: string;
  eventType: 'geofence_checkin' | 'travel_alert';
  loggedAt: number;
  status?: 'open' | 'updated' | 'closed';
  dwellDurationSeconds?: number;
}

export interface AgentProposalStop {
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
  category: string;
  priority: PriorityLevel;
  notes?: string;
  rating?: number;
  googleMapsUri?: string;
}

export interface AgentProposal {
  id: string;
  kind: 'add_stops' | 'create_geofence' | 'optimize_day';
  summary: string;
  dayIndex?: number;
  stops?: AgentProposalStop[];
  geofence?: {
    label: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    triggerOn: GeofenceTrigger;
    alertMessage: string;
  };
  applied?: boolean;
}

export interface ChatMessage {
  id: string;
  tripId: string;
  senderUid: string;
  senderName: string;
  role: 'user' | 'assistant';
  text: string;
  groundingLinks?: GroundingLink[];
  discoveredPlaces?: DiscoveredPlace[];
  proposals?: AgentProposal[];
  createdAt: number;
}

export interface TripStop {
  id: string;
  tripId: string;
  dayIndex: number;
  orderIndex: number;
  priority: PriorityLevel;
  status: StopStatus;
  lat: number;
  lng: number;
  placeId: string;
  name: string;
  address: string;
  category: string;
  timeWindow?: string;
  notes?: string;
  rating?: number;
  googleMapsUri?: string;
  enterpriseLinks?: EnterpriseRecordLink[];
  createdBy: string;
  updatedAt: number;
}

export interface TripGeofence {
  id: string;
  tripId: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  triggerOn: GeofenceTrigger;
  active: boolean;
  label: string;
  alertMessage: string;
  linkedStopId?: string;
  enterpriseLinks?: EnterpriseRecordLink[];
  createdBy: string;
  updatedAt: number;
}

export interface TripAlert {
  id: string;
  tripId: string;
  severity: AlertSeverity;
  category: AlertCategory;
  scheduleDeltaMinutes: number;
  title: string;
  body: string;
  sourceUri?: string;
  suppressed?: boolean;
  enterpriseLinks?: EnterpriseRecordLink[];
  createdAt: number;
}

export interface Trip {
  id: string;
  ownerId: string;
  collaboratorUids: string[];
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  center: LatLng;
  travelMode: TravelMode;
  notes: string;
  status: 'active' | 'archived';
  keyFingerprint: string;
  encryptionAlgo: 'AES-GCM-256';
  updatedAt: number;
}

export interface CollaboratorMember {
  uid: string;
  tripId: string;
  role: 'owner' | 'editor' | 'viewer';
  displayName: string;
  joinedAt: number;
}

export interface UserPreferences {
  theme: 'dark' | 'light';
  hapticsEnabled: boolean;
  offlineModePreferred: boolean;
  travelMode: TravelMode;
  avoidTolls: boolean;
  ecoRouting: boolean;
  suppressMinorAlerts: boolean;
  notifyScheduleImpact: boolean;
  notifyLastMinuteAlerts: boolean;
  notifyGeofence: boolean;
  notifyCollab: boolean;
  highlightNormalTasks: boolean;
  interests: string;
}

export interface OfflineRouteStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface CachedRoute {
  id: string;
  tripId: string;
  originName: string;
  destinationName: string;
  origin: LatLng;
  destination: LatLng;
  travelMode: TravelMode;
  distanceMeters: number;
  durationMillis: number;
  path: LatLng[];
  steps: OfflineRouteStep[];
  isOfflineEstimate?: boolean;
  computedAt: number;
}

export interface DayOptimizationResult {
  dayIndex: number;
  orderedStopIds: string[];
  totalDistanceMeters: number;
  totalDurationMillis: number;
  savedDistanceMeters: number;
  legs: CachedRoute[];
  feasibilityNotes: string[];
}

export type EnterpriseConnectorId = 'jira' | 'salesforce' | 'servicenow';

export interface EnterpriseConnectorStatus {
  jira: boolean;
  salesforce: boolean;
  servicenow: boolean;
  authRequired?: boolean;
}

export interface EnterpriseMapPin {
  id: string;
  source: 'jira' | 'salesforce';
  externalKey: string;
  title: string;
  subtitle: string;
  address: string;
  lat: number;
  lng: number;
  status?: string;
  priority?: string;
  externalUrl?: string;
}

export interface EnterprisePreferences {
  showJiraLayer: boolean;
  showSalesforceLayer: boolean;
  autoLogGeofenceCheckins: boolean;
  autoLogHighSeverityAlerts: boolean;
  logTargets: EnterpriseConnectorId[];
  jiraProjectKey: string;
}

export interface EnterpriseLogResult {
  target: EnterpriseConnectorId;
  ok: boolean;
  recordId?: string;
  recordUrl?: string;
  deduplicated?: boolean;
  updatedExisting?: boolean;
  error?: string;
}

export type SyncOutboxKind = 'enterprise_log' | 'firestore_mutation';

export interface SyncOutboxItem {
  id: string;
  kind: SyncOutboxKind;
  idempotencyKey: string;
  tripId?: string;
  label: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
}

export interface SmartSyncStatus {
  pendingCount: number;
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export interface EnterpriseAuditEntry {
  id: string;
  timestamp: string;
  actorUid: string;
  actorEmail?: string;
  eventType: 'geofence_checkin' | 'travel_alert';
  title: string;
  targets: EnterpriseConnectorId[];
  ok: boolean;
  deduplicated?: boolean;
  results: Array<{
    target: EnterpriseConnectorId;
    ok: boolean;
    recordId?: string;
    recordUrl?: string;
    updatedExisting?: boolean;
    error?: string;
  }>;
}

export interface FieldDispatchStopPlan {
  pinId: string;
  source: 'jira' | 'salesforce';
  externalKey: string;
  externalUrl?: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  priority: PriorityLevel;
  category: string;
  notes: string;
  geofenceRadiusMeters: number;
}

export interface FieldDispatchResult {
  dayIndex: number;
  summary: string;
  orderedStops: FieldDispatchStopPlan[];
  totalDistanceMeters: number;
  totalDurationMillis: number;
  savedDistanceMeters: number;
  legs: CachedRoute[];
  feasibilityNotes: string[];
}

export interface RecoveryReplacement {
  replacesStopId?: string;
  replacesStopName?: string;
  reason: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
  category: string;
  rating?: number;
  googleMapsUri?: string;
}

export interface DisruptionRecoveryPlan {
  id: string;
  alertId: string;
  dayIndex: number;
  summary: string;
  affectedStopIds: string[];
  replacements: RecoveryReplacement[];
  proposedStops: Array<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    placeId: string;
    category: string;
    priority: PriorityLevel;
    notes?: string;
    isReplacement?: boolean;
    replacesStopId?: string;
    rating?: number;
    googleMapsUri?: string;
  }>;
  estimatedDelayAvoidedMinutes: number;
  escalationMessage: string;
  legs: CachedRoute[];
}

export interface GeofenceEntryCue {
  id: string;
  geofenceId: string;
  linkedStopId?: string;
  label: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  triggeredAt: number;
}



