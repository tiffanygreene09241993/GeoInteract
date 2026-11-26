import React, { FormEvent, useMemo, useState } from 'react';
import { Building2, Compass, ExternalLink, MapPin, Plus, Radio, Sparkles, Trash2 } from 'lucide-react';
import { GeofenceTrigger, LatLng, TripGeofence, TripStop } from '../types/travel';
import { formatDistance, haversineDistanceMeters } from '../utils/geofence';
import { triggerHaptic } from '../utils/haptics';
import { sanitizeExternalUrl } from '../utils/url';

interface GeofencePanelProps {
  geofences: TripGeofence[];
  stops?: TripStop[];
  mapCenter: LatLng;
  userLocation: LatLng | null;
  gpsAccuracyMeters: number | null;
  gpsTrackingEnabled: boolean;
  simulateClickMode: boolean;
  hasEnterpriseLogTarget: boolean;
  onToggleGpsTracking: () => void;
  onToggleSimulateClickMode: () => void;
  onSimulatePosition: (pos: LatLng) => void;
  onAddGeofence: (input: {
    lat: number;
    lng: number;
    radiusMeters: number;
    triggerOn: GeofenceTrigger;
    label: string;
    alertMessage: string;
    linkedStopId?: string;
  }) => Promise<TripGeofence | null>;
  onAutoProvisionGeofences?: () => Promise<number>;
  onToggleGeofence: (id: string) => void;
  onRemoveGeofence: (id: string) => void;
  onLogGeofenceCheckIn: (gf: TripGeofence, event: 'enter' | 'exit') => Promise<void>;
  onOpenPreferences: () => void;
}

export const GeofencePanel: React.FC<GeofencePanelProps> = ({
  geofences,
  stops = [],
  mapCenter,
  userLocation,
  gpsAccuracyMeters,
  gpsTrackingEnabled,
  simulateClickMode,
  hasEnterpriseLogTarget,
  onToggleGpsTracking,
  onToggleSimulateClickMode,
  onSimulatePosition,
  onAddGeofence,
  onAutoProvisionGeofences,
  onToggleGeofence,
  onRemoveGeofence,
  onLogGeofenceCheckIn,
  onOpenPreferences,
}) => {
  const [loggingGfId, setLoggingGfId] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [label, setLabel] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [radiusMeters, setRadiusMeters] = useState(400);
  const [triggerOn, setTriggerOn] = useState<GeofenceTrigger>('both');

  const uncoveredStopCount = useMemo(() => {
    return stops.filter((st) => {
      if (st.status === 'completed' || st.status === 'skipped') return false;
      return !geofences.some(
        (gf) =>
          gf.linkedStopId === st.id ||
          haversineDistanceMeters({ lat: gf.lat, lng: gf.lng }, { lat: st.lat, lng: st.lng }) < 120
      );
    }).length;
  }, [stops, geofences]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    await onAddGeofence({
      lat: mapCenter.lat,
      lng: mapCenter.lng,
      radiusMeters,
      triggerOn,
      label: label.trim(),
      alertMessage: alertMessage.trim() || `Approaching ${label.trim()}`,
    });
    setLabel('');
    setAlertMessage('');
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto px-4 py-3 space-y-4">
      {/* Live GPS & Simulator Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Location &amp; Geofence Radar
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Accuracy-gated GPS with hysteresis buffer, 2-fix entry confirmation &amp; dwell tracking prevents boundary flapping.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium');
              onToggleGpsTracking();
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium border transition-colors min-h-[44px] ${
              gpsTrackingEnabled
                ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                : 'bg-white dark:bg-[#121824] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
            }`}
          >
            <Radio className="w-4 h-4" />
            {gpsTrackingEnabled ? 'Live GPS Active' : 'Enable Live GPS'}
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onToggleSimulateClickMode();
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium border transition-colors min-h-[44px] ${
              simulateClickMode
                ? 'bg-sky-500 text-slate-950 border-sky-500'
                : 'bg-white dark:bg-[#121824] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
            }`}
          >
            <Compass className="w-4 h-4" />
            {simulateClickMode ? 'Tap Map Active' : 'Simulate GPS Tap'}
          </button>
        </div>

        {userLocation && (
          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            Position: {userLocation.lat.toFixed(5)}, {userLocation.lng.toFixed(5)}
            {gpsAccuracyMeters !== null && gpsAccuracyMeters > 0
              ? ` · ±${gpsAccuracyMeters}m`
              : ' · exact'}
          </div>
        )}
      </div>

      {/* Add Geofence Form */}
      <form
        onSubmit={(e) => void handleCreate(e)}
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] p-3.5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            New Geofence at Map Center
          </span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            {mapCenter.lat.toFixed(4)}, {mapCenter.lng.toFixed(4)}
          </span>
        </div>

        <input
          type="text"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Zone label (e.g., Ferry Building Hub)"
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 min-h-[42px]"
        />

        <input
          type="text"
          value={alertMessage}
          onChange={(e) => setAlertMessage(e.target.value)}
          placeholder="Custom alert reminder (optional)"
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 min-h-[42px]"
        />

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 tabular-nums">
            <span>Radius</span>
            <span className="font-mono font-medium">{radiusMeters} m</span>
          </div>
          <input
            type="range"
            min={100}
            max={2500}
            step={50}
            value={radiusMeters}
            onChange={(e) => setRadiusMeters(Number(e.target.value))}
            className="w-full accent-emerald-500"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <select
            value={triggerOn}
            onChange={(e) => setTriggerOn(e.target.value as GeofenceTrigger)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-800 dark:text-slate-200 min-h-[40px]"
          >
            <option value="both">Enter &amp; Exit</option>
            <option value="enter">Enter Only</option>
            <option value="exit">Exit Only</option>
          </select>

          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 text-slate-950 px-3.5 py-2 text-xs font-semibold hover:bg-emerald-400 min-h-[40px]"
          >
            <Plus className="w-4 h-4" />
            Add Zone
          </button>
        </div>
      </form>

      {/* Active Zones List */}
      <div className="space-y-2 pb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 tabular-nums">
            Configured Geofences ({geofences.length})
          </div>
          {onAutoProvisionGeofences && uncoveredStopCount > 0 && (
            <button
              type="button"
              disabled={provisioning}
              onClick={async () => {
                triggerHaptic('medium');
                setProvisioning(true);
                try {
                  await onAutoProvisionGeofences();
                } finally {
                  setProvisioning(false);
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 min-h-[32px] whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>
                {provisioning ? 'Provisioning...' : `Auto-Geofence Stops (${uncoveredStopCount})`}
              </span>
            </button>
          )}
        </div>

        {geofences.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-5 text-center text-xs text-slate-500 dark:text-slate-400">
            No geofences yet. Pan the map to any landmark or tap &ldquo;Geofence&rdquo; on any pin to create a proximity trigger.
          </div>
        ) : (
          geofences.map((gf) => {
            const dist = userLocation
              ? haversineDistanceMeters(userLocation, { lat: gf.lat, lng: gf.lng })
              : null;
            const inside = dist !== null && dist <= gf.radiusMeters;

            return (
              <div
                key={gf.id}
                className={`rounded-xl border p-3 space-y-2 ${
                  inside
                    ? 'border-emerald-500/50 bg-emerald-500/10'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                      <MapPin className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span className="truncate">{gf.label}</span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {gf.alertMessage}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
                      <span>{gf.radiusMeters}m</span>
                      <span>·</span>
                      <span>{gf.triggerOn}</span>
                      {dist !== null && (
                        <>
                          <span>·</span>
                          <span className={inside ? 'text-emerald-500 font-semibold' : ''}>
                            {inside ? 'INSIDE' : `${formatDistance(dist)} away`}
                          </span>
                        </>
                      )}
                      {gf.linkedStopId && (
                        <>
                          <span>·</span>
                          <span className="font-sans text-emerald-600 dark:text-emerald-400">
                            Auto-completes stop on exit
                          </span>
                        </>
                      )}
                    </div>
                    {gf.enterpriseLinks && gf.enterpriseLinks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5 text-[11px] text-sky-600 dark:text-sky-400">
                        <Building2 className="w-3 h-3 shrink-0" />
                        {gf.enterpriseLinks.slice(0, 3).map((link, lIdx) => {
                          const dwellText =
                            typeof link.dwellDurationSeconds === 'number' && link.dwellDurationSeconds > 0
                              ? ` (${Math.max(1, Math.round(link.dwellDurationSeconds / 60))}m)`
                              : '';
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
                                {dwellText}
                              </span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ) : (
                            <span key={`${link.target}_${link.recordId}_${lIdx}`} className="capitalize">
                              {link.target} {link.recordId}
                              {dwellText}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onRemoveGeofence(gf.id)}
                    aria-label="Delete geofence"
                    className="p-2 text-slate-400 hover:text-rose-500 min-h-[38px] min-w-[38px] flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => onToggleGeofence(gf.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border min-h-[34px] ${
                      gf.active
                        ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                        : 'border-slate-300 dark:border-slate-700 text-slate-500'
                    }`}
                  >
                    {gf.active ? 'Armed' : 'Paused'}
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={loggingGfId === gf.id}
                      onClick={async () => {
                        if (!hasEnterpriseLogTarget) {
                          onOpenPreferences();
                          return;
                        }
                        triggerHaptic('medium');
                        setLoggingGfId(gf.id);
                        try {
                          await onLogGeofenceCheckIn(gf, inside ? 'enter' : 'exit');
                        } finally {
                          setLoggingGfId(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 disabled:opacity-50 min-h-[34px] whitespace-nowrap"
                    >
                      <Building2 className="w-3 h-3 text-sky-500" />
                      {loggingGfId === gf.id ? 'Logging...' : 'Log Check-In'}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('medium');
                        onSimulatePosition(
                          inside
                            ? { lat: gf.lat + 0.02, lng: gf.lng + 0.02 }
                            : { lat: gf.lat, lng: gf.lng }
                        );
                      }}
                      className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 min-h-[34px] whitespace-nowrap"
                    >
                      {inside ? 'Test Exit Zone' : 'Test Step Inside'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
