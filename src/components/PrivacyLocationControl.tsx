import React, { useState } from 'react';
import {
  LocateFixed,
  Lock,
  Navigation,
  Radio,
  ShieldCheck,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { LatLng, TripGeofence } from '../types/travel';
import { triggerHaptic } from '../utils/haptics';

interface PrivacyLocationControlProps {
  gpsTrackingEnabled: boolean;
  gpsAccuracyMeters: number | null;
  userLocation: LatLng | null;
  simulateClickMode: boolean;
  offlineSimulated: boolean;
  geofences: TripGeofence[];
  hasStops: boolean;
  onToggleGpsTracking: () => void;
  onToggleSimulateClickMode: () => void;
  onToggleOfflineSimulated: () => void;
  onLoadInteractiveDemo: () => Promise<void>;
  onSimulateGeofenceEvent: (mode: 'enter' | 'exit') => void;
  onOpenShareVault: () => void;
}

export const PrivacyLocationControl: React.FC<PrivacyLocationControlProps> = ({
  gpsTrackingEnabled,
  gpsAccuracyMeters,
  userLocation,
  simulateClickMode,
  offlineSimulated,
  geofences,
  hasStops,
  onToggleGpsTracking,
  onToggleSimulateClickMode,
  onToggleOfflineSimulated,
  onLoadInteractiveDemo,
  onSimulateGeofenceEvent,
  onOpenShareVault,
}) => {
  const [open, setOpen] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);

  const isSimulatedBeacon = !gpsTrackingEnabled && Boolean(userLocation);
  const activeGeofenceCount = geofences.filter((g) => g.active).length;

  const statusLabel = gpsTrackingEnabled
    ? `Live GPS${typeof gpsAccuracyMeters === 'number' && gpsAccuracyMeters > 0 ? ` ±${gpsAccuracyMeters}m` : ''}`
    : isSimulatedBeacon
    ? 'Demo GPS · Simulated'
    : 'GPS Off · Private';

  return (
    <div className="relative pointer-events-auto">
      <button
        type="button"
        onClick={() => {
          triggerHaptic('light');
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label="Privacy and location controls"
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium backdrop-blur-md shadow-md transition-colors min-h-[38px] whitespace-nowrap ${
          gpsTrackingEnabled
            ? 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200'
            : isSimulatedBeacon
            ? 'border-sky-500/45 bg-white/95 dark:bg-[#121824]/95 text-sky-700 dark:text-sky-300'
            : 'border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 text-slate-700 dark:text-slate-200 hover:border-emerald-500/50'
        }`}
      >
        <ShieldCheck
          className={`w-3.5 h-3.5 shrink-0 ${
            gpsTrackingEnabled
              ? 'text-emerald-400'
              : isSimulatedBeacon
              ? 'text-sky-500'
              : 'text-emerald-500'
          }`}
        />
        <span className="tabular-nums">{statusLabel}</span>
      </button>

      {open && (
        <div
          role="region"
          aria-label="Privacy, Location & Safe Demo Controls"
          className="mt-2 w-[300px] sm:w-[320px] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/98 dark:bg-[#121824]/98 backdrop-blur-md shadow-2xl p-3.5 space-y-3 text-left"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Privacy &amp; Safe Demo Mode
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                Real GPS stays off by default. Test maps, geofences, offline mode, and E2EE safely without sharing your location.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close privacy controls"
              className="p-1 rounded-lg text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Primary Location & Offline Toggles */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                onToggleGpsTracking();
              }}
              className={`w-full flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-medium min-h-[42px] transition-colors ${
                gpsTrackingEnabled
                  ? 'border-emerald-500/50 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-emerald-500/40'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <LocateFixed className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>Real Browser GPS</span>
              </span>
              <span className="font-mono text-[11px]">
                {gpsTrackingEnabled ? 'ON (Tap to Stop)' : 'OFF'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onToggleSimulateClickMode();
                setOpen(false);
              }}
              className={`w-full flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-medium min-h-[42px] transition-colors ${
                simulateClickMode
                  ? 'border-sky-500/50 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                  : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-sky-500/40'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Navigation className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                <span>Tap Map to Simulate Position</span>
              </span>
              <span className="font-mono text-[11px]">{simulateClickMode ? 'ACTIVE' : 'OFF'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onToggleOfflineSimulated();
              }}
              className={`w-full flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-medium min-h-[42px] transition-colors ${
                offlineSimulated
                  ? 'border-amber-500/50 bg-amber-500/12 text-amber-700 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-500/40'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <WifiOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>Simulate Offline Mode</span>
              </span>
              <span className="font-mono text-[11px]">{offlineSimulated ? 'OFFLINE' : 'ONLINE'}</span>
            </button>
          </div>

          {/* One-Tap Safe Demo Sandbox */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <button
              type="button"
              disabled={loadingDemo}
              onClick={async () => {
                triggerHaptic('medium');
                setLoadingDemo(true);
                try {
                  await onLoadInteractiveDemo();
                  setOpen(false);
                } finally {
                  setLoadingDemo(false);
                }
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs py-2.5 px-3 hover:bg-emerald-400 disabled:opacity-50 min-h-[42px]"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>
                {loadingDemo
                  ? 'Loading Safe Demo...'
                  : hasStops
                  ? 'Reset Safe Interactive Demo'
                  : 'Load Safe Interactive Demo'}
              </span>
            </button>

            {activeGeofenceCount > 0 && (
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('medium');
                    onSimulateGeofenceEvent('enter');
                  }}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 min-h-[38px]"
                >
                  <Radio className="w-3 h-3 shrink-0" />
                  <span>Sim Arrival</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('medium');
                    onSimulateGeofenceEvent('exit');
                  }}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-2 text-[11px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 min-h-[38px]"
                >
                  <Radio className="w-3 h-3 shrink-0" />
                  <span>Sim Exit</span>
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setOpen(false);
                onOpenShareVault();
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-emerald-500/50 min-h-[38px]"
            >
              <Lock className="w-3 h-3 text-emerald-500 shrink-0" />
              <span>Test E2EE Sharing &amp; Key Recovery</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
