import React, { useEffect, useState } from 'react';
import { CloudUpload, RefreshCw, WifiOff } from 'lucide-react';
import { SmartSyncStatus } from '../types/travel';
import { triggerHaptic } from '../utils/haptics';

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

interface OfflineIndicatorProps {
  offlineSimulated?: boolean;
  smartSync?: SmartSyncStatus;
  onSyncNow?: () => void;
  onInspectQueue?: () => void;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({
  offlineSimulated = false,
  smartSync,
  onSyncNow,
  onInspectQueue,
}) => {
  const isOnline = useOnlineStatus();
  const pendingCount = smartSync?.pendingCount || 0;
  const syncing = Boolean(smartSync?.syncing);

  const isEffectivelyOffline = !isOnline || offlineSimulated;
  if (!isEffectivelyOffline && pendingCount === 0 && !syncing) return null;

  return (
    <div
      role="status"
      className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium backdrop-blur-md shadow-md ${
        isEffectivelyOffline
          ? 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300'
          : 'border-sky-500/40 bg-white/95 dark:bg-[#121824]/95 text-slate-800 dark:text-slate-100'
      }`}
    >
      {isEffectivelyOffline ? (
        <WifiOff className="w-3.5 h-3.5 shrink-0" />
      ) : syncing ? (
        <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin text-sky-500" />
      ) : (
        <CloudUpload className="w-3.5 h-3.5 shrink-0 text-sky-500" />
      )}

      <span className="tabular-nums">
        {!isOnline
          ? `Offline Mode · Encrypted vault active${pendingCount > 0 ? ` · ${pendingCount} queued` : ''}`
          : offlineSimulated
          ? `Remote Offline Mode · Cached vector overlay${pendingCount > 0 ? ` · ${pendingCount} queued` : ''}`
          : syncing
          ? `Smart Sync · Flushing ${pendingCount || 1} queued update${pendingCount === 1 ? '' : 's'}...`
          : `${pendingCount} offline update${pendingCount === 1 ? '' : 's'} ready to sync`}
      </span>

      {pendingCount > 0 && onInspectQueue && (
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            onInspectQueue();
          }}
          className="rounded-md border border-slate-300/60 dark:border-slate-700 px-2 py-0.5 text-[11px] font-medium hover:border-sky-500/50 whitespace-nowrap"
        >
          Inspect
        </button>
      )}

      {!isEffectivelyOffline && pendingCount > 0 && !syncing && onSyncNow && (
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            onSyncNow();
          }}
          className="rounded-md bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 whitespace-nowrap"
        >
          Sync Now
        </button>
      )}
    </div>
  );
};
