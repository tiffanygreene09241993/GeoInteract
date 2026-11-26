import React, { useState } from 'react';
import {
  Activity,
  Bell,
  Building2,
  CloudUpload,
  Lock,
  LogIn,
  Moon,
  Navigation,
  RefreshCw,
  Send,
  Sliders,
  Smartphone,
  Sparkles,
  Sun,
  WifiOff,
  X,
} from 'lucide-react';
import {
  EnterpriseConnectorId,
  EnterpriseConnectorStatus,
  EnterpriseLogResult,
  EnterprisePreferences,
  SmartSyncStatus,
  TravelMode,
  UserPreferences,
} from '../types/travel';
import { triggerHaptic } from '../utils/haptics';
import { requestBrowserNotificationPermission } from '../utils/notifications';

interface PreferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
  prefs: UserPreferences;
  onUpdatePrefs: (patch: Partial<UserPreferences>) => Promise<void>;
  isSignedIn: boolean;
  onSignIn: () => Promise<void>;
  smartSync: SmartSyncStatus;
  onSyncNow: () => Promise<void>;
  enterpriseStatus: EnterpriseConnectorStatus;
  enterprisePrefs: EnterprisePreferences;
  enterpriseCounts: { jira: number; salesforce: number };
  enterpriseLoading: { jira: boolean; salesforce: boolean };
  enterpriseError: string | null;
  onUpdateEnterprisePrefs: (patch: Partial<EnterprisePreferences>) => void;
  onRefreshEnterpriseStatus: () => Promise<void>;
  onSyncEnterpriseLayer: (source: 'jira' | 'salesforce') => Promise<void>;
  onSendTestEnterpriseLog: () => Promise<EnterpriseLogResult[]>;
  onOpenFieldOps?: () => void;
}

const CONNECTOR_META: Array<{
  id: EnterpriseConnectorId;
  name: string;
  envSummary: string;
  capabilities: string;
}> = [
  {
    id: 'jira',
    name: 'Jira Enterprise',
    envSummary: 'JIRA_BASE_URL · JIRA_EMAIL · JIRA_API_TOKEN',
    capabilities: 'Geocoded issue pins, check-in tasks & issue comments',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    envSummary: 'SF_INSTANCE_URL · SF_ACCESS_TOKEN',
    capabilities: 'Geocoded Account pins, check-in Tasks & alert Cases',
  },
  {
    id: 'servicenow',
    name: 'ServiceNow',
    envSummary: 'SERVICENOW_INSTANCE_URL · SERVICENOW_API_TOKEN',
    capabilities: 'Check-in & high-severity travel alert Incidents',
  },
];

const ToggleRow: React.FC<{
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (val: boolean) => void;
}> = ({ label, description, checked, disabled = false, onChange }) => (
  <label
    className={`flex items-start justify-between gap-3 py-2 ${
      disabled ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer'
    }`}
  >
    <div className="min-w-0">
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 leading-snug">{description}</div>
    </div>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => {
        triggerHaptic('light');
        onChange(e.target.checked);
      }}
      className="mt-1 w-5 h-5 rounded accent-emerald-500 shrink-0 cursor-pointer disabled:cursor-not-allowed"
    />
  </label>
);

export const PreferencesModal: React.FC<PreferencesModalProps> = ({
  isOpen,
  onClose,
  prefs,
  onUpdatePrefs,
  isSignedIn,
  onSignIn,
  smartSync,
  onSyncNow,
  enterpriseStatus,
  enterprisePrefs,
  enterpriseCounts,
  enterpriseLoading,
  enterpriseError,
  onUpdateEnterprisePrefs,
  onRefreshEnterpriseStatus,
  onSyncEnterpriseLayer,
  onSendTestEnterpriseLog,
  onOpenFieldOps,
}) => {
  const [permStatus, setPermStatus] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [testingLog, setTestingLog] = useState(false);
  const [testLogResults, setTestLogResults] = useState<EnterpriseLogResult[] | null>(null);

  if (!isOpen) return null;

  const handleRequestNotifications = async () => {
    triggerHaptic('medium');
    const result = await requestBrowserNotificationPermission();
    setPermStatus(result);
  };

  const handleRefreshStatus = async () => {
    triggerHaptic('light');
    setRefreshingStatus(true);
    try {
      await onRefreshEnterpriseStatus();
    } finally {
      setRefreshingStatus(false);
    }
  };

  const handleToggleTarget = (target: EnterpriseConnectorId) => {
    triggerHaptic('light');
    const exists = enterprisePrefs.logTargets.includes(target);
    const nextTargets = exists
      ? enterprisePrefs.logTargets.filter((t) => t !== target)
      : [...enterprisePrefs.logTargets, target];
    onUpdateEnterprisePrefs({ logTargets: nextTargets });
  };

  const configuredSelectedTargets = enterprisePrefs.logTargets.filter((t) => enterpriseStatus[t]);

  const handleTestLog = async () => {
    if (testingLog || configuredSelectedTargets.length === 0) return;
    triggerHaptic('medium');
    setTestingLog(true);
    setTestLogResults(null);
    try {
      const results = await onSendTestEnterpriseLog();
      setTestLogResults(results);
    } finally {
      setTestingLog(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] shadow-2xl overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-200">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2
                id="prefs-modal-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100"
              >
                Explorer &amp; Alert Preferences
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Theme, haptics, offline routing, alerts &amp; enterprise connectors
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            aria-label="Close preferences"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 divide-y divide-slate-200 dark:divide-slate-800">
          {/* Appearance & Device */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Display &amp; Tactile Experience
              </span>
              <div className="flex items-center gap-1 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-[#0B0F17]">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    void onUpdatePrefs({ theme: 'dark' });
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                    prefs.theme === 'dark'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                  Dark
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    void onUpdatePrefs({ theme: 'light' });
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                    prefs.theme === 'light'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  Light
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-start gap-2.5 min-w-0">
                <Smartphone className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Haptic Feedback (iOS &amp; Android)
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Tactile response on pin drops, geofences &amp; route actions
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => triggerHaptic('success')}
                  className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 min-h-[34px]"
                >
                  Test
                </button>
                <input
                  type="checkbox"
                  checked={prefs.hapticsEnabled}
                  onChange={(e) => void onUpdatePrefs({ hapticsEnabled: e.target.checked })}
                  className="w-5 h-5 rounded accent-emerald-500 cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 pt-1">
              <div className="flex items-start gap-2.5 min-w-0">
                <WifiOff className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Remote Offline Mode
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Force cached vector grid &amp; offline corridor routing for low-signal regions
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={prefs.offlineModePreferred}
                onChange={(e) => {
                  triggerHaptic('medium');
                  void onUpdatePrefs({ offlineModePreferred: e.target.checked });
                }}
                className="mt-1 w-5 h-5 rounded accent-amber-500 shrink-0 cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-start gap-2.5 min-w-0">
                <CloudUpload className="w-4 h-4 text-sky-500 mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                    Smart Offline Sync · {smartSync.pendingCount} queued
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {smartSync.lastSyncedAt
                      ? `Last synced ${new Date(smartSync.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Encrypted local vault active`
                      : 'Queues offline edits & enterprise logs with automatic backoff retry'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {onOpenFieldOps && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      onClose();
                      onOpenFieldOps();
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 min-h-[34px] whitespace-nowrap"
                  >
                    <Activity className="w-3.5 h-3.5 text-sky-500" />
                    <span>Inspect Queue</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={smartSync.syncing || smartSync.pendingCount === 0}
                  onClick={() => {
                    triggerHaptic('light');
                    void onSyncNow();
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-45 min-h-[34px] whitespace-nowrap"
                >
                  {smartSync.syncing ? 'Syncing...' : 'Sync Now'}
                </button>
              </div>
            </div>
          </section>

          {/* Routing & Priority */}
          <section className="pt-4 space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <Navigation className="w-3.5 h-3.5 text-sky-500" />
              <span>Routing &amp; Itinerary Highlights</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="pref-travel-mode"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
                >
                  Default Travel Mode
                </label>
                <select
                  id="pref-travel-mode"
                  value={prefs.travelMode}
                  onChange={(e) =>
                    void onUpdatePrefs({ travelMode: e.target.value as TravelMode })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
                >
                  <option value="WALKING">Walking</option>
                  <option value="TRANSIT">Public Transit</option>
                  <option value="BICYCLING">Cycling</option>
                  <option value="DRIVING">Driving</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="pref-interests"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
                >
                  Explorer Interests
                </label>
                <input
                  id="pref-interests"
                  type="text"
                  value={prefs.interests}
                  onChange={(e) => void onUpdatePrefs({ interests: e.target.value })}
                  placeholder="coffee, architecture, trails..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
                />
              </div>
            </div>

            <ToggleRow
              label="Automatically Highlight Normal-Priority Tasks"
              description="Visually elevates Normal priority stops in warm amber across both the map pins and itinerary dashboard."
              checked={prefs.highlightNormalTasks}
              onChange={(val) => void onUpdatePrefs({ highlightNormalTasks: val })}
            />
            <ToggleRow
              label="Eco-Friendly Routing"
              description="Prefer lower-emission corridors when computing vehicle routes."
              checked={prefs.ecoRouting}
              onChange={(val) => void onUpdatePrefs({ ecoRouting: val })}
            />
            <ToggleRow
              label="Avoid Toll Roads"
              description="Exclude toll routes during driving navigation."
              checked={prefs.avoidTolls}
              onChange={(val) => void onUpdatePrefs({ avoidTolls: val })}
            />
          </section>

          {/* Smart Notification Filters */}
          <section className="pt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <Bell className="w-3.5 h-3.5 text-emerald-500" />
                <span>Smart Push Notification Filters</span>
              </div>
              <button
                type="button"
                onClick={() => void handleRequestNotifications()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[34px] whitespace-nowrap"
              >
                <Sparkles className="w-3 h-3 text-emerald-500" />
                {permStatus === 'granted'
                  ? 'Push Enabled'
                  : permStatus === 'denied'
                  ? 'Push Blocked'
                  : 'Enable Push'}
              </button>
            </div>

            <ToggleRow
              label="Suppress Minor Changes (Recommended)"
              description="Automatically mutes minor stop edits or <10 min notes that do not impact your overall schedule."
              checked={prefs.suppressMinorAlerts}
              onChange={(val) => void onUpdatePrefs({ suppressMinorAlerts: val })}
            />
            <ToggleRow
              label="Schedule-Impacting Updates"
              description="Notify on delays >15 min, venue closures, or significant schedule shifts."
              checked={prefs.notifyScheduleImpact}
              onChange={(val) => void onUpdatePrefs({ notifyScheduleImpact: val })}
            />
            <ToggleRow
              label="Last-Minute Travel Alerts"
              description="High-priority alerts for sudden transit disruptions or severe weather."
              checked={prefs.notifyLastMinuteAlerts}
              onChange={(val) => void onUpdatePrefs({ notifyLastMinuteAlerts: val })}
            />
            <ToggleRow
              label="Geofence Proximity Alerts"
              description="Trigger tactile + push notifications when entering or leaving configured zones."
              checked={prefs.notifyGeofence}
              onChange={(val) => void onUpdatePrefs({ notifyGeofence: val })}
            />
            <ToggleRow
              label="Group Collaborator Updates"
              description="Notify when linked travel companions add new itinerary stops."
              checked={prefs.notifyCollab}
              onChange={(val) => void onUpdatePrefs({ notifyCollab: val })}
            />
          </section>

          {/* Enterprise Connectors */}
          <section className="pt-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <Building2 className="w-3.5 h-3.5 text-sky-500" />
                <span>Enterprise Connectors</span>
              </div>
              <div className="flex items-center gap-1.5">
                {onOpenFieldOps && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      onClose();
                      onOpenFieldOps();
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 min-h-[34px] whitespace-nowrap"
                  >
                    <Activity className="w-3 h-3 text-sky-500" />
                    Audit Trail
                  </button>
                )}
                <button
                  type="button"
                  disabled={refreshingStatus}
                  onClick={() => void handleRefreshStatus()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-50 min-h-[34px] whitespace-nowrap"
                >
                  <RefreshCw className={`w-3 h-3 ${refreshingStatus ? 'animate-spin' : ''}`} />
                  Refresh Status
                </button>
              </div>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Credentials are configured exclusively on the server via Secrets / environment variables. Connected systems can render geocoded map layers and receive geofence check-ins or travel alert logs.
            </p>

            {enterpriseStatus.authRequired && !isSignedIn && (
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 flex items-center justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0">
                  <Lock className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-slate-700 dark:text-slate-200 leading-snug">
                    Enterprise endpoints require a verified Google Sign-In session token.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onSignIn()}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 whitespace-nowrap shrink-0 min-h-[36px]"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign In
                </button>
              </div>
            )}

            {/* Server Connector Availability Roster (Zero-Pill Clean Rows) */}
            <div className="divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
              {CONNECTOR_META.map((item) => {
                const configured = enterpriseStatus[item.id];
                const isLayerSource = item.id === 'jira' || item.id === 'salesforce';
                const pinCount = item.id === 'jira' ? enterpriseCounts.jira : enterpriseCounts.salesforce;
                const isLoadingLayer =
                  item.id === 'jira'
                    ? enterpriseLoading.jira
                    : item.id === 'salesforce'
                    ? enterpriseLoading.salesforce
                    : false;

                return (
                  <div key={item.id} className="py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                        <span>{item.name}</span>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            configured
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {configured ? 'Connected' : 'Not configured'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {item.capabilities}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
                        {item.envSummary}
                      </div>
                    </div>

                    {isLayerSource && configured && (
                      <button
                        type="button"
                        disabled={isLoadingLayer}
                        onClick={() => {
                          triggerHaptic('light');
                          void onSyncEnterpriseLayer(item.id as 'jira' | 'salesforce');
                        }}
                        className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-50 min-h-[36px] whitespace-nowrap shrink-0 tabular-nums"
                      >
                        {isLoadingLayer ? 'Syncing...' : `Sync (${pinCount})`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {enterpriseError && (
              <p className="text-xs text-rose-500 dark:text-rose-400">{enterpriseError}</p>
            )}

            {/* Map Layer Toggles */}
            <div className="space-y-1">
              <ToggleRow
                label="Show Jira Issues Map Layer"
                description={
                  enterpriseStatus.jira
                    ? 'Plots geocoded open Jira issues as interactive indigo pins on the map.'
                    : 'Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN on the server to enable.'
                }
                checked={enterprisePrefs.showJiraLayer}
                disabled={!enterpriseStatus.jira}
                onChange={(val) => onUpdateEnterprisePrefs({ showJiraLayer: val })}
              />
              <ToggleRow
                label="Show Salesforce Accounts Map Layer"
                description={
                  enterpriseStatus.salesforce
                    ? 'Plots geocoded Salesforce Accounts as interactive blue pins on the map.'
                    : 'Set SF_INSTANCE_URL and SF_ACCESS_TOKEN on the server to enable.'
                }
                checked={enterprisePrefs.showSalesforceLayer}
                disabled={!enterpriseStatus.salesforce}
                onChange={(val) => onUpdateEnterprisePrefs({ showSalesforceLayer: val })}
              />
            </div>

            {/* Automated Event Logging */}
            <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <ToggleRow
                label="Auto-Log Geofence Enter/Exit Check-Ins"
                description="Records arrival and departure events to your selected enterprise targets when geofences fire."
                checked={enterprisePrefs.autoLogGeofenceCheckins}
                onChange={(val) => onUpdateEnterprisePrefs({ autoLogGeofenceCheckins: val })}
              />
              <ToggleRow
                label="Auto-Log High-Severity Travel Alerts"
                description="Escalates last-minute and schedule-impact alerts automatically to selected connectors."
                checked={enterprisePrefs.autoLogHighSeverityAlerts}
                onChange={(val) => onUpdateEnterprisePrefs({ autoLogHighSeverityAlerts: val })}
              />

              <div className="space-y-1.5 pt-1">
                <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  Logging Destination Connectors
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['jira', 'salesforce', 'servicenow'] as const).map((target) => {
                    const selected = enterprisePrefs.logTargets.includes(target);
                    const configured = enterpriseStatus[target];
                    const label =
                      target === 'jira'
                        ? 'Jira Enterprise'
                        : target === 'salesforce'
                        ? 'Salesforce'
                        : 'ServiceNow';
                    return (
                      <button
                        key={target}
                        type="button"
                        onClick={() => handleToggleTarget(target)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors min-h-[38px] whitespace-nowrap ${
                          selected
                            ? 'bg-sky-500/15 border-sky-500/50 text-sky-700 dark:text-sky-300'
                            : 'bg-slate-50 dark:bg-[#0B0F17] border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {label}
                        {!configured ? ' (Unset)' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 items-end">
                <div>
                  <label
                    htmlFor="pref-jira-project"
                    className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
                  >
                    Default Jira Project Key (Optional)
                  </label>
                  <input
                    id="pref-jira-project"
                    type="text"
                    value={enterprisePrefs.jiraProjectKey}
                    onChange={(e) =>
                      onUpdateEnterprisePrefs({ jiraProjectKey: e.target.value.toUpperCase().slice(0, 24) })
                    }
                    placeholder="e.g., OPS or TRAVEL"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 min-h-[40px]"
                  />
                </div>

                <button
                  type="button"
                  disabled={testingLog || configuredSelectedTargets.length === 0}
                  onClick={() => void handleTestLog()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-2 text-xs font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity min-h-[40px] whitespace-nowrap"
                >
                  <Send className="w-3.5 h-3.5" />
                  {testingLog ? 'Logging Check-In...' : 'Send Test Check-In'}
                </button>
              </div>

              {testLogResults && testLogResults.length > 0 && (
                <div className="pt-1 space-y-1 text-xs">
                  {testLogResults.map((res) => (
                    <div
                      key={res.target}
                      className={
                        res.ok
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-500 dark:text-rose-400'
                      }
                    >
                      <span className="capitalize font-medium">{res.target}</span>
                      {' · '}
                      {res.ok ? `Logged (${res.recordId || 'OK'})` : res.error || 'Failed'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

