import { EnterpriseLogResult, SmartSyncStatus, SyncOutboxItem, SyncOutboxKind } from '../types/travel';
import { authFetch } from './authFetch';
import { loadOutboxItems, removeOutboxItem, saveOutboxItem } from './offlineStorage';

const BACKOFF_SCHEDULE_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_ATTEMPTS = 8;

type StatusListener = (status: SmartSyncStatus) => void;

export interface SyncFlushHandlers {
  onEnterpriseLogSynced?: (
    item: SyncOutboxItem,
    results: EnterpriseLogResult[]
  ) => void | Promise<void>;
  onReplayFirestoreMutation?: (item: SyncOutboxItem) => Promise<boolean>;
}

let currentStatus: SmartSyncStatus = {
  pendingCount: 0,
  syncing: false,
  lastSyncedAt: null,
  lastError: null,
};

let isFlushing = false;
const listeners = new Set<StatusListener>();

function emitStatus(patch: Partial<SmartSyncStatus>) {
  const next: SmartSyncStatus = { ...currentStatus, ...patch };
  if (
    next.pendingCount === currentStatus.pendingCount &&
    next.syncing === currentStatus.syncing &&
    next.lastSyncedAt === currentStatus.lastSyncedAt &&
    next.lastError === currentStatus.lastError
  ) {
    return;
  }
  currentStatus = next;
  for (const listener of listeners) {
    listener(currentStatus);
  }
}

export function getSmartSyncStatus(): SmartSyncStatus {
  return currentStatus;
}

export function subscribeSmartSyncStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(currentStatus);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshSyncStatus(): Promise<SmartSyncStatus> {
  const items = await loadOutboxItems();
  emitStatus({ pendingCount: items.length });
  return currentStatus;
}

async function registerBackgroundSyncIfAvailable() {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      };
      if (reg?.sync?.register) {
        await reg.sync.register('waypost-smart-sync');
      }
    }
  } catch {
    // Background Sync API is optional and may not be permitted in all contexts
  }
}

export async function enqueueOutboxMutation(params: {
  kind: SyncOutboxKind;
  idempotencyKey: string;
  tripId?: string;
  label: string;
  payload: Record<string, unknown>;
}): Promise<SyncOutboxItem> {
  const existing = await loadOutboxItems();
  const duplicate = existing.find((it) => it.idempotencyKey === params.idempotencyKey);
  if (duplicate) {
    // Update payload in place so latest edit wins while preserving idempotency key
    const updated: SyncOutboxItem = {
      ...duplicate,
      payload: params.payload,
      label: params.label,
      nextRetryAt: Date.now(),
    };
    await saveOutboxItem(updated);
    emitStatus({ pendingCount: existing.length });
    return updated;
  }

  const item: SyncOutboxItem = {
    id: `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: params.kind,
    idempotencyKey: params.idempotencyKey,
    tripId: params.tripId,
    label: params.label,
    payload: params.payload,
    createdAt: Date.now(),
    attempts: 0,
    nextRetryAt: Date.now(),
  };

  await saveOutboxItem(item);
  emitStatus({ pendingCount: existing.length + 1 });
  void registerBackgroundSyncIfAvailable();
  return item;
}

export async function enqueueEnterpriseLog(params: {
  idempotencyKey: string;
  tripId?: string;
  label: string;
  payload: Record<string, unknown>;
}): Promise<SyncOutboxItem> {
  return enqueueOutboxMutation({
    kind: 'enterprise_log',
    idempotencyKey: params.idempotencyKey,
    tripId: params.tripId,
    label: params.label,
    payload: params.payload,
  });
}

export async function enqueueFirestoreMutation(params: {
  idempotencyKey: string;
  tripId: string;
  label: string;
  payload: Record<string, unknown>;
}): Promise<SyncOutboxItem> {
  return enqueueOutboxMutation({
    kind: 'firestore_mutation',
    idempotencyKey: params.idempotencyKey,
    tripId: params.tripId,
    label: params.label,
    payload: params.payload,
  });
}

export async function flushSyncOutbox(
  handlers: SyncFlushHandlers = {},
  options: { force?: boolean } = {}
): Promise<{ processed: number; succeeded: number; remaining: number }> {
  if (isFlushing) {
    const items = await loadOutboxItems();
    return { processed: 0, succeeded: 0, remaining: items.length };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const items = await loadOutboxItems();
    emitStatus({ pendingCount: items.length, syncing: false });
    return { processed: 0, succeeded: 0, remaining: items.length };
  }

  const items = await loadOutboxItems();
  const now = Date.now();
  const dueItems = options.force ? items : items.filter((item) => item.nextRetryAt <= now);

  // Do not toggle syncing UI state when there is nothing due to flush
  if (dueItems.length === 0) {
    emitStatus({ pendingCount: items.length, syncing: false });
    return { processed: 0, succeeded: 0, remaining: items.length };
  }

  isFlushing = true;
  emitStatus({ pendingCount: items.length, syncing: true, lastError: null });

  let processed = 0;
  let succeeded = 0;
  let lastError: string | null = null;

  try {
    for (const item of dueItems) {
      processed += 1;

      try {
        if (item.kind === 'enterprise_log') {
          const res = await authFetch('/api/enterprise/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...item.payload,
              idempotencyKey: item.idempotencyKey,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data?.ok) {
            await removeOutboxItem(item.id);
            succeeded += 1;
            if (handlers.onEnterpriseLogSynced && Array.isArray(data.results)) {
              await handlers.onEnterpriseLogSynced(item, data.results as EnterpriseLogResult[]);
            }
          } else {
            const errMsg = data?.error || `HTTP ${res.status}`;
            // 401/403 should keep queued without burning through attempts rapidly
            const nextAttempts = res.status === 401 || res.status === 403 ? item.attempts : item.attempts + 1;
            if (nextAttempts >= MAX_ATTEMPTS) {
              await removeOutboxItem(item.id);
              lastError = `Dropped "${item.label}" after ${MAX_ATTEMPTS} failed retries: ${errMsg}`;
            } else {
              const delay =
                BACKOFF_SCHEDULE_MS[Math.min(nextAttempts, BACKOFF_SCHEDULE_MS.length - 1)];
              await saveOutboxItem({
                ...item,
                attempts: nextAttempts,
                nextRetryAt: Date.now() + delay,
                lastError: errMsg,
              });
              lastError = errMsg;
            }
          }
        } else if (item.kind === 'firestore_mutation') {
          if (!handlers.onReplayFirestoreMutation) {
            continue;
          }
          const ok = await handlers.onReplayFirestoreMutation(item);
          if (ok) {
            await removeOutboxItem(item.id);
            succeeded += 1;
          } else {
            const nextAttempts = item.attempts + 1;
            if (nextAttempts >= MAX_ATTEMPTS) {
              await removeOutboxItem(item.id);
              lastError = `Dropped cloud sync "${item.label}" after ${MAX_ATTEMPTS} retries.`;
            } else {
              const delay =
                BACKOFF_SCHEDULE_MS[Math.min(nextAttempts, BACKOFF_SCHEDULE_MS.length - 1)];
              await saveOutboxItem({
                ...item,
                attempts: nextAttempts,
                nextRetryAt: Date.now() + delay,
                lastError: 'Firestore mutation deferred',
              });
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Network error';
        const nextAttempts = item.attempts + 1;
        const delay = BACKOFF_SCHEDULE_MS[Math.min(nextAttempts, BACKOFF_SCHEDULE_MS.length - 1)];
        await saveOutboxItem({
          ...item,
          attempts: nextAttempts,
          nextRetryAt: Date.now() + delay,
          lastError: errMsg,
        });
        lastError = errMsg;
      }
    }

    const remainingItems = await loadOutboxItems();
    emitStatus({
      pendingCount: remainingItems.length,
      syncing: false,
      lastSyncedAt: succeeded > 0 || remainingItems.length === 0 ? Date.now() : currentStatus.lastSyncedAt,
      lastError,
    });
    return { processed, succeeded, remaining: remainingItems.length };
  } finally {
    isFlushing = false;
    emitStatus({ syncing: false });
  }
}
