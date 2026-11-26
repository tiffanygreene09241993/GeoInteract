/**
 * Security TDD Specification for Waypost Firestore Rules
 * Verifies all 12 "Dirty Dozen" adversarial payloads are rejected with PERMISSION_DENIED.
 */

export interface DirtyDozenCase {
  id: string;
  description: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 'DD-01',
    description: 'Unverified email spoof attempt on trip creation',
    path: 'trips/trip_spoof_1',
    operation: 'create',
    auth: { uid: 'user_a', email_verified: false },
    payload: { id: 'trip_spoof_1', ownerId: 'user_a', collaboratorUids: ['user_a'], status: 'active' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-02',
    description: 'Owner spoofing on trip creation',
    path: 'trips/trip_spoof_2',
    operation: 'create',
    auth: { uid: 'attacker_uid', email_verified: true },
    payload: { id: 'trip_spoof_2', ownerId: 'victim_uid', collaboratorUids: ['victim_uid'], status: 'active' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-03',
    description: 'Shadow ghost field injection (isAdmin: true)',
    path: 'trips/trip_ghost_3',
    operation: 'create',
    auth: { uid: 'user_a', email_verified: true },
    payload: { id: 'trip_ghost_3', ownerId: 'user_a', collaboratorUids: ['user_a'], isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-04',
    description: 'ID poisoning with 1500-char document ID',
    path: `trips/${'a'.repeat(1500)}`,
    operation: 'create',
    auth: { uid: 'user_a', email_verified: true },
    payload: { ownerId: 'user_a' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-05',
    description: 'Client timestamp forgery instead of request.time',
    path: 'trips/trip_time_5',
    operation: 'create',
    auth: { uid: 'user_a', email_verified: true },
    payload: { id: 'trip_time_5', ownerId: 'user_a', createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-06',
    description: 'PII blanket read on another user private info',
    path: 'users/victim_uid/private/info',
    operation: 'get',
    auth: { uid: 'attacker_uid', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-07',
    description: 'Unauthenticated list scrape on trips',
    path: 'trips',
    operation: 'list',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-08',
    description: 'Orphaned stop creation under nonexistent parent trip',
    path: 'trips/nonexistent_trip/stops/stop_1',
    operation: 'create',
    auth: { uid: 'user_a', email_verified: true },
    payload: { id: 'stop_1', tripId: 'nonexistent_trip', ownerId: 'user_a' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-09',
    description: 'Viewer privilege escalation writing a stop',
    path: 'trips/trip_1/stops/stop_esc',
    operation: 'create',
    auth: { uid: 'viewer_uid', email_verified: true },
    payload: { id: 'stop_esc', tripId: 'trip_1', createdBy: 'viewer_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-10',
    description: 'Forged invite code join attempt',
    path: 'trips/trip_1/members/attacker_uid',
    operation: 'create',
    auth: { uid: 'attacker_uid', email_verified: true },
    payload: { uid: 'attacker_uid', tripId: 'trip_1', role: 'editor', inviteCode: 'forged_code' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-11',
    description: 'Oversized encryptedPayload Denial of Wallet attack',
    path: 'trips/trip_1/stops/stop_big',
    operation: 'create',
    auth: { uid: 'user_a', email_verified: true },
    payload: { id: 'stop_big', encryptedPayload: 'x'.repeat(50000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-12',
    description: 'Immutable ownerId overwrite on trip update',
    path: 'trips/trip_1',
    operation: 'update',
    auth: { uid: 'editor_uid', email_verified: true },
    payload: { ownerId: 'editor_uid' },
    expected: 'PERMISSION_DENIED',
  },
];
