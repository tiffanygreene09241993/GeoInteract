import React, { useState } from 'react';
import {
  Activity,
  Bell,
  Building2,
  Check,
  ExternalLink,
  Filter,
  Map as MapIcon,
  Route,
  ShieldCheck,
  X,
} from 'lucide-react';
import { DisruptionRecoveryPlan, TripAlert, UserPreferences } from '../types/travel';
import { triggerHaptic } from '../utils/haptics';
import { sanitizeExternalUrl } from '../utils/url';

interface AlertsPanelProps {
  alerts: TripAlert[];
  prefs: UserPreferences;
  hasEnterpriseLogTarget: boolean;
  activeDayStopCount: number;
  isOffline: boolean;
  activeRecoveryPlan: DisruptionRecoveryPlan | null;
  onPlanRecovery: (alert: TripAlert) => Promise<DisruptionRecoveryPlan | null>;
  onPreviewRecoveryOnMap: (plan: DisruptionRecoveryPlan) => void;
  onApplyRecoveryPlan: (plan: DisruptionRecoveryPlan, escalateToEnterprise: boolean) => Promise<void>;
  onDismissRecoveryPlan: () => void;
  onLogAlertToEnterprise: (alert: TripAlert) => Promise<void>;
  onOpenPreferences: () => void;
  onOpenFieldOps: () => void;
}

export const AlertsPanel: React.FC<AlertsPanelProps> = ({
  alerts,
  prefs,
  hasEnterpriseLogTarget,
  activeDayStopCount,
  isOffline,
  activeRecoveryPlan,
  onPlanRecovery,
  onPreviewRecoveryOnMap,
  onApplyRecoveryPlan,
  onDismissRecoveryPlan,
  onLogAlertToEnterprise,
  onOpenPreferences,
  onOpenFieldOps,
}) => {
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [loggingAlertId, setLoggingAlertId] = useState<string | null>(null);
  const [planningAlertId, setPlanningAlertId] = useState<string | null>(null);
  const [applyingPlanId, setApplyingPlanId] = useState<string | null>(null);
  const [escalateEnterprise, setEscalateEnterprise] = useState(false);

  const visibleAlerts = showSuppressed
    ? alerts
    : alerts.filter((a) => !a.suppressed && a.severity !== 'minor');
  const suppressedCount = alerts.filter((a) => a.suppressed || a.severity === 'minor').length;

  const handleLogAlert = async (alert: TripAlert) => {
    if (!hasEnterpriseLogTarget) {
      onOpenPreferences();
      return;
    }
    triggerHaptic('medium');
    setLoggingAlertId(alert.id);
    try {
      await onLogAlertToEnterprise(alert);
    } finally {
      setLoggingAlertId(null);
    }
  };

  const handlePlanRecoveryClick = async (alert: TripAlert) => {
    if (isOffline || planningAlertId) return;
    triggerHaptic('medium');
    setPlanningAlertId(alert.id);
    try {
      await onPlanRecovery(alert);
    } finally {
      setPlanningAlertId(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto px-4 py-3 space-y-4">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] p-3.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-emerald-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Smart Alert Triage
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onOpenFieldOps();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 min-h-[34px] whitespace-nowrap"
            >
              <Activity className="w-3.5 h-3.5 text-sky-500" />
              Ops &amp; Audit
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onOpenPreferences();
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[34px] whitespace-nowrap"
            >
              <Filter className="w-3.5 h-3.5" />
              Filter Rules
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          {prefs.suppressMinorAlerts
            ? `Minor edits that don't affect your schedule are muted (${suppressedCount} quietly logged). Only impactful changes and last-minute alerts notify you.`
            : 'All itinerary and travel alerts are active.'}
        </p>

        {suppressedCount > 0 && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setShowSuppressed((v) => !v);
            }}
            className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
          >
            {showSuppressed
              ? 'Hide suppressed minor edits'
              : `View ${suppressedCount} suppressed minor update${suppressedCount === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {visibleAlerts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center space-y-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500 mx-auto" />
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Schedule is clear
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No schedule-impacting disruptions or geofence alerts triggered yet.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 pb-4">
          {visibleAlerts.map((alert) => {
            const isCritical = alert.severity === 'last_minute_alert';
            const isImpact = alert.severity === 'schedule_impact';
            const isMinor = alert.severity === 'minor' || alert.suppressed;
            const isHighSeverity = isCritical || isImpact;
            const matchingPlan =
              activeRecoveryPlan && activeRecoveryPlan.alertId === alert.id
                ? activeRecoveryPlan
                : null;

            return (
              <div
                key={alert.id}
                className={`rounded-xl border p-3 space-y-2 ${
                  isCritical
                    ? 'border-rose-500/45 bg-rose-500/10'
                    : isImpact
                    ? 'border-amber-500/45 bg-amber-500/10'
                    : isMinor
                    ? 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0E1420] opacity-75'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span
                    className={`font-semibold ${
                      isCritical
                        ? 'text-rose-500'
                        : isImpact
                        ? 'text-amber-500'
                        : isMinor
                        ? 'text-slate-400'
                        : 'text-emerald-500'
                    }`}
                  >
                    {isCritical
                      ? 'Last-Minute Alert'
                      : isImpact
                      ? 'Schedule Impact'
                      : isMinor
                      ? 'Minor (Muted)'
                      : 'Notification'}
                  </span>
                  <span className="text-slate-400 font-mono tabular-nums">
                    {new Date(alert.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {alert.title}
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {alert.body}
                </p>

                {alert.enterpriseLinks && alert.enterpriseLinks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5 text-[11px] text-sky-600 dark:text-sky-400">
                    <Building2 className="w-3 h-3 shrink-0" />
                    {alert.enterpriseLinks.map((link, lIdx) => {
                      const safeUrl = sanitizeExternalUrl(link.recordUrl);
                      return safeUrl ? (
                        <a
                          key={`${link.target}_${link.recordId}_${lIdx}`}
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 hover:underline capitalize"
                        >
                          <span>
                            {link.target} {link.recordId}
                          </span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      ) : (
                        <span key={`${link.target}_${link.recordId}_${lIdx}`} className="capitalize">
                          {link.target} {link.recordId}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  {sanitizeExternalUrl(alert.sourceUri) ? (
                    <a
                      href={sanitizeExternalUrl(alert.sourceUri)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Source
                    </a>
                  ) : (
                    <span />
                  )}

                  {isHighSeverity && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {activeDayStopCount > 0 && (
                        <button
                          type="button"
                          disabled={isOffline || planningAlertId === alert.id}
                          onClick={() => void handlePlanRecoveryClick(alert)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-500/45 bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-500/25 disabled:opacity-45 min-h-[34px] whitespace-nowrap"
                        >
                          <Route className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            {planningAlertId === alert.id ? 'Planning...' : 'Plan Recovery'}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={loggingAlertId === alert.id}
                        onClick={() => void handleLogAlert(alert)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-50 min-h-[34px] whitespace-nowrap"
                      >
                        <Building2 className="w-3 h-3 text-sky-500" />
                        {loggingAlertId === alert.id
                          ? 'Logging...'
                          : hasEnterpriseLogTarget
                          ? 'Log to Enterprise'
                          : 'Connect Enterprise'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Inline Recovery Plan Preview Section (flat divider, no nested card) */}
                {matchingPlan && (
                  <div className="pt-2.5 mt-2 border-t border-amber-500/30 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-amber-800 dark:text-amber-300 tabular-nums">
                          Recovery Plan · Day {matchingPlan.dayIndex + 1}
                          {matchingPlan.estimatedDelayAvoidedMinutes > 0
                            ? ` · Est. ${matchingPlan.estimatedDelayAvoidedMinutes} min saved`
                            : ''}
                        </div>
                        <p className="text-xs text-slate-700 dark:text-slate-200 mt-0.5 leading-snug">
                          {matchingPlan.summary}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onDismissRecoveryPlan();
                        }}
                        aria-label="Dismiss recovery plan"
                        className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {matchingPlan.replacements.length > 0 && (
                      <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                        {matchingPlan.replacements.map((rep, rIdx) => (
                          <div key={`${rep.placeId}_${rIdx}`} className="leading-snug">
                            <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                              R{rIdx + 1}
                            </span>{' '}
                            {rep.replacesStopName ? `${rep.replacesStopName} → ` : ''}
                            <strong className="font-semibold text-slate-900 dark:text-slate-100">
                              {rep.name}
                            </strong>
                            {typeof rep.rating === 'number' ? ` (★ ${rep.rating.toFixed(1)})` : ''}
                            {rep.reason ? ` · ${rep.reason}` : ''}
                          </div>
                        ))}
                      </div>
                    )}

                    {hasEnterpriseLogTarget && (
                      <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={escalateEnterprise}
                          onChange={(e) => setEscalateEnterprise(e.target.checked)}
                          className="w-4 h-4 rounded accent-amber-500"
                        />
                        <span>Post reschedule note to linked Enterprise connectors</span>
                      </label>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onPreviewRecoveryOnMap(matchingPlan);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/45 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 min-h-[36px] whitespace-nowrap"
                      >
                        <MapIcon className="w-3.5 h-3.5" />
                        Preview in Map View
                      </button>

                      <button
                        type="button"
                        disabled={applyingPlanId === matchingPlan.id}
                        onClick={async () => {
                          triggerHaptic('medium');
                          setApplyingPlanId(matchingPlan.id);
                          try {
                            await onApplyRecoveryPlan(matchingPlan, escalateEnterprise);
                          } finally {
                            setApplyingPlanId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-50 min-h-[36px] whitespace-nowrap"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {applyingPlanId === matchingPlan.id ? 'Applying...' : 'Apply Plan'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

