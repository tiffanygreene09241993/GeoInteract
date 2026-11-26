import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Download,
  DownloadCloud,
  ExternalLink,
  GripVertical,
  List,
  Map as MapIcon,
  Navigation,
  Pencil,
  Plus,
  Route,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  CachedRoute,
  CollaboratorMember,
  DayOptimizationResult,
  DisruptionRecoveryPlan,
  FieldDispatchResult,
  LatLng,
  PriorityLevel,
  StopStatus,
  TravelMode,
  Trip,
  TripAlert,
  TripGeofence,
  TripStop,
  UserPreferences,
} from '../types/travel';
import { formatDistance, formatDuration } from '../utils/geofence';
import { triggerHaptic } from '../utils/haptics';
import { exportTripGPX, exportTripICS, exportTripMarkdown } from '../utils/tripExport';
import { sanitizeExternalUrl } from '../utils/url';
import { ItineraryFlowMap } from './ItineraryFlowMap';

export type ItineraryLayoutMode = 'list' | 'map_view';

interface ItineraryDashboardProps {
  trips: Trip[];
  activeTrip: Trip | null;
  stops: TripStop[];
  geofences: TripGeofence[];
  alerts: TripAlert[];
  members: CollaboratorMember[];
  currentUserUid?: string;
  cachedRoutes: CachedRoute[];
  prefs: UserPreferences;
  isOffline: boolean;
  enterprisePinCount: number;
  hasEnterpriseLogTarget: boolean;
  onSelectTrip: (tripId: string) => void;
  onCreateTrip: (input: {
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    center: LatLng;
    travelMode: TravelMode;
    notes?: string;
  }) => Promise<Trip>;
  onUpdateStop: (
    stopId: string,
    patch: Partial<Pick<TripStop, 'priority' | 'status' | 'dayIndex' | 'timeWindow' | 'notes'>>,
    isMinorEdit?: boolean
  ) => void;
  onReorderDayStops: (dayIndex: number, orderedStopIds: string[]) => Promise<void>;
  onMoveStopToDay: (stopId: string, targetDayIndex: number) => Promise<void>;
  onRemoveStop: (stopId: string) => void;
  onRouteLeg: (origin: LatLng, destination: LatLng, originName: string, destName: string) => void;
  onCacheAllOfflineRoutes: () => Promise<number>;
  onOptimizeDay: (dayIndex: number) => Promise<DayOptimizationResult | null>;
  onBuildFieldDay?: (dayIndex: number) => Promise<FieldDispatchResult | null>;
  onCheckTravelAlerts: () => Promise<void>;
  onFocusStop?: (pos: LatLng) => void;
  recoveryPreview?: DisruptionRecoveryPlan | null;
  onApplyRecovery?: (escalateToEnterprise: boolean) => Promise<void>;
  onDismissRecovery?: () => void;
  requestedLayoutMode?: ItineraryLayoutMode | null;
  onConsumeRequestedLayout?: () => void;
  mapCenter: LatLng;
}

export const ItineraryDashboard: React.FC<ItineraryDashboardProps> = ({
  trips,
  activeTrip,
  stops,
  geofences,
  alerts,
  members,
  currentUserUid,
  cachedRoutes,
  prefs,
  isOffline,
  enterprisePinCount,
  hasEnterpriseLogTarget,
  onSelectTrip,
  onCreateTrip,
  onUpdateStop,
  onReorderDayStops,
  onMoveStopToDay,
  onRemoveStop,
  onRouteLeg,
  onCacheAllOfflineRoutes,
  onOptimizeDay,
  onBuildFieldDay,
  onCheckTravelAlerts,
  onFocusStop,
  recoveryPreview,
  onApplyRecovery,
  onDismissRecovery,
  requestedLayoutMode,
  onConsumeRequestedLayout,
  mapCenter,
}) => {
  const [selectedDay, setSelectedDay] = useState(0);
  const [layoutMode, setLayoutMode] = useState<ItineraryLayoutMode>('list');
  const [tripSearch, setTripSearch] = useState('');
  const [showNewTrip, setShowNewTrip] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDestination, setNewDestination] = useState('');
  const [newStartDate, setNewStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newEndDate, setNewEndDate] = useState(() => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
  const [newTravelMode, setNewTravelMode] = useState<TravelMode>(prefs.travelMode);
  const [cachingStatus, setCachingStatus] = useState<string | null>(null);
  const [checkingAlerts, setCheckingAlerts] = useState(false);
  const [optimizingDay, setOptimizingDay] = useState(false);
  const [buildingFieldDay, setBuildingFieldDay] = useState(false);
  const [dispatchSummary, setDispatchSummary] = useState<FieldDispatchResult | null>(null);
  const [optSummary, setOptSummary] = useState<DayOptimizationResult | null>(null);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [editTimeWindow, setEditTimeWindow] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);

  useEffect(() => {
    if (requestedLayoutMode) {
      setLayoutMode(requestedLayoutMode);
      onConsumeRequestedLayout?.();
    }
  }, [requestedLayoutMode, onConsumeRequestedLayout]);

  const memberNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.uid, m.displayName);
    }
    return map;
  }, [members]);

  const normalizedTripQuery = tripSearch.trim().toLowerCase();

  const filteredTrips = useMemo(() => {
    if (!normalizedTripQuery) return trips;
    return trips.filter(
      (t) =>
        t.title.toLowerCase().includes(normalizedTripQuery) ||
        t.destination.toLowerCase().includes(normalizedTripQuery)
    );
  }, [trips, normalizedTripQuery]);

  const dayNumbers = useMemo(() => {
    const maxDay = stops.reduce((m, s) => Math.max(m, s.dayIndex), 0);
    const count = Math.max(3, maxDay + 1);
    return Array.from({ length: count }, (_, i) => i);
  }, [stops]);

  const dayStops = useMemo(
    () => stops.filter((s) => s.dayIndex === selectedDay).sort((a, b) => a.orderIndex - b.orderIndex),
    [stops, selectedDay]
  );

  const tripProgress = useMemo(() => {
    const total = stops.length;
    const completed = stops.filter((s) => s.status === 'completed').length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percent };
  }, [stops]);

  const handleCreateTripSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newDestination.trim()) return;
    await onCreateTrip({
      title: newTitle.trim(),
      destination: newDestination.trim(),
      startDate: newStartDate,
      endDate: newEndDate,
      center: mapCenter,
      travelMode: newTravelMode,
    });
    setNewTitle('');
    setNewDestination('');
    setTripSearch('');
    setShowNewTrip(false);
  };

  const handleCacheRoutes = async () => {
    triggerHaptic('medium');
    setCachingStatus('Caching route corridors...');
    const count = await onCacheAllOfflineRoutes();
    setCachingStatus(`Saved ${count} offline route leg${count === 1 ? '' : 's'} to encrypted vault.`);
    setTimeout(() => setCachingStatus(null), 4000);
  };

  const handleScanAlerts = async () => {
    if (isOffline || checkingAlerts) return;
    triggerHaptic('light');
    setCheckingAlerts(true);
    try {
      await onCheckTravelAlerts();
    } finally {
      setCheckingAlerts(false);
    }
  };

  const handleOptimizeSelectedDay = async () => {
    if (isOffline || optimizingDay || dayStops.length < 2) return;
    triggerHaptic('medium');
    setOptimizingDay(true);
    try {
      const result = await onOptimizeDay(selectedDay);
      if (result) {
        setOptSummary(result);
      }
    } finally {
      setOptimizingDay(false);
    }
  };

  const handleBuildFieldDayClick = async () => {
    if (!onBuildFieldDay || isOffline || buildingFieldDay || enterprisePinCount === 0) return;
    triggerHaptic('medium');
    setBuildingFieldDay(true);
    try {
      const result = await onBuildFieldDay(selectedDay);
      if (result) {
        setDispatchSummary(result);
        setLayoutMode('map_view');
      }
    } finally {
      setBuildingFieldDay(false);
    }
  };

  const handleMoveOrder = async (stopId: string, direction: -1 | 1) => {
    const idx = dayStops.findIndex((s) => s.id === stopId);
    if (idx < 0) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= dayStops.length) return;
    const ordered = dayStops.map((s) => s.id);
    const [item] = ordered.splice(idx, 1);
    ordered.splice(swapIdx, 0, item);
    await onReorderDayStops(selectedDay, ordered);
  };

  const handleDropReorder = async (targetStopId: string) => {
    if (!draggingStopId || draggingStopId === targetStopId) {
      setDraggingStopId(null);
      return;
    }
    const ordered = dayStops.map((s) => s.id);
    const fromIdx = ordered.indexOf(draggingStopId);
    const toIdx = ordered.indexOf(targetStopId);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggingStopId(null);
      return;
    }
    ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, draggingStopId);
    setDraggingStopId(null);
    await onReorderDayStops(selectedDay, ordered);
  };

  const beginEditStop = (stop: TripStop) => {
    triggerHaptic('light');
    setEditingStopId(stop.id);
    setEditTimeWindow(stop.timeWindow || '');
    setEditNotes(stop.notes || '');
  };

  const saveEditStop = (stopId: string) => {
    triggerHaptic('light');
    onUpdateStop(
      stopId,
      {
        timeWindow: editTimeWindow.trim(),
        notes: editNotes.trim(),
      },
      true
    );
    setEditingStopId(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto px-4 py-3 space-y-4">
      {/* Multi-Trip Selector Header */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={normalizedTripQuery ? 'trip-search' : 'trip-select'}
            className="text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums"
          >
            Trip Schedule ({normalizedTripQuery ? `${filteredTrips.length} of ${trips.length}` : trips.length})
          </label>
          <div className="flex items-center gap-1.5 relative">
            {activeTrip && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setShowExportMenu((v) => !v);
                  }}
                  aria-expanded={showExportMenu}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/50 min-h-[36px] whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5 text-sky-500" />
                  Export
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 mt-1.5 w-48 z-30 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#182030] shadow-xl py-1 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        exportTripICS(activeTrip, stops);
                        setShowExportMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Calendar (.ics)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        exportTripGPX(activeTrip, stops, cachedRoutes);
                        setShowExportMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      GPS Track (.gpx)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        exportTripMarkdown(activeTrip, stops, geofences, alerts, cachedRoutes);
                        setShowExportMenu(false);
                      }}
                      className="w-full text-left px-3 py-2 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Field Brief (.md)
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setShowNewTrip((v) => !v);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[36px] whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              New Trip
            </button>
          </div>
        </div>

        {/* Trip Search Bar */}
        <div className="relative">
          <Search
            className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="trip-search"
            type="text"
            value={tripSearch}
            onChange={(e) => setTripSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && tripSearch) {
                e.preventDefault();
                setTripSearch('');
              } else if (e.key === 'Enter' && normalizedTripQuery && filteredTrips.length > 0) {
                e.preventDefault();
                triggerHaptic('light');
                onSelectTrip(filteredTrips[0].id);
              }
            }}
            placeholder="Search trips by title or destination..."
            aria-label="Filter trips by title or destination"
            className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] pl-9 pr-9 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/30 min-h-[42px]"
          />
          {tripSearch && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setTripSearch('');
              }}
              aria-label="Clear trip search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 min-h-[34px] min-w-[34px] flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {normalizedTripQuery ? (
          filteredTrips.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 px-3 py-3 flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-500 dark:text-slate-400 truncate">
                No trips match &ldquo;{tripSearch.trim()}&rdquo;
              </span>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setTripSearch('');
                }}
                className="font-medium text-emerald-600 dark:text-emerald-400 hover:underline whitespace-nowrap shrink-0 min-h-[34px] px-1"
              >
                Clear filter
              </button>
            </div>
          ) : (
            <div
              role="listbox"
              aria-label="Filtered trips"
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] divide-y divide-slate-200 dark:divide-slate-800 max-h-44 overflow-y-auto"
            >
              {filteredTrips.map((t) => {
                const isSelected = activeTrip?.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      triggerHaptic('light');
                      onSelectTrip(t.id);
                    }}
                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-2 transition-colors min-h-[44px] ${
                      isSelected
                        ? 'bg-emerald-500/10 text-slate-900 dark:text-slate-100'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{t.title}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate tabular-nums">
                        {t.destination} · {t.startDate} to {t.endDate}
                      </div>
                    </div>
                    {isSelected && (
                      <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap shrink-0">
                        Active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <select
            id="trip-select"
            value={activeTrip?.id || ''}
            onChange={(e) => {
              triggerHaptic('light');
              onSelectTrip(e.target.value);
            }}
            className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2.5 text-sm font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500 min-h-[44px]"
          >
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} — {t.destination}
              </option>
            ))}
          </select>
        )}

        {activeTrip && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              <span className="inline-flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {activeTrip.startDate} to {activeTrip.endDate}
              </span>
              <span>·</span>
              <span>{activeTrip.travelMode}</span>
              <span>·</span>
              <span className="font-mono">E2EE {activeTrip.keyFingerprint}</span>
            </div>

            {/* Active Trip Completion Progress Bar */}
            <div className="pt-1.5 border-t border-slate-200/80 dark:border-slate-800/80 space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Trip progress
                </span>
                <span
                  className={
                    tripProgress.total > 0 && tripProgress.percent === 100
                      ? 'font-mono font-semibold text-emerald-600 dark:text-emerald-400'
                      : 'font-mono text-slate-600 dark:text-slate-400'
                  }
                >
                  {tripProgress.total > 0
                    ? `${tripProgress.completed}/${tripProgress.total} stops · ${tripProgress.percent}%`
                    : '0 stops · 0%'}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Active trip stop completion"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={tripProgress.percent}
                aria-valuetext={
                  tripProgress.total > 0
                    ? `${tripProgress.completed} of ${tripProgress.total} stops completed (${tripProgress.percent}%)`
                    : 'No stops planned yet'
                }
                className="h-2 w-full rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800"
              >
                <svg
                  viewBox="0 0 100 8"
                  preserveAspectRatio="none"
                  className="block w-full h-full"
                  aria-hidden="true"
                >
                  <rect
                    x="0"
                    y="0"
                    width={tripProgress.percent}
                    height="8"
                    className="fill-emerald-500 transition-[width] duration-200 ease-out motion-reduce:transition-none"
                  />
                </svg>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Trip Drawer */}
      {showNewTrip && (
        <form
          onSubmit={(e) => void handleCreateTripSubmit(e)}
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] p-3.5 space-y-2.5"
        >
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Create Encrypted Trip Schedule
          </div>
          <input
            type="text"
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Trip title (e.g., Kyoto Autumn Walk)"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 min-h-[42px]"
          />
          <input
            type="text"
            required
            value={newDestination}
            onChange={(e) => setNewDestination(e.target.value)}
            placeholder="Destination city or region"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 min-h-[42px]"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={newStartDate}
              onChange={(e) => setNewStartDate(e.target.value)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
            />
            <input
              type="date"
              value={newEndDate}
              onChange={(e) => setNewEndDate(e.target.value)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <select
              value={newTravelMode}
              onChange={(e) => setNewTravelMode(e.target.value as TravelMode)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
            >
              <option value="WALKING">Walking</option>
              <option value="TRANSIT">Transit</option>
              <option value="BICYCLING">Cycling</option>
              <option value="DRIVING">Driving</option>
            </select>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewTrip(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 min-h-[38px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3.5 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-semibold hover:bg-emerald-400 min-h-[38px]"
              >
                Create Trip
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Offline Routing & Live Alert Actions */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void handleCacheRoutes()}
          disabled={stops.length < 2}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:border-emerald-500/50 disabled:opacity-45 min-h-[44px]"
        >
          <DownloadCloud className="w-4 h-4 text-sky-500 shrink-0" />
          <span className="truncate">Cache Offline ({cachedRoutes.length})</span>
        </button>

        <button
          type="button"
          onClick={() => void handleScanAlerts()}
          disabled={isOffline || checkingAlerts}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:border-amber-500/50 disabled:opacity-45 min-h-[44px]"
        >
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="truncate">{checkingAlerts ? 'Scanning...' : 'Check Alerts'}</span>
        </button>
      </div>

      {cachingStatus && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400 px-1">{cachingStatus}</div>
      )}

      {enterprisePinCount > 0 && onBuildFieldDay && (
        <button
          type="button"
          disabled={isOffline || buildingFieldDay}
          onClick={() => void handleBuildFieldDayClick()}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 text-slate-950 px-3 py-2.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-45 min-h-[42px] whitespace-nowrap"
        >
          <Sparkles className="w-4 h-4 shrink-0" />
          <span>
            {buildingFieldDay
              ? `Dispatching Day ${selectedDay + 1} Field Loop...`
              : `Build Field Day (${enterprisePinCount} Enterprise Pin${enterprisePinCount === 1 ? '' : 's'})`}
          </span>
        </button>
      )}

      {dispatchSummary && dispatchSummary.dayIndex === selectedDay && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 space-y-1 text-xs">
          <div className="flex items-center justify-between gap-2 font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums">
            <span>
              Field Day {dispatchSummary.dayIndex + 1} Dispatched · {dispatchSummary.orderedStops.length} stops ·{' '}
              {formatDistance(dispatchSummary.totalDistanceMeters)}
            </span>
            <button
              type="button"
              onClick={() => setDispatchSummary(null)}
              aria-label="Dismiss dispatch summary"
              className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-slate-700 dark:text-slate-200 leading-snug">
            {dispatchSummary.summary}
          </p>
        </div>
      )}

      {/* Day Tabs + Layout Switcher (List / Map View) + Optimize Day */}
      <div className="space-y-2 border-b border-slate-200 dark:border-slate-800 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="Itinerary layout"
            className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={layoutMode === 'list'}
              onClick={() => {
                triggerHaptic('light');
                setLayoutMode('list');
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors min-h-[34px] ${
                layoutMode === 'list'
                  ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <List className="w-3.5 h-3.5 shrink-0" />
              <span>List</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={layoutMode === 'map_view'}
              onClick={() => {
                triggerHaptic('light');
                setLayoutMode('map_view');
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors min-h-[34px] ${
                layoutMode === 'map_view'
                  ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5 shrink-0" />
              <span>Map View</span>
            </button>
          </div>

          {dayStops.length >= 2 && (
            <button
              type="button"
              disabled={isOffline || optimizingDay}
              onClick={() => void handleOptimizeSelectedDay()}
              className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 disabled:opacity-45 whitespace-nowrap shrink-0 min-h-[36px]"
            >
              <Route className="w-3.5 h-3.5 shrink-0" />
              <span>{optimizingDay ? 'Optimizing...' : 'Optimize Day'}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {dayNumbers.map((day) => {
            const count = stops.filter((s) => s.dayIndex === day).length;
            return (
              <button
                key={day}
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setSelectedDay(day);
                  setOptSummary(null);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors min-h-[36px] ${
                  selectedDay === day
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Day {day + 1} {count > 0 ? `(${count})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {optSummary && optSummary.dayIndex === selectedDay && (
        <div className="rounded-xl border border-sky-500/35 bg-sky-500/10 p-3 space-y-1 text-xs">
          <div className="flex items-center justify-between gap-2 font-semibold text-sky-700 dark:text-sky-300 tabular-nums">
            <span>
              Day {optSummary.dayIndex + 1} Optimized · {formatDistance(optSummary.totalDistanceMeters)} ·{' '}
              {formatDuration(optSummary.totalDurationMillis)}
            </span>
            {optSummary.savedDistanceMeters > 50 && (
              <span className="text-emerald-600 dark:text-emerald-400">
                Saved {formatDistance(optSummary.savedDistanceMeters)}
              </span>
            )}
          </div>
          {optSummary.feasibilityNotes.map((note, idx) => (
            <p key={idx} className="text-slate-600 dark:text-slate-300 leading-snug">
              {note}
            </p>
          ))}
        </div>
      )}

      {/* Stops Layout: Interactive Simplified Map View vs List View */}
      {layoutMode === 'map_view' ? (
        <ItineraryFlowMap
          stops={stops}
          selectedDay={selectedDay}
          onSelectDay={(day) => {
            setSelectedDay(day);
            setOptSummary(null);
          }}
          cachedRoutes={cachedRoutes}
          prefs={prefs}
          isOffline={isOffline}
          optimizingDay={optimizingDay}
          onOptimizeSelectedDay={handleOptimizeSelectedDay}
          onUpdateStop={onUpdateStop}
          onRemoveStop={onRemoveStop}
          onRouteLeg={onRouteLeg}
          onFocusStop={onFocusStop}
          recoveryPreview={recoveryPreview}
          hasEnterpriseLogTarget={hasEnterpriseLogTarget}
          onApplyRecovery={onApplyRecovery}
          onDismissRecovery={onDismissRecovery}
        />
      ) : dayStops.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center space-y-2">
          <Sparkles className="w-5 h-5 text-emerald-500 mx-auto" />
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            No stops planned for Day {selectedDay + 1} yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Search on the map or ask GeoInteract AI to discover verified Google Maps spots and pin them here.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 pb-4">
          {dayStops.map((stop, idx) => {
            const isNormalHighlighted = stop.priority === 'normal' && prefs.highlightNormalTasks;
            const isHigh = stop.priority === 'high';
            const nextStop = dayStops[idx + 1];
            const isEditing = editingStopId === stop.id;
            const authorName =
              stop.createdBy &&
              stop.createdBy !== 'local_explorer' &&
              stop.createdBy !== currentUserUid
                ? memberNameMap.get(stop.createdBy)
                : null;

            return (
              <div
                key={stop.id}
                draggable={!isEditing}
                onDragStart={() => setDraggingStopId(stop.id)}
                onDragOver={(e) => {
                  if (draggingStopId && draggingStopId !== stop.id) {
                    e.preventDefault();
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDropReorder(stop.id);
                }}
                onDragEnd={() => setDraggingStopId(null)}
                className={`rounded-xl border p-3 space-y-2 transition-colors ${
                  draggingStopId === stop.id ? 'opacity-60 border-dashed border-emerald-500' : ''
                } ${
                  isNormalHighlighted
                    ? 'bg-amber-500/8 dark:bg-amber-400/10 border-amber-500/45 shadow-sm'
                    : isHigh
                    ? 'bg-rose-500/6 dark:bg-rose-500/10 border-rose-500/40'
                    : 'bg-white dark:bg-[#121824] border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      <GripVertical
                        className="w-3.5 h-3.5 text-slate-400 cursor-grab shrink-0"
                        aria-hidden="true"
                      />
                      <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                        #{idx + 1}
                      </span>
                      <span>·</span>
                      <span>{stop.category}</span>
                      {stop.timeWindow && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5 font-mono text-slate-700 dark:text-slate-300">
                            <Clock className="w-3 h-3" />
                            {stop.timeWindow}
                          </span>
                        </>
                      )}
                      {isNormalHighlighted && (
                        <>
                          <span>·</span>
                          <span className="text-amber-600 dark:text-amber-400 font-semibold">
                            Normal Priority
                          </span>
                        </>
                      )}
                      {isHigh && (
                        <>
                          <span>·</span>
                          <span className="text-rose-500 font-semibold">High Priority</span>
                        </>
                      )}
                      {authorName && (
                        <>
                          <span>·</span>
                          <span>Added by {authorName}</span>
                        </>
                      )}
                    </div>
                    <h4
                      className={`text-sm font-semibold mt-0.5 truncate ${
                        stop.status === 'completed'
                          ? 'line-through text-slate-400 dark:text-slate-500'
                          : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {stop.name}
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{stop.address}</p>
                    {stop.notes && !isEditing && (
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-snug">
                        {stop.notes}
                      </p>
                    )}
                    {stop.enterpriseLinks && stop.enterpriseLinks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-[11px] text-sky-600 dark:text-sky-400">
                        <Building2 className="w-3 h-3 shrink-0" />
                        {stop.enterpriseLinks.map((link, lIdx) => {
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
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onUpdateStop(
                        stop.id,
                        { status: stop.status === 'completed' ? 'planned' : 'completed' },
                        true
                      )
                    }
                    aria-label={stop.status === 'completed' ? 'Mark planned' : 'Mark completed'}
                    className={`p-2 rounded-lg min-h-[40px] min-w-[40px] flex items-center justify-center transition-colors shrink-0 ${
                      stop.status === 'completed'
                        ? 'text-emerald-500 bg-emerald-500/10'
                        : 'text-slate-400 hover:text-emerald-500'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Inline Editor for Time Window & Field Notes */}
                {isEditing && (
                  <div className="pt-2 border-t border-slate-200/70 dark:border-slate-800/80 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={editTimeWindow}
                        onChange={(e) => setEditTimeWindow(e.target.value)}
                        placeholder="Time window (e.g., 09:30–10:30)"
                        aria-label="Stop time window"
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 min-h-[36px]"
                      />
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Field notes or access instructions..."
                        aria-label="Stop notes"
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 min-h-[36px]"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingStopId(null)}
                        className="px-2.5 py-1 rounded-lg text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 min-h-[32px]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEditStop(stop.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 text-xs font-semibold hover:bg-emerald-400 min-h-[32px]"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {/* Controls Row */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200/70 dark:border-slate-800/80">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      aria-label="Priority"
                      value={stop.priority}
                      onChange={(e) =>
                        onUpdateStop(stop.id, { priority: e.target.value as PriorityLevel }, true)
                      }
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-1 text-xs text-slate-700 dark:text-slate-200 min-h-[34px]"
                    >
                      <option value="low" className="bg-slate-900 text-slate-100">Low</option>
                      <option value="normal" className="bg-slate-900 text-slate-100">Normal</option>
                      <option value="high" className="bg-slate-900 text-slate-100">High</option>
                    </select>

                    <select
                      aria-label="Status"
                      value={stop.status}
                      onChange={(e) =>
                        onUpdateStop(stop.id, { status: e.target.value as StopStatus }, true)
                      }
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-1 text-xs text-slate-700 dark:text-slate-200 min-h-[34px]"
                    >
                      <option value="planned" className="bg-slate-900 text-slate-100">Planned</option>
                      <option value="active" className="bg-slate-900 text-slate-100">Active</option>
                      <option value="completed" className="bg-slate-900 text-slate-100">Done</option>
                      <option value="skipped" className="bg-slate-900 text-slate-100">Skipped</option>
                    </select>

                    <select
                      aria-label="Move to day"
                      value={stop.dayIndex}
                      onChange={(e) => void onMoveStopToDay(stop.id, Number(e.target.value))}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-1 text-xs text-slate-700 dark:text-slate-200 min-h-[34px]"
                    >
                      {dayNumbers.map((d) => (
                        <option key={d} value={d} className="bg-slate-900 text-slate-100">
                          Day {d + 1}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-1">
                    {dayStops.length > 1 && (
                      <>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => void handleMoveOrder(stop.id, -1)}
                          aria-label="Move stop up"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 disabled:opacity-30 min-h-[34px] min-w-[30px] flex items-center justify-center"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === dayStops.length - 1}
                          onClick={() => void handleMoveOrder(stop.id, 1)}
                          aria-label="Move stop down"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 disabled:opacity-30 min-h-[34px] min-w-[30px] flex items-center justify-center"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => (isEditing ? setEditingStopId(null) : beginEditStop(stop))}
                      aria-label="Edit stop time window and notes"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-500 min-h-[34px] min-w-[34px] flex items-center justify-center"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>

                    {nextStop && (
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onRouteLeg(
                            { lat: stop.lat, lng: stop.lng },
                            { lat: nextStop.lat, lng: nextStop.lng },
                            stop.name,
                            nextStop.name
                          );
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 min-h-[34px] whitespace-nowrap"
                      >
                        <Navigation className="w-3 h-3" />
                        Next
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onRemoveStop(stop.id)}
                      aria-label="Remove stop"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 min-h-[34px] min-w-[34px] flex items-center justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Cached Offline Routes Summary */}
      {cachedRoutes.length > 0 && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Cached Offline Route Legs
          </div>
          <div className="space-y-1.5">
            {cachedRoutes.slice(0, 4).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onRouteLeg(r.origin, r.destination, r.originName, r.destinationName);
                }}
                className="w-full text-left rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#121824] px-3 py-2 flex items-center justify-between gap-2 hover:border-sky-500/50 transition-colors"
              >
                <span className="text-xs text-slate-700 dark:text-slate-200 truncate">
                  {r.originName} → {r.destinationName}
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                  {formatDistance(r.distanceMeters)} · {formatDuration(r.durationMillis)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
