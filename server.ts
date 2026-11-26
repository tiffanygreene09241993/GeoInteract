import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetch as undiciFetch,
  ProxyAgent,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';
import { type FunctionDeclaration, GoogleGenAI, Type } from '@google/genai';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser } from './src/db/users.ts';
import { listUserGeofenceEvents, recordGeofenceEvent } from './src/db/geofenceEvents.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

/**
 * Official Google Maps Platform & Google API host suffixes that MUST always
 * connect directly (never through a residential proxy) to comply with Terms of
 * Service and prevent IP-based blocking.
 */
const DIRECT_ONLY_HOST_SUFFIXES = [
  'googleapis.com',
  'maps.google.com',
  'maps.gstatic.com',
];

let cachedProxyUrl: string | undefined;
let cachedProxyAgent: ProxyAgent | null = null;

function getResidentialProxyAgent(): ProxyAgent | null {
  const rawUrl = process.env.RESIDENTIAL_PROXY_URL?.trim();
  if (!rawUrl) {
    cachedProxyUrl = undefined;
    cachedProxyAgent = null;
    return null;
  }

  if (cachedProxyAgent && cachedProxyUrl === rawUrl) {
    return cachedProxyAgent;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(
        `[proxy] Ignoring RESIDENTIAL_PROXY_URL with unsupported protocol "${parsed.protocol}". Expected http: or https:.`
      );
      return null;
    }
    cachedProxyAgent = new ProxyAgent(rawUrl);
    cachedProxyUrl = rawUrl;
    return cachedProxyAgent;
  } catch {
    console.warn('[proxy] RESIDENTIAL_PROXY_URL is not a valid URL; falling back to direct fetch.');
    cachedProxyUrl = undefined;
    cachedProxyAgent = null;
    return null;
  }
}

export function isDirectOnlyUrl(input: UndiciRequestInfo): boolean {
  try {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : typeof (input as { url?: unknown })?.url === 'string'
        ? (input as { url: string }).url
        : '';
    if (!rawUrl) return false;
    const host = new URL(rawUrl).hostname.toLowerCase();
    return DIRECT_ONLY_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

export interface ProxiedFetchOptions extends UndiciRequestInit {
  /** Force a direct connection even when RESIDENTIAL_PROXY_URL is configured. */
  bypassProxy?: boolean;
}

/**
 * Reusable server-side fetch helper that routes outbound requests through the
 * optional RESIDENTIAL_PROXY_URL via undici's ProxyAgent when configured.
 * Official Google Maps Platform API requests are automatically kept direct.
 */
export async function proxiedFetch(
  input: UndiciRequestInfo,
  options: ProxiedFetchOptions = {}
): Promise<UndiciResponse> {
  const { bypassProxy = false, ...init } = options;
  const shouldUseDirect = bypassProxy || isDirectOnlyUrl(input);

  if (!shouldUseDirect) {
    const proxyAgent = getResidentialProxyAgent();
    if (proxyAgent) {
      return undiciFetch(input, {
        ...init,
        dispatcher: proxyAgent,
      });
    }
  }

  return undiciFetch(input, init);
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getMapsApiKey(): string {
  return process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
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

const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName',
  'places.currentOpeningHours.openNow',
  'places.editorialSummary',
  'places.googleMapsUri',
].join(',');

function mapPlaceDto(raw: any): DiscoveredPlace | null {
  const lat = raw?.location?.latitude;
  const lng = raw?.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    placeId: String(raw.id || ''),
    name: String(raw.displayName?.text || 'Unnamed Place'),
    address: String(raw.formattedAddress || ''),
    lat,
    lng,
    rating: typeof raw.rating === 'number' ? raw.rating : undefined,
    userRatingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : undefined,
    primaryType: raw.primaryTypeDisplayName?.text || undefined,
    openNow: typeof raw.currentOpeningHours?.openNow === 'boolean' ? raw.currentOpeningHours.openNow : undefined,
    editorialSummary: raw.editorialSummary?.text || undefined,
    googleMapsUri: raw.googleMapsUri || undefined,
  };
}

async function callPlacesTextSearch(
  textQuery: string,
  lat?: number,
  lng?: number,
  radiusMeters = 5000,
  includedType?: string
): Promise<{ places: DiscoveredPlace[]; quotaExceeded?: boolean; error?: string }> {
  const apiKey = getMapsApiKey();
  if (!apiKey) {
    return { places: [], error: 'Google Maps API key is not configured on the server.' };
  }

  const body: Record<string, unknown> = {
    textQuery,
    maxResultCount: 8,
    languageCode: 'en',
  };
  if (typeof lat === 'number' && typeof lng === 'number') {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: Math.min(Math.max(radiusMeters, 200), 50000),
      },
    };
  }
  if (includedType) {
    body.includedType = includedType;
  }

  // Official Google Maps Platform API call: intentionally kept direct (bypassing any residential proxy)
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    const quotaExceeded = res.status === 429 || errPayload?.error?.status === 'RESOURCE_EXHAUSTED';
    return {
      places: [],
      quotaExceeded,
      error: errPayload?.error?.message || `Places API error (${res.status})`,
    };
  }

  const data = await res.json();
  const places = Array.isArray(data?.places)
    ? data.places.map(mapPlaceDto).filter((p: DiscoveredPlace | null): p is DiscoveredPlace => p !== null)
    : [];
  return { places };
}

async function callPlacesNearbySearch(
  lat: number,
  lng: number,
  radiusMeters = 2500,
  includedTypes: string[] = []
): Promise<{ places: DiscoveredPlace[]; quotaExceeded?: boolean; error?: string }> {
  const apiKey = getMapsApiKey();
  if (!apiKey) {
    return { places: [], error: 'Google Maps API key is not configured on the server.' };
  }

  const body: Record<string, unknown> = {
    maxResultCount: 10,
    languageCode: 'en',
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: Math.min(Math.max(radiusMeters, 200), 50000),
      },
    },
  };
  if (includedTypes.length > 0) {
    body.includedTypes = includedTypes;
  }

  // Official Google Maps Platform API call: intentionally kept direct (bypassing any residential proxy)
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    const quotaExceeded = res.status === 429 || errPayload?.error?.status === 'RESOURCE_EXHAUSTED';
    return {
      places: [],
      quotaExceeded,
      error: errPayload?.error?.message || `Places Nearby API error (${res.status})`,
    };
  }

  const data = await res.json();
  const places = Array.isArray(data?.places)
    ? data.places.map(mapPlaceDto).filter((p: DiscoveredPlace | null): p is DiscoveredPlace => p !== null)
    : [];
  return { places };
}

const searchPlacesTextDecl: FunctionDeclaration = {
  name: 'search_places_text',
  description: 'Search real-time Google Maps Places (New) by text query near optional coordinates to find curated POIs, cafes, landmarks, parks, transit, or restaurants.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Natural language place search query, e.g. "specialty coffee shops in Shibuya" or "scenic viewpoints".',
      },
      lat: {
        type: Type.NUMBER,
        description: 'Optional bias latitude.',
      },
      lng: {
        type: Type.NUMBER,
        description: 'Optional bias longitude.',
      },
      radiusMeters: {
        type: Type.NUMBER,
        description: 'Search bias radius in meters (default 5000).',
      },
    },
    required: ['query'],
  },
};

const searchNearbyPlacesDecl: FunctionDeclaration = {
  name: 'search_nearby_places',
  description: 'Find real-time nearby Google Maps places around a latitude/longitude coordinate, optionally filtered by Google Place types.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      lat: { type: Type.NUMBER, description: 'Center latitude.' },
      lng: { type: Type.NUMBER, description: 'Center longitude.' },
      radiusMeters: { type: Type.NUMBER, description: 'Search radius in meters (200 to 50000).' },
      includedTypes: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional Place types such as restaurant, cafe, museum, park, tourist_attraction, train_station.',
      },
    },
    required: ['lat', 'lng'],
  },
};

const proposeAddStopsDecl: FunctionDeclaration = {
  name: 'propose_add_stops',
  description:
    'Propose adding 1 to 6 verified places (from search_places_text, search_nearby_places, or active enterprise pins) to the user itinerary so the user can apply them in one tap.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: {
        type: Type.STRING,
        description: 'Short action summary, e.g. "Add 3 specialty coffee stops to Day 1".',
      },
      dayIndex: {
        type: Type.NUMBER,
        description: 'Zero-based itinerary day index (0 = Day 1).',
      },
      stops: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            address: { type: Type.STRING },
            lat: { type: Type.NUMBER },
            lng: { type: Type.NUMBER },
            placeId: { type: Type.STRING },
            category: { type: Type.STRING },
            priority: { type: Type.STRING, description: 'low, normal, or high' },
            notes: { type: Type.STRING },
            rating: { type: Type.NUMBER },
            googleMapsUri: { type: Type.STRING },
          },
          required: ['name', 'lat', 'lng'],
        },
      },
    },
    required: ['summary', 'stops'],
  },
};

const proposeCreateGeofenceDecl: FunctionDeclaration = {
  name: 'propose_create_geofence',
  description:
    'Propose creating a geofence alert zone around a verified location or enterprise account/issue site so the user can activate it in one tap.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING, description: 'Short summary of the geofence proposal.' },
      label: { type: Type.STRING, description: 'Zone label.' },
      lat: { type: Type.NUMBER },
      lng: { type: Type.NUMBER },
      radiusMeters: { type: Type.NUMBER, description: 'Zone radius in meters (50 to 2000).' },
      triggerOn: { type: Type.STRING, description: 'enter, exit, or both' },
      alertMessage: { type: Type.STRING, description: 'Notification message when triggered.' },
    },
    required: ['summary', 'label', 'lat', 'lng'],
  },
};

const proposeOptimizeDayDecl: FunctionDeclaration = {
  name: 'propose_optimize_day',
  description:
    'Propose optimizing the waypoint visit order for a specific itinerary day using Google Maps Routes API.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING, description: 'Short summary, e.g. "Optimize Day 1 walking loop".' },
      dayIndex: { type: Type.NUMBER, description: 'Zero-based day index (0 = Day 1).' },
    },
    required: ['summary', 'dayIndex'],
  },
};

// ============================================================================
// Firebase Auth ID Token Verification (Zero-Dependency RS256), RBAC & Rate Limit
// ============================================================================

interface VerifiedAuthUser {
  uid: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
}

interface AuthedRequest extends Request {
  authUser?: VerifiedAuthUser;
}

function loadFirebaseProjectId(): string | null {
  if (process.env.FIREBASE_PROJECT_ID?.trim()) {
    return process.env.FIREBASE_PROJECT_ID.trim();
  }
  try {
    const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (typeof parsed?.projectId === 'string' && parsed.projectId.trim()) {
        return parsed.projectId.trim();
      }
    }
  } catch {
    // Ignore config read issues
  }
  return null;
}

const FIREBASE_PROJECT_ID = loadFirebaseProjectId();

function isEnterpriseAuthRequired(): boolean {
  const raw = process.env.ENTERPRISE_REQUIRE_AUTH?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  return Boolean(FIREBASE_PROJECT_ID);
}

let googleCertsCache: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (googleCertsCache && googleCertsCache.expiresAt > now) {
    return googleCertsCache.certs;
  }
  // Official Google endpoint: direct fetch (never through residential proxy)
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public keys (${res.status})`);
  }
  const certs = (await res.json()) as Record<string, string>;
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 3600 * 1000;
  googleCertsCache = { certs, expiresAt: now + ttlMs };
  return certs;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((segment.length + 3) % 4);
  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedAuthUser | null> {
  if (!FIREBASE_PROJECT_ID) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, any>;
  try {
    header = decodeBase64UrlJson(headerB64);
    payload = decodeBase64UrlJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) return null;
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) return null;

  const certs = await getFirebasePublicCerts();
  const cert = certs[header.kid];
  if (!cert) return null;

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const sigPadded = sigB64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sigB64.length + 3) % 4);
  const sigBuf = Buffer.from(sigPadded, 'base64');
  const valid = verifier.verify(cert, sigBuf);
  if (!valid) return null;

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    emailVerified: Boolean(payload.email_verified),
  };
}

function isUserAllowedByRbac(user: VerifiedAuthUser): boolean {
  const allowedEmails = (process.env.ENTERPRISE_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedDomains = (process.env.ENTERPRISE_ALLOWED_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  const email = (user.email || '').toLowerCase();
  if (!email) return false;
  if (allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  return allowedDomains.includes(domain);
}

async function attachOptionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const verified = await verifyFirebaseIdToken(token);
        if (verified) req.authUser = verified;
      } catch {
        // Ignore invalid optional token
      }
    }
  }
  next();
}

async function requireEnterpriseAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!isEnterpriseAuthRequired()) {
    next();
    return;
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({
      ok: false,
      authRequired: true,
      error: 'Sign in with Google to access Enterprise Connectors.',
    });
    return;
  }
  try {
    const verified = await verifyFirebaseIdToken(token);
    if (!verified) {
      res.status(401).json({
        ok: false,
        authRequired: true,
        error: 'Session token is invalid or expired. Please sign in again.',
      });
      return;
    }
    if (!verified.emailVerified) {
      res.status(403).json({
        ok: false,
        error: 'A verified email address is required to access Enterprise Connectors.',
      });
      return;
    }
    if (!isUserAllowedByRbac(verified)) {
      res.status(403).json({
        ok: false,
        error: 'Your account is not authorized for Enterprise Connectors.',
      });
      return;
    }
    req.authUser = verified;
    next();
  } catch {
    res.status(401).json({
      ok: false,
      authRequired: true,
      error: 'Unable to verify authentication session.',
    });
  }
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.authUser?.uid || req.ip || 'anon';
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 1000) {
        for (const [k, v] of buckets.entries()) {
          if (v.resetAt <= now) buckets.delete(k);
        }
      }
      next();
      return;
    }
    if (existing.count >= maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
      });
      return;
    }
    existing.count += 1;
    next();
  };
}

// ============================================================================
// Google Maps Routes API v2 Helpers (Direct Only — Never Proxied)
// ============================================================================

function decodeEncodedPolyline(encoded: string): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b = 0;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

function parseProtoDurationMs(duration?: string): number {
  if (!duration || typeof duration !== 'string') return 0;
  const seconds = Number(duration.replace(/s$/i, ''));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

function haversineMetersServer(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ============================================================================
// Enterprise Integrations Module (Jira Enterprise, Salesforce, ServiceNow)
// ============================================================================

export type EnterpriseConnectorId = 'jira' | 'salesforce' | 'servicenow';

export interface EnterpriseConnectorStatus {
  jira: boolean;
  salesforce: boolean;
  servicenow: boolean;
  authRequired: boolean;
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

export interface EnterpriseLogPayload {
  targets?: EnterpriseConnectorId[];
  target?: EnterpriseConnectorId;
  eventType: 'geofence_checkin' | 'travel_alert';
  title: string;
  description: string;
  severity?: string;
  geofenceEvent?: 'enter' | 'exit';
  dwellDurationSeconds?: number;
  idempotencyKey?: string;
  location?: { lat: number; lng: number; label?: string };
  tripTitle?: string;
  destination?: string;
  jiraProjectKey?: string;
  jiraIssueKey?: string;
  salesforceAccountId?: string;
  salesforceRecordId?: string;
  salesforceObjectName?: 'Task' | 'Case';
  servicenowSysId?: string;
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

interface EnterpriseAuditEntry {
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

const enterpriseAuditLog: EnterpriseAuditEntry[] = [];
const enterpriseIdempotencyCache = new Map<
  string,
  { expiresAt: number; results: EnterpriseLogResult[] }
>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

function recordEnterpriseAudit(entry: EnterpriseAuditEntry) {
  enterpriseAuditLog.unshift(entry);
  if (enterpriseAuditLog.length > 100) {
    enterpriseAuditLog.length = 100;
  }
}

function normalizeBaseUrl(raw?: string): string {
  return (raw || '').trim().replace(/\/+$/, '');
}

function getJiraConfig(): { baseUrl: string; email: string; apiToken: string; projectKey?: string } | null {
  const baseUrl = normalizeBaseUrl(process.env.JIRA_BASE_URL);
  const email = (process.env.JIRA_EMAIL || '').trim();
  const apiToken = (process.env.JIRA_API_TOKEN || '').trim();
  if (!baseUrl || !email || !apiToken) return null;
  const projectKey = (process.env.JIRA_PROJECT_KEY || '').trim() || undefined;
  return { baseUrl, email, apiToken, projectKey };
}

function getSalesforceConfig(): { instanceUrl: string; accessToken: string } | null {
  const instanceUrl = normalizeBaseUrl(process.env.SF_INSTANCE_URL);
  const accessToken = (process.env.SF_ACCESS_TOKEN || '').trim();
  if (!instanceUrl || !accessToken) return null;
  return { instanceUrl, accessToken };
}

function getServiceNowConfig(): { instanceUrl: string; apiToken: string } | null {
  const instanceUrl = normalizeBaseUrl(process.env.SERVICENOW_INSTANCE_URL);
  const apiToken = (process.env.SERVICENOW_API_TOKEN || '').trim();
  if (!instanceUrl || !apiToken) return null;
  return { instanceUrl, apiToken };
}

export function getEnterpriseConnectorStatus(): EnterpriseConnectorStatus {
  return {
    jira: Boolean(getJiraConfig()),
    salesforce: Boolean(getSalesforceConfig()),
    servicenow: Boolean(getServiceNowConfig()),
    authRequired: isEnterpriseAuthRequired(),
  };
}

function getServiceNowAuthHeaders(token: string): { headers: Record<string, string>; canFallbackToBearer: boolean } {
  if (/^(Bearer|Basic)\s+/i.test(token)) {
    return { headers: { Authorization: token }, canFallbackToBearer: false };
  }
  if (/^(x-sn-apikey|apikey)\s*[:=]\s*/i.test(token)) {
    const rawKey = token.replace(/^(x-sn-apikey|apikey)\s*[:=]\s*/i, '').trim();
    return { headers: { 'x-sn-apikey': rawKey }, canFallbackToBearer: false };
  }
  if (token.includes(':')) {
    return {
      headers: { Authorization: `Basic ${Buffer.from(token).toString('base64')}` },
      canFallbackToBearer: false,
    };
  }
  // Raw ServiceNow REST API Keys use the x-sn-apikey header by default; fall back to Bearer on 401 for raw OAuth tokens.
  return { headers: { 'x-sn-apikey': token }, canFallbackToBearer: true };
}

function extractAdfText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractAdfText).filter(Boolean).join(' ');
  if (typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text;
    if (Array.isArray(rec.content)) {
      return rec.content.map(extractAdfText).filter(Boolean).join('\n');
    }
  }
  return '';
}

function extractCoordsFromText(text: string): { lat: number; lng: number } | null {
  if (!text) return null;
  const labeled = text.match(/lat(?:itude)?\s*[:=]\s*(-?\d{1,2}\.\d+)\s*[,;\s]+l(?:on|ng|ongitude)\s*[:=]\s*(-?\d{1,3}\.\d+)/i);
  if (labeled) {
    const lat = Number(labeled[1]);
    const lng = Number(labeled[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }
  const geoTag = text.match(/geo:(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/i);
  if (geoTag) {
    const lat = Number(geoTag[1]);
    const lng = Number(geoTag[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }
  return null;
}

function extractLocationHint(summary: string, description: string, labels: string[]): string | null {
  const explicitLine = description.match(/(?:location|address|site|venue|city)\s*:\s*([^\n\r]{3,140})/i);
  if (explicitLine?.[1]) return explicitLine[1].trim();
  const locLabel = labels.find((l) => /^loc:/i.test(l));
  if (locLabel) return locLabel.replace(/^loc:/i, '').replace(/[_-]+/g, ' ').trim();
  const atMatch = summary.match(/(?:\bat\b|\bin\b|\bnear\b)\s+([A-Z][^,.;\n]{2,60})/);
  if (atMatch?.[1]) return atMatch[1].trim();
  return null;
}

interface GeocodeCacheEntry {
  value: { lat: number; lng: number; address: string } | null;
  cachedAt: number;
}

const GEOCODE_CACHE_FILE = path.resolve(__dirname, '.waypost_geocode_cache.json');
// Max 30 calendar days per Google Maps Service Specific Terms
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const geocodeCache = new Map<string, GeocodeCacheEntry>();
const inFlightGeocodes = new Map<
  string,
  Promise<{ lat: number; lng: number; address: string } | null>
>();
let geocodePersistTimer: NodeJS.Timeout | null = null;

function loadDiskGeocodeCache() {
  try {
    if (!fs.existsSync(GEOCODE_CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, 'utf8')) as Record<
      string,
      GeocodeCacheEntry
    >;
    const now = Date.now();
    for (const [k, entry] of Object.entries(raw)) {
      if (entry && typeof entry.cachedAt === 'number' && now - entry.cachedAt < GEOCODE_CACHE_TTL_MS) {
        geocodeCache.set(k, entry);
      }
    }
  } catch {
    // Ignore corrupt cache file
  }
}

function schedulePersistGeocodeCache() {
  if (geocodePersistTimer) return;
  geocodePersistTimer = setTimeout(() => {
    geocodePersistTimer = null;
    try {
      const now = Date.now();
      const obj: Record<string, GeocodeCacheEntry> = {};
      for (const [k, v] of geocodeCache.entries()) {
        if (now - v.cachedAt < GEOCODE_CACHE_TTL_MS) {
          obj[k] = v;
        }
      }
      fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(obj), 'utf8');
    } catch {
      // Ignore write failures in read-only containers
    }
  }, 1500);
}

loadDiskGeocodeCache();

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

function isWithinViewport(lat: number, lng: number, bounds?: ViewportBounds): boolean {
  if (!bounds) return true;
  const latOk = lat <= bounds.north && lat >= bounds.south;
  const lngOk =
    bounds.west <= bounds.east
      ? lng >= bounds.west && lng <= bounds.east
      : lng >= bounds.west || lng <= bounds.east;
  return latOk && lngOk;
}

function parseViewportBounds(query: Request['query']): ViewportBounds | undefined {
  const north = Number(query.north);
  const south = Number(query.south);
  const east = Number(query.east);
  const west = Number(query.west);
  if (
    Number.isFinite(north) &&
    Number.isFinite(south) &&
    Number.isFinite(east) &&
    Number.isFinite(west)
  ) {
    return { north, south, east, west };
  }
  return undefined;
}

async function geocodeAddressServerSide(
  queryText: string,
  biasLat?: number,
  biasLng?: number
): Promise<{ lat: number; lng: number; address: string } | null> {
  const normalized = queryText.trim();
  if (!normalized) return null;

  const directCoords = extractCoordsFromText(normalized);
  if (directCoords) {
    return { ...directCoords, address: normalized };
  }

  const cacheKey = normalized.toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < GEOCODE_CACHE_TTL_MS) {
    return cached.value;
  }

  const existingFlight = inFlightGeocodes.get(cacheKey);
  if (existingFlight) {
    return existingFlight;
  }

  const flight = (async () => {
    // Uses direct Google Maps Places API (New) text search (never routed through residential proxy)
    const result = await callPlacesTextSearch(normalized, biasLat, biasLng, 50000);
    const first = result.places[0];
    const resolved = first
      ? { lat: first.lat, lng: first.lng, address: first.address || normalized }
      : null;

    if (geocodeCache.size > 600) {
      const oldestKey = geocodeCache.keys().next().value;
      if (oldestKey) geocodeCache.delete(oldestKey);
    }
    geocodeCache.set(cacheKey, { value: resolved, cachedAt: Date.now() });
    schedulePersistGeocodeCache();
    return resolved;
  })();

  inFlightGeocodes.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    inFlightGeocodes.delete(cacheKey);
  }
}

async function fetchGeocodedJiraIssues(
  biasLat?: number,
  biasLng?: number,
  customJql?: string,
  maxResults = 15,
  bounds?: ViewportBounds
): Promise<{ configured: boolean; issues: EnterpriseMapPin[]; error?: string }> {
  const cfg = getJiraConfig();
  if (!cfg) {
    return {
      configured: false,
      issues: [],
      error: 'Jira Enterprise connector is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN on the server.',
    };
  }

  const jql = (customJql || process.env.JIRA_JQL || 'statusCategory != Done ORDER BY updated DESC').trim();
  const cappedMax = Math.min(Math.max(maxResults, 1), 25);
  const authHeader = `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
  const fields = ['summary', 'description', 'status', 'priority', 'assignee', 'labels', 'project'];

  let res = await proxiedFetch(`${cfg.baseUrl}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jql, maxResults: cappedMax, fields }),
  });

  // Fallback for Jira Data Center / Server instances using /rest/api/3/search
  if (res.status === 404 || res.status === 405) {
    const qs = new URLSearchParams({
      jql,
      maxResults: String(cappedMax),
      fields: fields.join(','),
    });
    res = await proxiedFetch(`${cfg.baseUrl}/rest/api/3/search?${qs.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      configured: true,
      issues: [],
      error: `Jira API returned ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`,
    };
  }

  const data = (await res.json()) as { issues?: any[] };
  const rawIssues = Array.isArray(data?.issues) ? data.issues : [];

  const resolvedPins = await mapWithConcurrency(rawIssues, 5, async (issue): Promise<EnterpriseMapPin | null> => {
    const f = issue?.fields || {};
    const key = String(issue?.key || issue?.id || '');
    const summary = String(f.summary || key || 'Jira Issue');
    const description = extractAdfText(f.description);
    const labels: string[] = Array.isArray(f.labels) ? f.labels.map(String) : [];

    let coords = extractCoordsFromText(`${summary}\n${description}\n${labels.join(' ')}`);
    let address = '';

    if (!coords) {
      const hint = extractLocationHint(summary, description, labels);
      if (hint) {
        const geocoded = await geocodeAddressServerSide(hint, biasLat, biasLng);
        if (geocoded) {
          coords = { lat: geocoded.lat, lng: geocoded.lng };
          address = geocoded.address;
        }
      }
    } else {
      address = `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
    }

    if (!coords) return null;
    if (!isWithinViewport(coords.lat, coords.lng, bounds)) return null;

    return {
      id: `jira_${key}`,
      source: 'jira',
      externalKey: key,
      title: summary,
      subtitle: [f.project?.name, f.assignee?.displayName].filter(Boolean).join(' · ') || 'Jira Enterprise Issue',
      address,
      lat: coords.lat,
      lng: coords.lng,
      status: f.status?.name ? String(f.status.name) : undefined,
      priority: f.priority?.name ? String(f.priority.name) : undefined,
      externalUrl: `${cfg.baseUrl}/browse/${encodeURIComponent(key)}`,
    };
  });

  const pins = resolvedPins.filter((p): p is EnterpriseMapPin => p !== null);
  return { configured: true, issues: pins };
}

async function fetchGeocodedSalesforceAccounts(
  biasLat?: number,
  biasLng?: number,
  limit = 20,
  bounds?: ViewportBounds
): Promise<{ configured: boolean; accounts: EnterpriseMapPin[]; error?: string }> {
  const cfg = getSalesforceConfig();
  if (!cfg) {
    return {
      configured: false,
      accounts: [],
      error: 'Salesforce connector is not configured. Set SF_INSTANCE_URL and SF_ACCESS_TOKEN on the server.',
    };
  }

  const cappedLimit = Math.min(Math.max(limit, 1), 30);
  const soql = `SELECT Id, Name, Type, Industry, Phone, BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry, BillingLatitude, BillingLongitude FROM Account WHERE BillingCity != null OR BillingLatitude != null ORDER BY LastModifiedDate DESC LIMIT ${cappedLimit}`;
  const url = `${cfg.instanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`;

  const res = await proxiedFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      configured: true,
      accounts: [],
      error: `Salesforce API returned ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`,
    };
  }

  const data = (await res.json()) as { records?: any[] };
  const records = Array.isArray(data?.records) ? data.records : [];

  const resolvedPins = await mapWithConcurrency(records, 5, async (rec): Promise<EnterpriseMapPin | null> => {
    const id = String(rec.Id || '');
    const name = String(rec.Name || 'Salesforce Account');
    const formattedBilling = [
      rec.BillingStreet,
      rec.BillingCity,
      rec.BillingState,
      rec.BillingPostalCode,
      rec.BillingCountry,
    ]
      .filter(Boolean)
      .join(', ');

    let lat = typeof rec.BillingLatitude === 'number' ? rec.BillingLatitude : null;
    let lng = typeof rec.BillingLongitude === 'number' ? rec.BillingLongitude : null;
    let address = formattedBilling;

    if ((lat === null || lng === null) && formattedBilling) {
      const geocoded = await geocodeAddressServerSide(formattedBilling, biasLat, biasLng);
      if (geocoded) {
        lat = geocoded.lat;
        lng = geocoded.lng;
        address = geocoded.address || formattedBilling;
      }
    }

    if (lat === null || lng === null) return null;
    if (!isWithinViewport(lat, lng, bounds)) return null;

    return {
      id: `sf_${id}`,
      source: 'salesforce',
      externalKey: id,
      title: name,
      subtitle: [rec.Type, rec.Industry].filter(Boolean).join(' · ') || 'Salesforce Account',
      address: address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      lat,
      lng,
      status: rec.Type ? String(rec.Type) : undefined,
      externalUrl: `${cfg.instanceUrl}/lightning/r/Account/${encodeURIComponent(id)}/view`,
    };
  });

  const pins = resolvedPins.filter((p): p is EnterpriseMapPin => p !== null);
  return { configured: true, accounts: pins };
}

function formatEnterpriseEventBody(payload: EnterpriseLogPayload): string {
  const dwellLabel =
    typeof payload.dwellDurationSeconds === 'number' && payload.dwellDurationSeconds > 0
      ? payload.dwellDurationSeconds >= 60
        ? `${Math.floor(payload.dwellDurationSeconds / 60)}m ${payload.dwellDurationSeconds % 60}s`
        : `${payload.dwellDurationSeconds}s`
      : '';

  const lines = [
    `Event Type: ${payload.eventType === 'geofence_checkin' ? 'Geofence Check-In' : 'High-Severity Travel Alert'}`,
    payload.geofenceEvent ? `Transition: ${payload.geofenceEvent.toUpperCase()}` : '',
    dwellLabel ? `Dwell Duration: ${dwellLabel}` : '',
    payload.severity ? `Severity: ${payload.severity}` : '',
    payload.tripTitle ? `Trip: ${payload.tripTitle}` : '',
    payload.destination ? `Destination: ${payload.destination}` : '',
    payload.location
      ? `Coordinates: lat=${payload.location.lat.toFixed(5)}, lng=${payload.location.lng.toFixed(5)}${
          payload.location.label ? ` (${payload.location.label})` : ''
        }`
      : '',
    payload.idempotencyKey ? `Idempotency Key: ${payload.idempotencyKey}` : '',
    `Timestamp: ${new Date().toISOString()}`,
    '',
    payload.description,
  ];
  return lines.filter((l, idx) => l !== '' || idx === lines.length - 2).join('\n');
}

async function logToJira(payload: EnterpriseLogPayload): Promise<EnterpriseLogResult> {
  const cfg = getJiraConfig();
  if (!cfg) {
    return { target: 'jira', ok: false, error: 'Jira Enterprise is not configured.' };
  }

  const authHeader = `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
  const bodyText = formatEnterpriseEventBody(payload);
  const adfBody = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: bodyText }],
      },
    ],
  };

  // If targeting a specific Jira issue key, append as a comment (closed-loop lifecycle update)
  if (payload.jiraIssueKey) {
    const key = payload.jiraIssueKey.trim().split('#')[0];
    const res = await proxiedFetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: adfBody }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        target: 'jira',
        ok: false,
        error: `Jira comment failed (${res.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`,
      };
    }
    return {
      target: 'jira',
      ok: true,
      recordId: key,
      recordUrl: `${cfg.baseUrl}/browse/${encodeURIComponent(key)}`,
      updatedExisting: true,
    };
  }

  let projectKey = (payload.jiraProjectKey || cfg.projectKey || '').trim();
  if (!projectKey) {
    const projRes = await proxiedFetch(`${cfg.baseUrl}/rest/api/3/project/search?maxResults=1`, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (projRes.ok) {
      const projData = (await projRes.json()) as { values?: Array<{ key?: string }> };
      projectKey = projData?.values?.[0]?.key || '';
    }
  }

  if (!projectKey) {
    return {
      target: 'jira',
      ok: false,
      error: 'No Jira project key found. Set JIRA_PROJECT_KEY or specify a Default Jira Project Key in Preferences.',
    };
  }

  const issueRes = await proxiedFetch(`${cfg.baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary: `[GeoInteract] ${payload.title}`.slice(0, 240),
        issuetype: { name: 'Task' },
        description: adfBody,
        labels: [
          'geointeract',
          payload.eventType,
          ...(payload.location
            ? [`geo:${payload.location.lat.toFixed(4)},${payload.location.lng.toFixed(4)}`]
            : []),
        ],
      },
    }),
  });

  if (!issueRes.ok) {
    const errText = await issueRes.text().catch(() => '');
    return {
      target: 'jira',
      ok: false,
      error: `Jira issue creation failed (${issueRes.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`,
    };
  }

  const created = (await issueRes.json()) as { key?: string; id?: string };
  const recordId = created.key || created.id || 'created';
  return {
    target: 'jira',
    ok: true,
    recordId,
    recordUrl: created.key ? `${cfg.baseUrl}/browse/${encodeURIComponent(created.key)}` : undefined,
  };
}

async function logToSalesforce(payload: EnterpriseLogPayload): Promise<EnterpriseLogResult> {
  const cfg = getSalesforceConfig();
  if (!cfg) {
    return { target: 'salesforce', ok: false, error: 'Salesforce is not configured.' };
  }

  const isAlert = payload.eventType === 'travel_alert';
  const objectName = payload.salesforceObjectName || (isAlert ? 'Case' : 'Task');
  const bodyText = formatEnterpriseEventBody(payload);

  // Closed-loop update for an existing Salesforce record (e.g. geofence exit updating Task with dwell duration)
  if (payload.salesforceRecordId) {
    const recordId = payload.salesforceRecordId.trim();
    const patchBody =
      objectName === 'Task'
        ? { Description: bodyText, Status: 'Completed' }
        : { Description: bodyText };

    const patchRes = await proxiedFetch(
      `${cfg.instanceUrl}/services/data/v61.0/sobjects/${objectName}/${encodeURIComponent(recordId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      }
    );

    if (patchRes.ok) {
      return {
        target: 'salesforce',
        ok: true,
        recordId,
        recordUrl: `${cfg.instanceUrl}/lightning/r/${objectName}/${encodeURIComponent(recordId)}/view`,
        updatedExisting: true,
      };
    }
  }

  const recordBody: Record<string, unknown> = isAlert
    ? {
        Subject: `[GeoInteract] ${payload.title}`.slice(0, 240),
        Description: bodyText,
        Priority: payload.severity === 'last_minute_alert' ? 'High' : 'Medium',
        Origin: 'GeoInteract',
        ...(payload.salesforceAccountId ? { AccountId: payload.salesforceAccountId } : {}),
      }
    : {
        Subject: `[GeoInteract Check-In] ${payload.title}`.slice(0, 240),
        Description: bodyText,
        Status: payload.geofenceEvent === 'enter' ? 'In Progress' : 'Completed',
        Priority: 'Normal',
        ActivityDate: new Date().toISOString().slice(0, 10),
        ...(payload.salesforceAccountId ? { WhatId: payload.salesforceAccountId } : {}),
      };

  const res = await proxiedFetch(`${cfg.instanceUrl}/services/data/v61.0/sobjects/${objectName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(recordBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      target: 'salesforce',
      ok: false,
      error: `Salesforce ${objectName} creation failed (${res.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`,
    };
  }

  const created = (await res.json()) as { id?: string };
  const recordId = created.id || 'created';
  return {
    target: 'salesforce',
    ok: true,
    recordId,
    recordUrl: created.id
      ? `${cfg.instanceUrl}/lightning/r/${objectName}/${encodeURIComponent(created.id)}/view`
      : undefined,
  };
}

async function logToServiceNow(payload: EnterpriseLogPayload): Promise<EnterpriseLogResult> {
  const cfg = getServiceNowConfig();
  if (!cfg) {
    return { target: 'servicenow', ok: false, error: 'ServiceNow is not configured.' };
  }

  const auth = getServiceNowAuthHeaders(cfg.apiToken);
  const bodyText = formatEnterpriseEventBody(payload);

  // Closed-loop update for an existing ServiceNow incident (append work_notes)
  if (payload.servicenowSysId) {
    const sysId = payload.servicenowSysId.trim();
    const patchUrl = `${cfg.instanceUrl}/api/now/table/incident/${encodeURIComponent(sysId)}`;
    const patchBody = JSON.stringify({ work_notes: bodyText });
    let patchRes = await proxiedFetch(patchUrl, {
      method: 'PATCH',
      headers: {
        ...auth.headers,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: patchBody,
    });
    if (patchRes.status === 401 && auth.canFallbackToBearer) {
      patchRes = await proxiedFetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: patchBody,
      });
    }
    if (patchRes.ok) {
      const data = (await patchRes.json().catch(() => ({}))) as {
        result?: { sys_id?: string; number?: string };
      };
      return {
        target: 'servicenow',
        ok: true,
        recordId: data?.result?.number || sysId,
        recordUrl: `${cfg.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${encodeURIComponent(sysId)}`,
        updatedExisting: true,
      };
    }
  }

  const isCritical = payload.severity === 'last_minute_alert';
  const isImpact = payload.severity === 'schedule_impact';
  const urgency = isCritical ? '1' : isImpact ? '2' : '3';
  const impact = isCritical ? '1' : isImpact ? '2' : '3';

  const incidentUrl = `${cfg.instanceUrl}/api/now/table/incident`;
  const requestBody = JSON.stringify({
    short_description: `[GeoInteract] ${payload.title}`.slice(0, 160),
    description: bodyText,
    urgency,
    impact,
    category: 'Travel Operations',
  });

  let res = await proxiedFetch(incidentUrl, {
    method: 'POST',
    headers: {
      ...auth.headers,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  // If raw token was actually a ServiceNow OAuth Bearer token instead of an x-sn-apikey, retry once with Bearer auth
  if (res.status === 401 && auth.canFallbackToBearer) {
    res = await proxiedFetch(incidentUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      target: 'servicenow',
      ok: false,
      error: `ServiceNow incident creation failed (${res.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`,
    };
  }

  const data = (await res.json()) as { result?: { sys_id?: string; number?: string } };
  const sysId = data?.result?.sys_id;
  const recordId = data?.result?.number || sysId || 'created';
  return {
    target: 'servicenow',
    ok: true,
    recordId,
    recordUrl: sysId
      ? `${cfg.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${encodeURIComponent(sysId)}`
      : undefined,
  };
}

async function startServer() {
  const app = express();
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', attachOptionalAuth);

  const placesLimiter = createRateLimiter(45, 60_000);
  const chatLimiter = createRateLimiter(25, 60_000);
  const alertsLimiter = createRateLimiter(20, 60_000);
  const routesLimiter = createRateLimiter(30, 60_000);
  const enterpriseLimiter = createRateLimiter(60, 60_000);

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      residentialProxyConfigured: Boolean(getResidentialProxyAgent()),
      enterpriseConnectors: getEnterpriseConnectorStatus(),
    });
  });

  app.get('/api/maps-config', (_req: Request, res: Response) => {
    res.json({ apiKey: getMapsApiKey() });
  });

  app.post('/api/places/search', placesLimiter, async (req: Request, res: Response) => {
    try {
      const { query, lat, lng, radiusMeters, includedType } = req.body ?? {};
      if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
        res.status(400).json({ error: 'query is required (max 200 characters)' });
        return;
      }
      const validLat = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : undefined;
      const validLng = typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : undefined;
      const safeRadius =
        typeof radiusMeters === 'number' && Number.isFinite(radiusMeters)
          ? Math.min(Math.max(radiusMeters, 200), 50000)
          : 5000;
      const safeType =
        typeof includedType === 'string' && /^[a-z0-9_]{1,64}$/i.test(includedType)
          ? includedType
          : undefined;
      const result = await callPlacesTextSearch(query.trim(), validLat, validLng, safeRadius, safeType);
      if (result.quotaExceeded) {
        res.status(429).json(result);
        return;
      }
      if (result.error && result.places.length === 0) {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Places search failed' });
    }
  });

  app.post('/api/places/nearby', placesLimiter, async (req: Request, res: Response) => {
    try {
      const { lat, lng, radiusMeters, includedTypes } = req.body ?? {};
      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        res.status(400).json({ error: 'Valid lat and lng coordinates are required' });
        return;
      }
      const safeRadius =
        typeof radiusMeters === 'number' && Number.isFinite(radiusMeters)
          ? Math.min(Math.max(radiusMeters, 200), 50000)
          : 2500;
      const safeTypes = Array.isArray(includedTypes)
        ? includedTypes
            .filter((t): t is string => typeof t === 'string' && /^[a-z0-9_]{1,64}$/i.test(t))
            .slice(0, 10)
        : [];
      const result = await callPlacesNearbySearch(lat, lng, safeRadius, safeTypes);
      if (result.quotaExceeded) {
        res.status(429).json(result);
        return;
      }
      if (result.error && result.places.length === 0) {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Nearby search failed' });
    }
  });

  // Full-Day Multi-Waypoint Route Optimization via official Google Maps Routes API v2 (direct only)
  app.post('/api/routes/optimize-day', routesLimiter, async (req: Request, res: Response) => {
    try {
      const apiKey = getMapsApiKey();
      if (!apiKey) {
        res.status(503).json({ error: 'Google Maps API key is not configured on the server.' });
        return;
      }

      const {
        tripId = 'trip',
        dayIndex = 0,
        travelMode = 'WALKING',
        avoidTolls = false,
        stops,
      } = req.body ?? {};

      if (!Array.isArray(stops) || stops.length < 2) {
        res.status(400).json({ error: 'At least 2 stops are required to optimize a day route.' });
        return;
      }

      const cleanStops = stops
        .slice(0, 12)
        .filter(
          (s: any) =>
            s &&
            typeof s.id === 'string' &&
            typeof s.lat === 'number' &&
            typeof s.lng === 'number'
        );

      if (cleanStops.length < 2) {
        res.status(400).json({ error: 'Stops must include valid id, lat, and lng coordinates.' });
        return;
      }

      const modeMap: Record<string, 'WALK' | 'DRIVE' | 'BICYCLE' | 'TRANSIT'> = {
        WALKING: 'WALK',
        DRIVING: 'DRIVE',
        BICYCLING: 'BICYCLE',
        TRANSIT: 'TRANSIT',
      };
      const requestedMode = modeMap[String(travelMode).toUpperCase()] || 'WALK';
      // Google Routes API optimizeWaypointOrder supports DRIVE, BICYCLE, WALK (not TRANSIT)
      const effectiveMode =
        requestedMode === 'TRANSIT' && cleanStops.length > 2 ? 'WALK' : requestedMode;

      // Baseline unoptimized distance estimate
      let baselineDistanceMeters = 0;
      for (let i = 0; i < cleanStops.length - 1; i++) {
        baselineDistanceMeters += Math.round(
          haversineMetersServer(cleanStops[i], cleanStops[i + 1]) * 1.28
        );
      }

      const origin = cleanStops[0];
      const destination = cleanStops[cleanStops.length - 1];
      const intermediates = cleanStops.slice(1, -1);

      const routeBody: Record<string, unknown> = {
        origin: {
          location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
        },
        destination: {
          location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
        },
        travelMode: effectiveMode,
        languageCode: 'en-US',
        units: 'METRIC',
      };

      if (intermediates.length > 0) {
        routeBody.intermediates = intermediates.map((s: any) => ({
          location: { latLng: { latitude: s.lat, longitude: s.lng } },
        }));
        routeBody.optimizeWaypointOrder = true;
      }
      if (effectiveMode === 'DRIVE') {
        routeBody.routingPreference = 'TRAFFIC_AWARE';
        routeBody.routeModifiers = { avoidTolls: Boolean(avoidTolls) };
      }

      const fieldMask = [
        'routes.distanceMeters',
        'routes.duration',
        'routes.optimizedIntermediateWaypointIndex',
        'routes.legs.distanceMeters',
        'routes.legs.duration',
        'routes.legs.polyline.encodedPolyline',
        'routes.legs.steps.navigationInstruction',
        'routes.legs.steps.distanceMeters',
        'routes.legs.steps.staticDuration',
      ].join(',');

      // Official Google Maps Platform API call: intentionally kept direct (never via residential proxy)
      const routesRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(routeBody),
      });

      if (!routesRes.ok) {
        const errPayload = await routesRes.json().catch(() => ({}));
        const quotaExceeded =
          routesRes.status === 429 || errPayload?.error?.status === 'RESOURCE_EXHAUSTED';
        res.status(quotaExceeded ? 429 : 502).json({
          quotaExceeded,
          error: errPayload?.error?.message || `Google Routes API error (${routesRes.status})`,
        });
        return;
      }

      const routesData = (await routesRes.json()) as { routes?: any[] };
      const bestRoute = routesData?.routes?.[0];
      if (!bestRoute) {
        res.status(502).json({ error: 'No feasible route returned for these stops.' });
        return;
      }

      const optIndices: number[] = Array.isArray(bestRoute.optimizedIntermediateWaypointIndex)
        ? bestRoute.optimizedIntermediateWaypointIndex
        : intermediates.map((_: any, i: number) => i);

      const orderedStops = [
        origin,
        ...optIndices.map((idx) => intermediates[idx]).filter(Boolean),
        destination,
      ];

      const rawLegs = Array.isArray(bestRoute.legs) ? bestRoute.legs : [];
      const legs = rawLegs.map((leg: any, idx: number) => {
        const legOrigin = orderedStops[idx] || origin;
        const legDest = orderedStops[idx + 1] || destination;
        const encoded = leg?.polyline?.encodedPolyline || '';
        const decodedPath = encoded
          ? decodeEncodedPolyline(encoded)
          : [
              { lat: legOrigin.lat, lng: legOrigin.lng },
              { lat: legDest.lat, lng: legDest.lng },
            ];
        const steps = Array.isArray(leg?.steps)
          ? leg.steps
              .filter((st: any) => st?.navigationInstruction?.instructions)
              .slice(0, 15)
              .map((st: any) => ({
                instruction: String(st.navigationInstruction.instructions),
                distanceMeters: Number(st.distanceMeters || 0),
                durationSeconds: Math.round(parseProtoDurationMs(st.staticDuration) / 1000),
              }))
          : [];

        return {
          id: `${tripId}_${legOrigin.lat.toFixed(4)}_${legOrigin.lng.toFixed(4)}_${legDest.lat.toFixed(4)}_${legDest.lng.toFixed(4)}_${travelMode}`,
          tripId,
          originName: legOrigin.name || `Stop ${idx + 1}`,
          destinationName: legDest.name || `Stop ${idx + 2}`,
          origin: { lat: legOrigin.lat, lng: legOrigin.lng },
          destination: { lat: legDest.lat, lng: legDest.lng },
          travelMode,
          distanceMeters: Number(leg.distanceMeters || 0),
          durationMillis: parseProtoDurationMs(leg.duration),
          path: decodedPath,
          steps,
          isOfflineEstimate: false,
          computedAt: Date.now(),
        };
      });

      const totalDistanceMeters = Number(
        bestRoute.distanceMeters || legs.reduce((acc: number, l: any) => acc + l.distanceMeters, 0)
      );
      const totalDurationMillis =
        parseProtoDurationMs(bestRoute.duration) ||
        legs.reduce((acc: number, l: any) => acc + l.durationMillis, 0);
      const savedDistanceMeters = Math.max(0, baselineDistanceMeters - totalDistanceMeters);

      const feasibilityNotes: string[] = [];
      const totalMins = Math.round(totalDurationMillis / 60000);
      if (requestedMode === 'TRANSIT' && cleanStops.length > 2) {
        feasibilityNotes.push('Optimized intermediate waypoint order using walking geometry for transit stops.');
      }
      if (effectiveMode === 'WALK' && totalDistanceMeters > 8000) {
        feasibilityNotes.push(
          `Total walking distance is ${(totalDistanceMeters / 1000).toFixed(1)} km — consider switching to Transit or Driving.`
        );
      }
      if (totalMins > 150) {
        feasibilityNotes.push(`Active transit time is ~${totalMins} min; allow buffer between timed reservations.`);
      }
      if (feasibilityNotes.length === 0) {
        feasibilityNotes.push(
          `Feasible ${travelMode.toLowerCase()} loop (${(totalDistanceMeters / 1000).toFixed(1)} km, ~${totalMins} min travel time).`
        );
      }

      res.json({
        dayIndex: Number(dayIndex) || 0,
        orderedStopIds: orderedStops.map((s: any) => s.id),
        totalDistanceMeters,
        totalDurationMillis,
        savedDistanceMeters,
        legs,
        feasibilityNotes,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Day route optimization failed.',
      });
    }
  });

  app.post('/api/chat', chatLimiter, async (req: Request, res: Response) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({ error: 'GEMINI_API_KEY is not configured in Settings > Secrets.' });
        return;
      }

      const {
        messages,
        userLocation,
        tripContext,
        groundingMode = 'hybrid',
      } = req.body ?? {};

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages array is required' });
        return;
      }

      const lat = typeof userLocation?.lat === 'number' ? userLocation.lat : 35.6762;
      const lng = typeof userLocation?.lng === 'number' ? userLocation.lng : 139.6503;

      const enterprisePinsSummary =
        Array.isArray(tripContext?.enterprisePins) && tripContext.enterprisePins.length > 0
          ? `Active Enterprise Map Pins in View: ${tripContext.enterprisePins
              .slice(0, 10)
              .map(
                (p: any) =>
                  `[${String(p.source || '').toUpperCase()} ${p.externalKey || p.key || ''}] ${p.title} (${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)})`
              )
              .join('; ')}.`
          : '';

      const systemInstruction = [
        'You are GeoInteract, an expert urban explorer, field-ops planner, and travel cartographer agent.',
        'Always provide accurate, location-specific recommendations grounded in real-time Google Maps Places data and live Google Search results.',
        'Never invent or hallucinate place coordinates, ratings, opening hours, or addresses; use search_places_text or search_nearby_places first before proposing itinerary stops or geofences.',
        'When the user asks to plan an itinerary, add stops, create a geofence zone, or optimize a day route, invoke the matching proposal tool (propose_add_stops, propose_create_geofence, or propose_optimize_day) using verified coordinates so the user gets one-tap Apply cards.',
        'Keep responses crisp, structured, and actionable for travelers on the move, mentioning walking/transit practicality, current status if relevant, and priority suggestions.',
        tripContext
          ? `Active Trip Context: Destination "${tripContext.destination || 'Current Map Area'}", Travel Mode "${tripContext.travelMode || 'WALKING'}", Interests "${tripContext.interests || 'urban exploration, local food, architecture'}", Saved Stops: ${Array.isArray(tripContext.stopNames) ? tripContext.stopNames.join(', ') : 'none'}.`
          : '',
        enterprisePinsSummary,
        `Current Map/User Coordinates: lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)}.`,
      ]
        .filter(Boolean)
        .join('\n');

      const contents = messages.slice(-12).map((m: { role: string; text: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.text || '') }],
      }));

      // Mode 1: Dedicated Google Maps Grounding (googleMaps cannot be mixed with googleSearch)
      if (groundingMode === 'maps') {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: {
            systemInstruction,
            tools: [{ googleMaps: {} }],
            toolConfig: {
              retrievalConfig: {
                latLng: { latitude: lat, longitude: lng },
              },
            },
          },
        });

        const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const groundingLinks = rawChunks
          .filter((c: any) => c.maps?.uri)
          .map((c: any) => ({
            title: c.maps.title || 'Google Maps Place',
            uri: c.maps.uri,
            sourceType: 'maps' as const,
            reviewSnippets: Array.isArray(c.maps.placeAnswerSources?.reviewSnippets)
              ? c.maps.placeAnswerSources.reviewSnippets.map((r: any) => r.content || r.text).filter(Boolean)
              : [],
          }));

        res.json({
          text: response.text || 'I checked Google Maps for that area.',
          groundingLinks,
          discoveredPlaces: [],
          proposals: [],
          mode: 'maps',
        });
        return;
      }

      // Mode 2: Hybrid Google Search Grounding + Real-time Google Maps Places & Actionable Agent Tools
      const tools = [
        { googleSearch: {} },
        {
          functionDeclarations: [
            searchPlacesTextDecl,
            searchNearbyPlacesDecl,
            proposeAddStopsDecl,
            proposeCreateGeofenceDecl,
            proposeOptimizeDayDecl,
          ],
        },
      ];
      const toolConfig = { includeServerSideToolInvocations: true };

      const discoveredPlaces: DiscoveredPlace[] = [];
      const proposals: Array<Record<string, unknown>> = [];
      let quotaExceeded = false;
      const allGroundingChunks: any[] = [];

      let conversationContents: any[] = [...contents];
      let finalResponse = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: conversationContents,
        config: {
          systemInstruction,
          tools,
          toolConfig,
        },
      });
      allGroundingChunks.push(
        ...(finalResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      );

      // Up to 2 tool-calling turns (e.g. search_places_text -> propose_add_stops -> final summary)
      for (let turn = 0; turn < 2; turn++) {
        const previousContent = finalResponse.candidates?.[0]?.content;
        const functionCalls = finalResponse.functionCalls;
        if (!previousContent || !Array.isArray(functionCalls) || functionCalls.length === 0) {
          break;
        }

        const functionResponseParts = [];

        for (const call of functionCalls) {
          const args = (call.args || {}) as Record<string, any>;
          if (call.name === 'search_places_text') {
            const result = await callPlacesTextSearch(
              String(args.query || ''),
              typeof args.lat === 'number' ? args.lat : lat,
              typeof args.lng === 'number' ? args.lng : lng,
              typeof args.radiusMeters === 'number' ? args.radiusMeters : 5000
            );
            if (result.quotaExceeded) quotaExceeded = true;
            discoveredPlaces.push(...result.places);
            functionResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: {
                  places: result.places,
                  error: result.error || null,
                },
              },
            });
          } else if (call.name === 'search_nearby_places') {
            const result = await callPlacesNearbySearch(
              typeof args.lat === 'number' ? args.lat : lat,
              typeof args.lng === 'number' ? args.lng : lng,
              typeof args.radiusMeters === 'number' ? args.radiusMeters : 2500,
              Array.isArray(args.includedTypes) ? args.includedTypes : []
            );
            if (result.quotaExceeded) quotaExceeded = true;
            discoveredPlaces.push(...result.places);
            functionResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: {
                  places: result.places,
                  error: result.error || null,
                },
              },
            });
          } else if (call.name === 'propose_add_stops') {
            const rawStops = Array.isArray(args.stops) ? args.stops.slice(0, 6) : [];
            const validStops = rawStops
              .filter(
                (s: any) =>
                  s &&
                  typeof s.name === 'string' &&
                  typeof s.lat === 'number' &&
                  typeof s.lng === 'number'
              )
              .map((s: any) => ({
                name: String(s.name).slice(0, 120),
                address: String(s.address || `${Number(s.lat).toFixed(4)}, ${Number(s.lng).toFixed(4)}`),
                lat: Number(s.lat),
                lng: Number(s.lng),
                placeId: String(s.placeId || `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
                category: String(s.category || 'Curated Stop'),
                priority:
                  s.priority === 'high' || s.priority === 'low' ? s.priority : 'normal',
                notes: typeof s.notes === 'string' ? s.notes.slice(0, 240) : undefined,
                rating: typeof s.rating === 'number' ? s.rating : undefined,
                googleMapsUri: typeof s.googleMapsUri === 'string' ? s.googleMapsUri : undefined,
              }));

            if (validStops.length > 0) {
              proposals.push({
                id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                kind: 'add_stops',
                summary: String(args.summary || `Add ${validStops.length} stop(s) to itinerary`),
                dayIndex: Math.max(0, Math.min(30, Number(args.dayIndex) || 0)),
                stops: validStops,
              });
            }
            functionResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { queuedForUserApproval: true, count: validStops.length },
              },
            });
          } else if (call.name === 'propose_create_geofence') {
            if (typeof args.lat === 'number' && typeof args.lng === 'number') {
              const triggerOn =
                args.triggerOn === 'enter' || args.triggerOn === 'exit' || args.triggerOn === 'both'
                  ? args.triggerOn
                  : 'both';
              proposals.push({
                id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                kind: 'create_geofence',
                summary: String(args.summary || `Create geofence around ${args.label || 'zone'}`),
                geofence: {
                  label: String(args.label || 'Alert Zone').slice(0, 80),
                  lat: Number(args.lat),
                  lng: Number(args.lng),
                  radiusMeters: Math.max(50, Math.min(5000, Number(args.radiusMeters) || 200)),
                  triggerOn,
                  alertMessage: String(
                    args.alertMessage || `Entered/exited ${args.label || 'geofence zone'}.`
                  ).slice(0, 200),
                },
              });
            }
            functionResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { queuedForUserApproval: true },
              },
            });
          } else if (call.name === 'propose_optimize_day') {
            const dayIdx = Math.max(0, Math.min(30, Number(args.dayIndex) || 0));
            proposals.push({
              id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              kind: 'optimize_day',
              summary: String(args.summary || `Optimize Day ${dayIdx + 1} route order`),
              dayIndex: dayIdx,
            });
            functionResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { queuedForUserApproval: true, dayIndex: dayIdx },
              },
            });
          }
        }

        if (functionResponseParts.length === 0) break;

        conversationContents = [
          ...conversationContents,
          previousContent,
          { role: 'user', parts: functionResponseParts },
        ];

        finalResponse = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: conversationContents,
          config: {
            systemInstruction,
            tools,
            toolConfig,
          },
        });
        allGroundingChunks.push(
          ...(finalResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        );
      }

      const seenUris = new Set<string>();
      const groundingLinks = allGroundingChunks
        .filter((c: any) => c.web?.uri && !seenUris.has(c.web.uri) && seenUris.add(c.web.uri))
        .map((c: any) => ({
          title: c.web.title || 'Web Source',
          uri: c.web.uri,
          sourceType: 'web' as const,
        }));

      res.json({
        text: finalResponse.text || 'Here are the locations and actionable suggestions I prepared.',
        groundingLinks,
        discoveredPlaces,
        proposals,
        quotaExceeded,
        mode: 'hybrid',
      });
    } catch (err: any) {
      const status = err?.status === 429 ? 429 : 500;
      let message = err instanceof Error ? err.message : 'Chat generation failed.';
      try {
        const parsed = JSON.parse(message);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        // Keep string message
      }
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/alerts/check', alertsLimiter, async (req: Request, res: Response) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });
        return;
      }

      const { destination, stops = [] } = req.body ?? {};
      if (!destination) {
        res.status(400).json({ error: 'destination is required' });
        return;
      }

      const prompt = `Check today's real-time travel, transit, weather, or venue closure alerts for "${destination}"${
        Array.isArray(stops) && stops.length > 0 ? ` and these specific spots: ${stops.slice(0, 6).join(', ')}` : ''
      }.
Summarize up to 3 concise alerts. Classify each as either:
- "last_minute_alert" (major disruption, severe weather, strike, or sudden closure impacting schedule)
- "schedule_impact" (moderate delay >15 mins, crowd/event advisory)
- "minor" (routine note with <5 min schedule impact)
Format each bullet clearly starting with [LAST_MINUTE], [SCHEDULE_IMPACT], or [MINOR].`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const groundingLinks = rawChunks
        .filter((c: any) => c.web?.uri)
        .map((c: any) => ({
          title: c.web.title || 'Travel Advisory Source',
          uri: c.web.uri,
        }));

      res.json({
        summary: response.text || 'No active travel disruptions found.',
        groundingLinks,
      });
    } catch (err: any) {
      const status = err?.status === 429 ? 429 : 500;
      let message = err instanceof Error ? err.message : 'Alert check failed';
      try {
        const parsed = JSON.parse(message);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        // Keep string message
      }
      res.status(status).json({ error: message });
    }
  });

  // Active Disruption Re-Router & 1-Tap Recovery Engine (Gemini + Direct Google Places + Direct Google Routes)
  app.post('/api/alerts/recover', alertsLimiter, async (req: Request, res: Response) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });
        return;
      }

      const {
        tripId = 'local',
        alertId = `alert_${Date.now()}`,
        alertTitle = 'Travel Disruption',
        alertBody = '',
        destination = 'Current Area',
        dayIndex = 0,
        travelMode = 'WALKING',
        dayStops = [],
      } = req.body ?? {};

      const cleanStops = Array.isArray(dayStops)
        ? dayStops
            .filter(
              (s: any) =>
                s &&
                typeof s.id === 'string' &&
                typeof s.name === 'string' &&
                typeof s.lat === 'number' &&
                typeof s.lng === 'number'
            )
            .slice(0, 12)
        : [];

      if (cleanStops.length === 0) {
        res.status(400).json({ error: 'At least 1 stop on the active day is required to plan recovery.' });
        return;
      }

      const stopsContext = cleanStops
        .map(
          (s: any, idx: number) =>
            `${idx + 1}. id="${s.id}" name="${s.name}" category="${s.category || 'POI'}" priority="${s.priority || 'normal'}" window="${s.timeWindow || 'flexible'}" coords=(${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})`
        )
        .join('\n');

      const analysisPrompt = `A travel/field disruption alert occurred in "${destination}":
Title: ${alertTitle}
Details: ${alertBody}

Planned Day ${Number(dayIndex) + 1} stops:
${stopsContext}

Identify which stops are impacted by this disruption (at least 1 stop if relevant, or reorder guidance), suggest 1-2 specific nearby unaffected Google Maps replacement search queries (e.g. indoor museum, covered market, transit-accessible cafe/workspace near "${destination}"), estimate delay avoided in minutes, and write a concise reschedule note suitable for enterprise Jira/Salesforce/ServiceNow escalation.`;

      const analysisRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: analysisPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              affectedStopIds: { type: Type.ARRAY, items: { type: Type.STRING } },
              estimatedDelayAvoidedMinutes: { type: Type.INTEGER },
              escalationMessage: { type: Type.STRING },
              replacementQueries: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    replacesStopId: { type: Type.STRING },
                    searchQuery: { type: Type.STRING },
                    reason: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });

      let parsed: any = {};
      try {
        parsed = JSON.parse((analysisRes.text ?? '{}').trim());
      } catch {
        parsed = {};
      }

      const validIds = new Set(cleanStops.map((s: any) => s.id));
      const affectedStopIds: string[] = Array.isArray(parsed.affectedStopIds)
        ? parsed.affectedStopIds.filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id))
        : [cleanStops[0].id];

      const rawQueries = Array.isArray(parsed.replacementQueries)
        ? parsed.replacementQueries.slice(0, 2)
        : [];
      const fallbackQueryList =
        rawQueries.length > 0
          ? rawQueries
          : [
              {
                replacesStopId: affectedStopIds[0] || cleanStops[0].id,
                searchQuery: `indoor cafe or museum near ${destination}`,
                reason: `Avoids "${alertTitle}" disruption`,
              },
            ];

      const replacements: Array<{
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
      }> = [];
      let quotaExceeded = false;
      const existingNames = new Set(cleanStops.map((s: any) => s.name.toLowerCase()));

      for (const qItem of fallbackQueryList) {
        const targetStop =
          cleanStops.find((s: any) => s.id === qItem.replacesStopId) || cleanStops[0];
        const query = String(qItem.searchQuery || `indoor spot near ${destination}`);
        const placesRes = await callPlacesTextSearch(query, targetStop.lat, targetStop.lng, 4500);
        if (placesRes.quotaExceeded) quotaExceeded = true;
        const candidate = placesRes.places.find((p) => !existingNames.has(p.name.toLowerCase()));
        if (candidate) {
          existingNames.add(candidate.name.toLowerCase());
          replacements.push({
            replacesStopId: targetStop.id,
            replacesStopName: targetStop.name,
            reason: String(qItem.reason || `Alternative avoiding ${alertTitle}`),
            name: candidate.name,
            address: candidate.address,
            lat: candidate.lat,
            lng: candidate.lng,
            placeId: candidate.placeId,
            category: candidate.primaryType || 'Recovery Alternative',
            rating: candidate.rating,
            googleMapsUri: candidate.googleMapsUri,
          });
        }
      }

      const replacementByTarget = new Map(
        replacements.filter((r) => r.replacesStopId).map((r) => [r.replacesStopId!, r])
      );

      const proposedStops = cleanStops.map((s: any) => {
        const rep = replacementByTarget.get(s.id);
        if (rep) {
          return {
            id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: rep.name,
            address: rep.address,
            lat: rep.lat,
            lng: rep.lng,
            placeId: rep.placeId,
            category: rep.category,
            priority: s.priority === 'high' || s.priority === 'low' ? s.priority : 'normal',
            notes: `Recovery replacement for ${s.name}: ${rep.reason}`,
            isReplacement: true,
            replacesStopId: s.id,
            rating: rep.rating,
            googleMapsUri: rep.googleMapsUri,
          };
        }
        return {
          id: s.id,
          name: s.name,
          address: s.address || `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`,
          lat: s.lat,
          lng: s.lng,
          placeId: s.placeId || s.id,
          category: s.category || 'Point of Interest',
          priority: s.priority === 'high' || s.priority === 'low' ? s.priority : 'normal',
          notes: s.notes,
          isReplacement: false,
        };
      });

      // Compute updated route legs for proposedStops via direct Google Routes API when >= 2 stops
      const legs: any[] = [];
      const mapsApiKey = getMapsApiKey();
      if (mapsApiKey && proposedStops.length >= 2) {
        const modeMap: Record<string, string> = {
          WALKING: 'WALK',
          DRIVING: 'DRIVE',
          BICYCLING: 'BICYCLE',
          TRANSIT: 'WALK',
        };
        const effectiveMode = modeMap[String(travelMode).toUpperCase()] || 'WALK';
        const routeBody: Record<string, unknown> = {
          origin: { location: { latLng: { latitude: proposedStops[0].lat, longitude: proposedStops[0].lng } } },
          destination: {
            location: {
              latLng: {
                latitude: proposedStops[proposedStops.length - 1].lat,
                longitude: proposedStops[proposedStops.length - 1].lng,
              },
            },
          },
          travelMode: effectiveMode,
          languageCode: 'en-US',
          units: 'METRIC',
        };
        if (proposedStops.length > 2) {
          routeBody.intermediates = proposedStops.slice(1, -1).map((s) => ({
            location: { latLng: { latitude: s.lat, longitude: s.lng } },
          }));
        }
        const fieldMask =
          'routes.legs.distanceMeters,routes.legs.duration,routes.legs.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration';
        // Official Google Maps Platform API call: strictly direct
        const routesRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': mapsApiKey,
            'X-Goog-FieldMask': fieldMask,
          },
          body: JSON.stringify(routeBody),
        }).catch(() => null);

        if (routesRes?.ok) {
          const routesData = (await routesRes.json()) as { routes?: any[] };
          const rawLegs = routesData?.routes?.[0]?.legs || [];
          rawLegs.forEach((leg: any, idx: number) => {
            const legOrigin = proposedStops[idx];
            const legDest = proposedStops[idx + 1];
            if (!legOrigin || !legDest) return;
            const encoded = leg?.polyline?.encodedPolyline || '';
            const decodedPath = encoded
              ? decodeEncodedPolyline(encoded)
              : [
                  { lat: legOrigin.lat, lng: legOrigin.lng },
                  { lat: legDest.lat, lng: legDest.lng },
                ];
            legs.push({
              id: `${tripId}_${legOrigin.lat.toFixed(4)}_${legOrigin.lng.toFixed(4)}_${legDest.lat.toFixed(4)}_${legDest.lng.toFixed(4)}_${travelMode}`,
              tripId,
              originName: legOrigin.name,
              destinationName: legDest.name,
              origin: { lat: legOrigin.lat, lng: legOrigin.lng },
              destination: { lat: legDest.lat, lng: legDest.lng },
              travelMode,
              distanceMeters: Number(leg.distanceMeters || 0),
              durationMillis: parseProtoDurationMs(leg.duration),
              path: decodedPath,
              steps: Array.isArray(leg.steps)
                ? leg.steps
                    .filter((st: any) => st?.navigationInstruction?.instructions)
                    .slice(0, 12)
                    .map((st: any) => ({
                      instruction: String(st.navigationInstruction.instructions),
                      distanceMeters: Number(st.distanceMeters || 0),
                      durationSeconds: Math.round(parseProtoDurationMs(st.staticDuration) / 1000),
                    }))
                : [],
              isOfflineEstimate: false,
              computedAt: Date.now(),
            });
          });
        }
      }

      res.json({
        id: `recplan_${Date.now()}`,
        alertId,
        dayIndex: Number(dayIndex) || 0,
        summary: String(
          parsed.summary ||
            `Prepared disruption recovery plan replacing ${replacements.length} impacted stop(s).`
        ),
        affectedStopIds,
        replacements,
        proposedStops,
        estimatedDelayAvoidedMinutes: Math.max(
          5,
          Math.min(240, Number(parsed.estimatedDelayAvoidedMinutes) || 25)
        ),
        escalationMessage: String(
          parsed.escalationMessage ||
            `GeoInteract schedule recovery applied for Day ${Number(dayIndex) + 1} due to "${alertTitle}".`
        ),
        legs,
        quotaExceeded,
      });
    } catch (err: any) {
      const status = err?.status === 429 ? 429 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Disruption recovery planning failed.',
      });
    }
  });

  // --- Enterprise Integrations API Routes (Protected by Firebase Auth + RBAC + Rate Limit) ---

  app.get(
    '/api/enterprise/audit',
    requireEnterpriseAuth,
    enterpriseLimiter,
    (_req: AuthedRequest, res: Response) => {
      res.json({ ok: true, entries: enterpriseAuditLog.slice(0, 30) });
    }
  );

  app.get(
    '/api/enterprise/jira/issues',
    requireEnterpriseAuth,
    enterpriseLimiter,
    async (req: AuthedRequest, res: Response) => {
      try {
        const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
        const jql = typeof req.query.jql === 'string' ? req.query.jql : undefined;
        const maxResults = req.query.maxResults !== undefined ? Number(req.query.maxResults) : 15;
        const bounds = parseViewportBounds(req.query);

        const result = await fetchGeocodedJiraIssues(
          Number.isFinite(lat) ? lat : undefined,
          Number.isFinite(lng) ? lng : undefined,
          jql,
          Number.isFinite(maxResults) ? maxResults : 15,
          bounds
        );
        if (!result.configured) {
          res.status(503).json(result);
          return;
        }
        if (result.error && result.issues.length === 0) {
          res.status(502).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({
          configured: Boolean(getJiraConfig()),
          issues: [],
          error: err instanceof Error ? err.message : 'Failed to fetch Jira issues.',
        });
      }
    }
  );

  app.get(
    '/api/enterprise/salesforce/accounts',
    requireEnterpriseAuth,
    enterpriseLimiter,
    async (req: AuthedRequest, res: Response) => {
      try {
        const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
        const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
        const bounds = parseViewportBounds(req.query);

        const result = await fetchGeocodedSalesforceAccounts(
          Number.isFinite(lat) ? lat : undefined,
          Number.isFinite(lng) ? lng : undefined,
          Number.isFinite(limit) ? limit : 20,
          bounds
        );
        if (!result.configured) {
          res.status(503).json(result);
          return;
        }
        if (result.error && result.accounts.length === 0) {
          res.status(502).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({
          configured: Boolean(getSalesforceConfig()),
          accounts: [],
          error: err instanceof Error ? err.message : 'Failed to fetch Salesforce accounts.',
        });
      }
    }
  );

  app.post(
    '/api/enterprise/log',
    requireEnterpriseAuth,
    enterpriseLimiter,
    async (req: AuthedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as EnterpriseLogPayload;
        const rawTargets = Array.isArray(body.targets)
          ? body.targets
          : body.target
          ? [body.target]
          : [];
        const validTargets = rawTargets.filter((t): t is EnterpriseConnectorId =>
          t === 'jira' || t === 'salesforce' || t === 'servicenow'
        );

        if (validTargets.length === 0) {
          res.status(400).json({ ok: false, error: 'At least one target connector (jira, salesforce, servicenow) is required.' });
          return;
        }
        if (!body.title || !body.description) {
          res.status(400).json({ ok: false, error: 'title and description are required.' });
          return;
        }

        const payload: EnterpriseLogPayload = {
          ...body,
          eventType: body.eventType === 'travel_alert' ? 'travel_alert' : 'geofence_checkin',
          targets: validTargets,
        };

        // Server-side idempotency deduplication (prevents duplicate records during offline replay or rapid retries)
        const idempKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : '';
        if (idempKey) {
          const now = Date.now();
          const cached = enterpriseIdempotencyCache.get(idempKey);
          if (cached && cached.expiresAt > now) {
            const dedupResults = cached.results.map((r) => ({ ...r, deduplicated: true }));
            recordEnterpriseAudit({
              id: `aud_${now}`,
              timestamp: new Date(now).toISOString(),
              actorUid: req.authUser?.uid || 'unauthenticated',
              actorEmail: req.authUser?.email,
              eventType: payload.eventType,
              title: payload.title,
              targets: validTargets,
              ok: true,
              deduplicated: true,
              results: dedupResults,
            });
            res.json({ ok: true, results: dedupResults, deduplicated: true });
            return;
          }
        }

        const results = await Promise.all(
          validTargets.map(async (target): Promise<EnterpriseLogResult> => {
            try {
              if (target === 'jira') return await logToJira(payload);
              if (target === 'salesforce') return await logToSalesforce(payload);
              return await logToServiceNow(payload);
            } catch (err) {
              return {
                target,
                ok: false,
                error: err instanceof Error ? err.message : `Failed to log event to ${target}.`,
              };
            }
          })
        );

        const anyOk = results.some((r) => r.ok);
        if (idempKey && anyOk) {
          const now = Date.now();
          enterpriseIdempotencyCache.set(idempKey, {
            expiresAt: now + IDEMPOTENCY_TTL_MS,
            results,
          });
          if (enterpriseIdempotencyCache.size > 500) {
            for (const [k, v] of enterpriseIdempotencyCache.entries()) {
              if (v.expiresAt <= now) enterpriseIdempotencyCache.delete(k);
            }
          }
        }

        recordEnterpriseAudit({
          id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          actorUid: req.authUser?.uid || 'unauthenticated',
          actorEmail: req.authUser?.email,
          eventType: payload.eventType,
          title: payload.title,
          targets: validTargets,
          ok: anyOk,
          results: results.map((r) => ({
            target: r.target,
            ok: r.ok,
            recordId: r.recordId,
            recordUrl: r.recordUrl,
            updatedExisting: r.updatedExisting,
            error: r.error,
          })),
        });

        res.status(anyOk ? 200 : 502).json({ ok: anyOk, results });
      } catch (err) {
        res.status(500).json({
          ok: false,
          results: [],
          error: err instanceof Error ? err.message : 'Enterprise event logging failed.',
        });
      }
    }
  );

  // Autonomous Field Dispatch: ranks visible enterprise pins + optimizes route via Google Routes API + briefs with Gemini
  app.post(
    '/api/enterprise/dispatch',
    requireEnterpriseAuth,
    enterpriseLimiter,
    async (req: AuthedRequest, res: Response) => {
      try {
        const {
          tripId = 'local',
          dayIndex = 0,
          travelMode = 'DRIVING',
          avoidTolls = false,
          pins = [],
          userLocation,
          destination = 'Field Territory',
        } = req.body ?? {};

        const validPins = Array.isArray(pins)
          ? pins.filter(
              (p: any) =>
                p &&
                (p.source === 'jira' || p.source === 'salesforce') &&
                typeof p.title === 'string' &&
                typeof p.lat === 'number' &&
                typeof p.lng === 'number'
            )
          : [];

        if (validPins.length === 0) {
          res.status(400).json({ error: 'At least 1 geocoded Jira or Salesforce pin is required for Field Dispatch.' });
          return;
        }

        const anchor =
          userLocation && typeof userLocation.lat === 'number' && typeof userLocation.lng === 'number'
            ? { lat: userLocation.lat, lng: userLocation.lng }
            : { lat: validPins[0].lat, lng: validPins[0].lng };

        const priorityScore = (raw?: string): number => {
          const p = String(raw || '').toLowerCase();
          if (p.includes('highest') || p.includes('critical') || p.includes('blocker') || p.includes('hot')) return 3;
          if (p.includes('high') || p.includes('warm') || p.includes('urgent')) return 2;
          return 1;
        };

        // Rank by enterprise severity first, then proximity to current location; cap at 8 stops per field day
        const selectedPins = [...validPins]
          .sort((a: any, b: any) => {
            const scoreDiff = priorityScore(b.priority) - priorityScore(a.priority);
            if (scoreDiff !== 0) return scoreDiff;
            return haversineMetersServer(anchor, a) - haversineMetersServer(anchor, b);
          })
          .slice(0, 8);

        let orderedPins = selectedPins;
        let legs: any[] = [];
        let totalDistanceMeters = 0;
        let totalDurationMillis = 0;
        let savedDistanceMeters = 0;
        const feasibilityNotes: string[] = [];

        let baselineDistanceMeters = 0;
        for (let i = 0; i < selectedPins.length - 1; i++) {
          baselineDistanceMeters += Math.round(
            haversineMetersServer(selectedPins[i], selectedPins[i + 1]) * 1.28
          );
        }

        const apiKey = getMapsApiKey();
        if (apiKey && selectedPins.length >= 2) {
          const modeMap: Record<string, string> = {
            WALKING: 'WALK',
            DRIVING: 'DRIVE',
            BICYCLING: 'BICYCLE',
            TRANSIT: 'DRIVE',
          };
          const effectiveMode = modeMap[String(travelMode).toUpperCase()] || 'DRIVE';
          const origin = selectedPins[0];
          const destPin = selectedPins[selectedPins.length - 1];
          const intermediates = selectedPins.slice(1, -1);

          const routeBody: Record<string, unknown> = {
            origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
            destination: { location: { latLng: { latitude: destPin.lat, longitude: destPin.lng } } },
            travelMode: effectiveMode,
            languageCode: 'en-US',
            units: 'METRIC',
          };
          if (intermediates.length > 0) {
            routeBody.intermediates = intermediates.map((p: any) => ({
              location: { latLng: { latitude: p.lat, longitude: p.lng } },
            }));
            routeBody.optimizeWaypointOrder = true;
          }
          if (effectiveMode === 'DRIVE') {
            routeBody.routingPreference = 'TRAFFIC_AWARE';
            routeBody.routeModifiers = { avoidTolls: Boolean(avoidTolls) };
          }

          const fieldMask =
            'routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex,routes.legs.distanceMeters,routes.legs.duration,routes.legs.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration';

          // Official Google Maps Platform Routes API call: strictly direct
          const routesRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': fieldMask,
            },
            body: JSON.stringify(routeBody),
          }).catch(() => null);

          if (routesRes?.ok) {
            const routesData = (await routesRes.json()) as { routes?: any[] };
            const best = routesData?.routes?.[0];
            if (best) {
              const optIndices: number[] = Array.isArray(best.optimizedIntermediateWaypointIndex)
                ? best.optimizedIntermediateWaypointIndex
                : intermediates.map((_: any, i: number) => i);
              orderedPins = [
                origin,
                ...optIndices.map((idx) => intermediates[idx]).filter(Boolean),
                destPin,
              ];
              const rawLegs = Array.isArray(best.legs) ? best.legs : [];
              legs = rawLegs.map((leg: any, idx: number) => {
                const a = orderedPins[idx] || origin;
                const b = orderedPins[idx + 1] || destPin;
                const encoded = leg?.polyline?.encodedPolyline || '';
                const decodedPath = encoded
                  ? decodeEncodedPolyline(encoded)
                  : [
                      { lat: a.lat, lng: a.lng },
                      { lat: b.lat, lng: b.lng },
                    ];
                return {
                  id: `${tripId}_${a.lat.toFixed(4)}_${a.lng.toFixed(4)}_${b.lat.toFixed(4)}_${b.lng.toFixed(4)}_${travelMode}`,
                  tripId,
                  originName: a.title,
                  destinationName: b.title,
                  origin: { lat: a.lat, lng: a.lng },
                  destination: { lat: b.lat, lng: b.lng },
                  travelMode,
                  distanceMeters: Number(leg.distanceMeters || 0),
                  durationMillis: parseProtoDurationMs(leg.duration),
                  path: decodedPath,
                  steps: Array.isArray(leg?.steps)
                    ? leg.steps
                        .filter((st: any) => st?.navigationInstruction?.instructions)
                        .slice(0, 12)
                        .map((st: any) => ({
                          instruction: String(st.navigationInstruction.instructions),
                          distanceMeters: Number(st.distanceMeters || 0),
                          durationSeconds: Math.round(parseProtoDurationMs(st.staticDuration) / 1000),
                        }))
                    : [],
                  isOfflineEstimate: false,
                  computedAt: Date.now(),
                };
              });
              totalDistanceMeters = Number(
                best.distanceMeters || legs.reduce((acc, l) => acc + l.distanceMeters, 0)
              );
              totalDurationMillis =
                parseProtoDurationMs(best.duration) ||
                legs.reduce((acc, l) => acc + l.durationMillis, 0);
              savedDistanceMeters = Math.max(0, baselineDistanceMeters - totalDistanceMeters);
            }
          }
        }

        if (totalDistanceMeters === 0 && orderedPins.length > 1) {
          totalDistanceMeters = baselineDistanceMeters;
          totalDurationMillis = Math.round((totalDistanceMeters / 9.5) * 1000);
        }

        const orderedStops = orderedPins.map((p: any) => ({
          pinId: String(p.id || `${p.source}_${p.externalKey}`),
          source: p.source as 'jira' | 'salesforce',
          externalKey: String(p.externalKey || p.id),
          externalUrl: typeof p.externalUrl === 'string' ? p.externalUrl : undefined,
          name: String(p.title),
          address: String(p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`),
          lat: Number(p.lat),
          lng: Number(p.lng),
          priority: priorityScore(p.priority) >= 2 ? ('high' as const) : ('normal' as const),
          category: p.source === 'jira' ? 'Jira Field Site' : 'Salesforce Account',
          notes: [p.subtitle, p.status ? `Status: ${p.status}` : '', p.priority ? `Priority: ${p.priority}` : '']
            .filter(Boolean)
            .join(' · '),
          geofenceRadiusMeters: 250,
        }));

        let summary = `Dispatched ${orderedStops.length} enterprise site${
          orderedStops.length === 1 ? '' : 's'
        } for Day ${Number(dayIndex) + 1} with linked auto-pilot geofences.`;

        // Optional concise Gemini tactical briefing
        const ai = getGeminiClient();
        if (ai && orderedStops.length > 0) {
          try {
            const briefPrompt = `Write one crisp 1-sentence field operations dispatch summary for Day ${Number(dayIndex) + 1} in "${destination}" covering these ordered stops: ${orderedStops
              .map((s, i) => `#${i + 1} ${s.name} (${s.source.toUpperCase()} ${s.externalKey}, ${s.priority})`)
              .join('; ')}. Total distance ~${(totalDistanceMeters / 1000).toFixed(1)} km. Keep under 28 words.`;
            const aiBrief = await ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: briefPrompt,
            });
            if (aiBrief.text?.trim()) {
              summary = aiBrief.text.trim().replace(/^["']|["']$/g, '').slice(0, 220);
            }
          } catch {
            // Non-fatal; default summary already populated
          }
        }

        feasibilityNotes.push(
          `Auto-provisioned ${orderedStops.length} linked 250m proximity geofences for closed-loop check-in/out & automatic stop completion.`
        );
        if (savedDistanceMeters > 100) {
          feasibilityNotes.push(
            `Multi-waypoint routing saved ${(savedDistanceMeters / 1000).toFixed(1)} km across ${orderedStops.length} sites.`
          );
        }

        res.json({
          dayIndex: Number(dayIndex) || 0,
          summary,
          orderedStops,
          totalDistanceMeters,
          totalDurationMillis,
          savedDistanceMeters,
          legs,
          feasibilityNotes,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Field dispatch planning failed.',
        });
      }
    }
  );

  // Cloud SQL PostgreSQL: Authenticated Geofence Event Telemetry Persistence
  app.get(
    '/api/sql/geofence-events',
    enterpriseLimiter,
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const uid = req.user?.uid;
        if (!uid) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        const limitRaw = Number(req.query.limit ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 100) : 50;
        const events = await listUserGeofenceEvents(uid, limit);
        res.json({ events });
      } catch (err) {
        console.error('Failed to fetch geofence events:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load geofence events.',
        });
      }
    }
  );

  app.post(
    '/api/sql/geofence-events',
    enterpriseLimiter,
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const decoded = req.user;
        if (!decoded?.uid || !decoded.email) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const {
          tripId,
          geofenceId,
          geofenceLabel,
          stopId,
          eventType,
          lat,
          lng,
          distanceMeters,
          dwellDurationSeconds,
        } = req.body ?? {};

        if (
          typeof tripId !== 'string' ||
          !tripId.trim() ||
          typeof geofenceId !== 'string' ||
          !geofenceId.trim() ||
          typeof geofenceLabel !== 'string' ||
          !geofenceLabel.trim() ||
          (eventType !== 'enter' && eventType !== 'exit') ||
          typeof lat !== 'number' ||
          typeof lng !== 'number' ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          lat < -90 ||
          lat > 90 ||
          lng < -180 ||
          lng > 180
        ) {
          res.status(400).json({ error: 'Invalid geofence event payload.' });
          return;
        }

        const dbUser = await getOrCreateUser(
          decoded.uid,
          decoded.email,
          typeof decoded.name === 'string' ? decoded.name : null
        );

        const created = await recordGeofenceEvent({
          userId: dbUser.id,
          tripId: tripId.trim().slice(0, 128),
          geofenceId: geofenceId.trim().slice(0, 128),
          geofenceLabel: geofenceLabel.trim().slice(0, 200),
          stopId: typeof stopId === 'string' && stopId.trim() ? stopId.trim().slice(0, 128) : null,
          eventType,
          lat,
          lng,
          distanceMeters:
            typeof distanceMeters === 'number' && Number.isFinite(distanceMeters)
              ? distanceMeters
              : null,
          dwellDurationSeconds:
            typeof dwellDurationSeconds === 'number' && Number.isFinite(dwellDurationSeconds)
              ? Math.max(0, Math.round(dwellDurationSeconds))
              : null,
        });

        res.status(201).json({ event: created });
      } catch (err) {
        console.error('Failed to persist geofence event:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to save geofence event.',
        });
      }
    }
  );

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrEnabled = process.env.DISABLE_HMR !== 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: hmrEnabled ? { server: httpServer } : false,
        hmr: hmrEnabled,
        watch: hmrEnabled ? {} : null,
      },
      appType: 'spa',
    });

    // When HMR is disabled (DISABLE_HMR=true), Vite 8 still injects /@vite/client
    // which tries to open a WebSocket to port 24678 and throws "WebSocket closed without opened."
    // Serve a clean no-WebSocket shim that preserves CSS injection and import.meta.hot APIs.
    if (!hmrEnabled) {
      const noHmrViteClient = `
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  const data = {};
  return {
    get data() { return data; },
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (!url || (!url.startsWith('.') && !url.startsWith('/'))) return url;
  const pathname = url.replace(/[?#].*$/s, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
export class ErrorOverlay extends HTMLElement {}
`;
      app.get('/@vite/client', (_req: Request, res: Response) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(noHmrViteClient);
      });
    }

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`GeoInteract server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start GeoInteract server:', err);
  process.exit(1);
});
