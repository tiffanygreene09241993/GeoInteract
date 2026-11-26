import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Building2,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  History,
  RefreshCw,
  Trash2,
  X,
  AlertTriangle,
} from 'lucide-react';
import {
  CollaboratorMember,
  EnterpriseAuditEntry,
  SmartSyncStatus,
  SyncOutboxItem,
  TripAlert,
  TripGeofence,
  TripStop,
} from '../types/travel';
import { authFetch } from '../utils/authFetch';
import { triggerHaptic } from '../utils/haptics';
import { loadOutboxItems, removeOutboxItem } from '../utils/offlineStorage';
import { refreshSyncStatus } from '../utils/offlineSync';
import { sanitizeExternalUrl } from '../utils/url';

interface FieldOpsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'audit' | 'outbox' | 'activity';
  isOffline: boolean;
  smartSync: SmartSyncStatus;
  onSyncNow: () => Promise<void>;
  stops: TripStop[];
  geofences: TripGeofence[];
  alerts: TripAlert[];
  members: CollaboratorMember[];
  currentUserUid?: string;
}

type ConsoleTab = 'audit' | 'outbox' | 'activity';

interface ActivityEvent {
  id: string;
  timestamp: number;
  kind: 'stop' | 'geofence' | 'alert';
  title: string;
  detail: string;
  actor: string;
}

export const FieldOpsDrawer: React.FC<FieldOpsDrawerProps> = ({
  isOpen,
  onClose,
  initialTab = 'audit',
  isOffline,
  smartSync,
  onSyncNow,
  stops,
  geofences,
  alerts,
  members,
  currentUserUid,
}) => {
  const [tab, setTab] = useState<ConsoleTab>(initialTab);
  const [auditEntries, setAuditEntries] = useState<EnterpriseAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [outboxItems, setOutboxItems] = useState<SyncOutboxItem[]>([]);
  const [outboxLoading, setOutboxLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTab(initialTab);
    }
  }, [isOpen, initialTab]);

  const loadAudit = useCallback(async () => {
    if (isOffline) {
      setAuditError('Offline mode active · Audit trail resumes when reconnected.');
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await authFetch('/api/enterprise/audit');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && data?.authRequired) {
          setAuditError('Sign in with Google to inspect the Enterprise Audit Trail.');
        } else {
          setAuditError(data?.error || 'Could not load audit trail.');
        }
        return;
      }
      setAuditEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Unable to reach audit endpoint.');
    } finally {
      setAuditLoading(false);
    }
  }, [isOffline]);

  const loadOutbox = useCallback(async () => {
    setOutboxLoading(true);
    try {
      const items = await loadOutboxItems();
      setOutboxItems(items);
    } finally {
      setOutboxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadOutbox();
    if (tab === 'audit') {
      void loadAudit();
    }
  }, [isOpen, tab, loadAudit, loadOutbox, smartSync.pendingCount]);

  const memberNameByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.uid, m.displayName);
    }
    return map;
  }, [members]);

  const resolveActor = useCallback(
    (uid?: string) => {
      if (!uid || uid === 'local_explorer') return 'You (Local Vault)';
      if (currentUserUid && uid === currentUserUid) return 'You';
      return memberNameByUid.get(uid) || 'Collaborator';
    },
    [currentUserUid, memberNameByUid]
  );

  const activityFeed = useMemo<ActivityEvent[]>(() => {
    const events: ActivityEvent[] = [];
    for (const s of stops) {
      events.push({
        id: `stop_${s.id}`,
        timestamp: s.updatedAt || Date.now(),
        kind: 'stop',
        title: s.name,
        detail: `Day ${s.dayIndex + 1} · #${s.orderIndex + 1} · ${s.status}${
          s.timeWindow ? ` · ${s.timeWindow}` : ''
        }`,
        actor: resolveActor(s.createdBy),
      });
    }
    for (const gf of geofences) {
      events.push({
        id: `gf_${gf.id}`,
        timestamp: gf.updatedAt || Date.now(),
        kind: 'geofence',
        title: `Geofence: ${gf.label}`,
        detail: `${gf.radiusMeters}m · ${gf.triggerOn} · ${gf.active ? 'Armed' : 'Paused'}${
          gf.linkedStopId ? ' · Auto-Pilot linked' : ''
        }`,
        actor: resolveActor(gf.createdBy),
      });
    }
    for (const a of alerts.slice(0, 20)) {
      events.push({
        id: `alert_${a.id}`,
        timestamp: a.createdAt || Date.now(),
        kind: 'alert',
        title: a.title,
        detail: `${a.category} · ${a.severity.replace(/_/g, ' ')}`,
        actor: 'GeoInteract Radar',
      });
    }
    return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
  }, [stops, geofences, alerts, resolveActor]);

  const handleDiscardOutbox = async (id: string) => {
    triggerHaptic('medium');
    await removeOutboxItem(id);
    await refreshSyncStatus();
    await loadOutbox();
  };

  const handleRetryOutbox = async () => {
    triggerHaptic('medium');
    await onSyncNow();
    await loadOutbox();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="field-ops-title"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="field-ops-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate"
              >
                GeoInteract Field Ops &amp; Sync Console
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                Live enterprise audit trail, offline outbox queue &amp; encrypted trip attribution
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            aria-label="Close Field Ops Console"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Strip */}
        <div className="px-5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 dark:bg-[#0B0F17]/60">
          <div
            role="tablist"
            aria-label="Field Ops sections"
            className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'audit'}
              onClick={() => {
                triggerHaptic('light');
                setTab('audit');
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap min-h-[34px] transition-colors ${
                tab === 'audit'
                  ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 shrink-0" />
              <span>Audit Trail ({auditEntries.length})</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'outbox'}
              onClick={() => {
                triggerHaptic('light');
                setTab('outbox');
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap min-h-[34px] transition-colors tabular-nums ${
                tab === 'outbox'
                  ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <CloudUpload className="w-3.5 h-3.5 shrink-0" />
              <span>Sync Outbox ({outboxItems.length})</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === 'activity'}
              onClick={() => {
                triggerHaptic('light');
                setTab('activity');
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap min-h-[34px] transition-colors tabular-nums ${
                tab === 'activity'
                  ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <History className="w-3.5 h-3.5 shrink-0" />
              <span>Trip Activity ({activityFeed.length})</span>
            </button>
          </div>

          {tab === 'audit' && (
            <button
              type="button"
              disabled={auditLoading || isOffline}
              onClick={() => {
                triggerHaptic('light');
                void loadAudit();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-45 min-h-[34px] whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${auditLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          )}

          {tab === 'outbox' && (
            <button
              type="button"
              disabled={isOffline || smartSync.syncing || outboxItems.length === 0}
              onClick={() => void handleRetryOutbox()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-45 min-h-[34px] whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${smartSync.syncing ? 'animate-spin' : ''}`} />
              <span>{smartSync.syncing ? 'Syncing...' : 'Retry All Now'}</span>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'audit' && (
            <div className="space-y-3">
              {auditError && (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{auditError}</span>
                </div>
              )}

              {!auditLoading && auditEntries.length === 0 && !auditError ? (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center space-y-1">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    No enterprise audit events recorded yet
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Geofence check-ins, check-outs, and escalated travel alerts appear here with actor attribution and record links.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
                  {auditEntries.map((entry) => (
                    <div key={entry.id} className="py-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`font-semibold ${
                              entry.ok
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-500 dark:text-rose-400'
                            }`}
                          >
                            {entry.ok ? 'Delivered' : 'Partial / Failed'}
                          </span>
                          <span className="text-slate-400">·</span>
                          <span className="text-slate-600 dark:text-slate-300 capitalize">
                            {entry.eventType.replace(/_/g, ' ')}
                          </span>
                          {entry.deduplicated && (
                            <>
                              <span className="text-slate-400">·</span>
                              <span className="text-sky-600 dark:text-sky-400">Deduplicated</span>
                            </>
                          )}
                        </div>
                        <span className="text-slate-400 font-mono tabular-nums shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>

                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {entry.title}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>Actor: {entry.actorEmail || entry.actorUid}</span>
                        {entry.results.map((r, rIdx) => (
                          <React.Fragment key={`${entry.id}_${r.target}_${rIdx}`}>
                            <span>·</span>
                            {r.ok && sanitizeExternalUrl(r.recordUrl) ? (
                              <a
                                href={sanitizeExternalUrl(r.recordUrl)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400 hover:underline capitalize"
                              >
                                <span>
                                  {r.target} {r.recordId || 'OK'}
                                  {r.updatedExisting ? ' (updated)' : ''}
                                </span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span
                                className={
                                  r.ok
                                    ? 'text-emerald-600 dark:text-emerald-400 capitalize'
                                    : 'text-rose-500 dark:text-rose-400 capitalize'
                                }
                              >
                                {r.target}: {r.ok ? r.recordId || 'OK' : r.error || 'Error'}
                              </span>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'outbox' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                <span>
                  {smartSync.lastSyncedAt
                    ? `Last synced ${new Date(smartSync.lastSyncedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : 'Waiting for next sync window'}
                </span>
                {smartSync.lastError && (
                  <span className="text-amber-600 dark:text-amber-400 truncate">
                    {smartSync.lastError}
                  </span>
                )}
              </div>

              {!outboxLoading && outboxItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center space-y-1.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 mx-auto" />
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    Offline outbox is empty
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    All encrypted Firestore mutations and enterprise check-ins are up to date.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
                  {outboxItems.map((item) => {
                    const retryInSec = Math.max(
                      0,
                      Math.round((item.nextRetryAt - Date.now()) / 1000)
                    );
                    return (
                      <div
                        key={item.id}
                        className="py-3 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {item.label}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                            <span className="capitalize">{item.kind.replace(/_/g, ' ')}</span>
                            <span>·</span>
                            <span>
                              {item.attempts} attempt{item.attempts === 1 ? '' : 's'}
                            </span>
                            <span>·</span>
                            <span>
                              {retryInSec > 0 ? `Retry in ${retryInSec}s` : 'Ready to flush'}
                            </span>
                          </div>
                          {item.lastError && (
                            <p className="text-xs text-rose-500 dark:text-rose-400">
                              {item.lastError}
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleDiscardOutbox(item.id)}
                          aria-label={`Discard queued item ${item.label}`}
                          className="p-2 rounded-lg text-slate-400 hover:text-rose-500 min-h-[38px] min-w-[38px] flex items-center justify-center shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'activity' && (
            <div className="space-y-2">
              {activityFeed.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                  No trip activity recorded yet. Add stops, geofences, or run an alert scan to see attributed updates here.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
                  {activityFeed.map((ev) => (
                    <div key={ev.id} className="py-2.5 flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {ev.title}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          <span>{ev.detail}</span>
                          <span> · </span>
                          <span className="text-slate-700 dark:text-slate-300">{ev.actor}</span>
                        </div>
                      </div>
                      <span className="text-xs font-mono tabular-nums text-slate-400 shrink-0">
                        {new Date(ev.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
