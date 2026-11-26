# Waypost Firestore Security Specification

## 1. Data Invariants
1. **PII Isolation**: User email addresses reside exclusively under `/users/{userId}/private/info` and are readable/writable only by `request.auth.uid == userId` with verified email (`request.auth.token.email_verified == true`).
2. **Master Gate Relational Integrity**: Subcollections under `/trips/{tripId}` (`members`, `invites`, `stops`, `geofences`, `alerts`, `messages`) verify parent `/trips/{tripId}` ownership or active membership via `get()` on single-document operations (`get`, `create`, `update`, `delete`).
3. **Zero-Cost List Enforcement**: Every `allow list` rule evaluates `resource.data` directly (`ownerId == request.auth.uid || request.auth.uid in resource.data.collaboratorUids`) without `get()` or `exists()` lookups.
4. **Bounded Collaborators**: `collaboratorUids` is strictly bounded to `<= 20` entries, preventing unbounded arrays.
5. **Immutable Identity & Temporal Integrity**: `id`, `tripId`, `ownerId`, `createdBy`, and `createdAt` cannot be modified after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
6. **Verified Auth Mandate**: All write operations require `request.auth != null && request.auth.token.email_verified == true`.
7. **Terminal State Locking**: Trips transitioned to `status: 'archived'` cannot be modified further by collaborators unless unarchived by the owner (or remain locked once archived).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Email Spoof**: Write `/trips/trip_1` with `email_verified: false` -> `PERMISSION_DENIED`.
2. **Owner Spoofing on Create**: Create `/trips/trip_2` with `ownerId: "victim_uid"` while authenticated as `"attacker_uid"` -> `PERMISSION_DENIED`.
3. **Shadow Ghost Field Injection**: Create `/trips/trip_3` with extra field `isAdmin: true` -> `PERMISSION_DENIED`.
4. **ID Poisoning (1.5KB Document ID)**: Create `/trips/${'a'.repeat(1500)}` -> `PERMISSION_DENIED`.
5. **Client Timestamp Forgery**: Create `/trips/trip_4` with `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> `PERMISSION_DENIED`.
6. **PII Blanket Read**: Authenticated non-owner reads `/users/victim_uid/private/info` -> `PERMISSION_DENIED`.
7. **Unauthenticated List Scrape**: Unauthenticated client lists `/trips` -> `PERMISSION_DENIED`.
8. **Orphaned Stop Creation**: Create `/trips/nonexistent_trip/stops/stop_1` -> `PERMISSION_DENIED`.
9. **Viewer Privilege Escalation**: User with `role: 'viewer'` in `/trips/trip_1/members/viewer_uid` attempts to create or update `/trips/trip_1/stops/stop_1` -> `PERMISSION_DENIED`.
10. **Forged Invite Join**: Attacker tries to join `/trips/trip_1/members/attacker_uid` with bogus `inviteCode: "fake_code"` -> `PERMISSION_DENIED`.
11. **Oversized Payload Denial of Wallet**: Create `/trips/trip_1/stops/stop_2` with `encryptedPayload` > 32768 chars -> `PERMISSION_DENIED`.
12. **Immutable Owner Overwrite**: Collaborator updates `/trips/trip_1` attempting to overwrite `ownerId` -> `PERMISSION_DENIED`.
