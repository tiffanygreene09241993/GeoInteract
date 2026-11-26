import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Maximize2,
  Minus,
  Navigation,
  Plus,
  Route,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  CachedRoute,
  DisruptionRecoveryPlan,
  LatLng,
  TripStop,
  UserPreferences,
} from '../types/travel';
import { formatDistance, formatDuration, haversineDistanceMeters } from '../utils/geofence';
import { triggerHaptic } from '../utils/haptics';

interface ItineraryFlowMapProps {
  stops: TripStop[];
  selectedDay: number;
  onSelectDay: (dayIndex: number) => void;
  cachedRoutes: CachedRoute[];
  prefs: UserPreferences;
  isOffline: boolean;
  optimizingDay: boolean;
  onOptimizeSelectedDay: () => Promise<void>;
  onUpdateStop: (
    stopId: string,
    patch: Partial<Pick<TripStop, 'priority' | 'status' | 'dayIndex' | 'timeWindow' | 'notes'>>,
    isMinorEdit?: boolean
  ) => void;
  onRemoveStop: (stopId: string) => void;
  onRouteLeg: (origin: LatLng, destination: LatLng, originName: string, destName: string) => void;
  onFocusStop?: (pos: LatLng) => void;
  recoveryPreview?: DisruptionRecoveryPlan | null;
  hasEnterpriseLogTarget?: boolean;
  onApplyRecovery?: (escalateToEnterprise: boolean) => Promise<void>;
  onDismissRecovery?: () => void;
}

type MapScope = 'all' | 'day';

interface ProjectedPoint {
  x: number;
  y: number;
}

const SVG_W = 400;
const SVG_H = 280;
const PAD_X = 42;
const PAD_Y = 38;

const DAY_PALETTE = [
  { stroke: '#10B981', fill: '#10B981', dotClass: 'bg-emerald-500', textClass: 'text-emerald-600 dark:text-emerald-400' },
  { stroke: '#0EA5E9', fill: '#0EA5E9', dotClass: 'bg-sky-500', textClass: 'text-sky-600 dark:text-sky-400' },
  { stroke: '#F59E0B', fill: '#F59E0B', dotClass: 'bg-amber-500', textClass: 'text-amber-600 dark:text-amber-400' },
  { stroke: '#8B5CF6', fill: '#8B5CF6', dotClass: 'bg-violet-500', textClass: 'text-violet-600 dark:text-violet-400' },
  { stroke: '#EC4899', fill: '#EC4899', dotClass: 'bg-pink-500', textClass: 'text-pink-600 dark:text-pink-400' },
];

function getDayStyle(dayIndex: number) {
  return DAY_PALETTE[Math.abs(dayIndex) % DAY_PALETTE.length];
}

function findMatchingCachedRoute(
  cachedRoutes: CachedRoute[],
  origin: LatLng,
  destination: LatLng
): CachedRoute | undefined {
  return cachedRoutes.find(
    (r) =>
      haversineDistanceMeters(r.origin, origin) < 60 &&
      haversineDistanceMeters(r.destination, destination) < 60
  );
}

export const ItineraryFlowMap: React.FC<ItineraryFlowMapProps> = ({
  stops,
  selectedDay,
  onSelectDay,
  cachedRoutes,
  prefs,
  isOffline,
  optimizingDay,
  onOptimizeSelectedDay,
  onUpdateStop,
  onRemoveStop,
  onRouteLeg,
  onFocusStop,
  recoveryPreview,
  hasEnterpriseLogTarget = false,
  onApplyRecovery,
  onDismissRecovery,
}) => {
  const [scope, setScope] = useState<MapScope>('all');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [escalateEnterprise, setEscalateEnterprise] = useState(false);
  const [applyingRecovery, setApplyingRecovery] = useState(false);

  const activeRecovery =
    recoveryPreview && recoveryPreview.dayIndex === selectedDay ? recoveryPreview : null;

  useEffect(() => {
    if (recoveryPreview) {
      setScope('day');
      if (recoveryPreview.dayIndex !== selectedDay) {
        onSelectDay(recoveryPreview.dayIndex);
      }
    }
  }, [recoveryPreview?.id]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    active: boolean;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  }>({
    active: false,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
  });

  // Sort all stops chronologically by day then order
  const orderedAllStops = useMemo(
    () => [...stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex),
    [stops]
  );

  const dayGroups = useMemo(() => {
    const map = new Map<number, TripStop[]>();
    for (const s of orderedAllStops) {
      const list = map.get(s.dayIndex) || [];
      list.push(s);
      map.set(s.dayIndex, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [orderedAllStops]);

  const visibleStops = useMemo(() => {
    if (scope === 'day') {
      return orderedAllStops.filter((s) => s.dayIndex === selectedDay);
    }
    return orderedAllStops;
  }, [orderedAllStops, scope, selectedDay]);

  const visibleDayGroups = useMemo(() => {
    if (scope === 'day') {
      return dayGroups.filter(([d]) => d === selectedDay);
    }
    return dayGroups;
  }, [dayGroups, scope, selectedDay]);

  // Keep selectedStopId valid whenever stops or scope changes
  useEffect(() => {
    if (visibleStops.length === 0) {
      setSelectedStopId(null);
      return;
    }
    if (!selectedStopId || !visibleStops.some((s) => s.id === selectedStopId)) {
      const firstInSelectedDay = visibleStops.find((s) => s.dayIndex === selectedDay);
      setSelectedStopId((firstInSelectedDay || visibleStops[0]).id);
    }
  }, [visibleStops, selectedStopId, selectedDay]);

  // Reset pan/zoom when scope or trip stop set changes noticeably
  const stopSignature = useMemo(
    () => `${scope}:${selectedDay}:${visibleStops.map((s) => s.id).join(',')}`,
    [scope, selectedDay, visibleStops]
  );
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [stopSignature]);

  // Build aspect-corrected geographic projection fitting all visible stops + cached paths
  const projection = useMemo(() => {
    if (visibleStops.length === 0) {
      return null;
    }

    const samplePoints: LatLng[] = visibleStops.map((s) => ({ lat: s.lat, lng: s.lng }));
    if (activeRecovery) {
      for (const ps of activeRecovery.proposedStops) {
        samplePoints.push({ lat: ps.lat, lng: ps.lng });
      }
      for (const leg of activeRecovery.legs || []) {
        if (leg.path.length > 1) {
          const step = Math.max(1, Math.floor(leg.path.length / 8));
          for (let k = 0; k < leg.path.length; k += step) {
            samplePoints.push(leg.path[k]);
          }
        }
      }
    }
    for (const [, group] of visibleDayGroups) {
      for (let i = 0; i < group.length - 1; i++) {
        const cached = findMatchingCachedRoute(cachedRoutes, group[i], group[i + 1]);
        if (cached && cached.path.length > 2) {
          // Sample up to 12 points from the cached path for bounds accuracy
          const step = Math.max(1, Math.floor(cached.path.length / 12));
          for (let k = 0; k < cached.path.length; k += step) {
            samplePoints.push(cached.path[k]);
          }
        }
      }
    }

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;

    for (const p of samplePoints) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }

    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));

    // Enforce sensible minimum span (~650m) for single or tightly clustered stops
    const rawLatSpan = Math.max(maxLat - minLat, 0.0055);
    const rawLngSpan = Math.max((maxLng - minLng) * cosLat, 0.0055);

    const drawW = SVG_W - PAD_X * 2;
    const drawH = SVG_H - PAD_Y * 2;
    const baseScale = Math.min(drawW / rawLngSpan, drawH / rawLatSpan);

    const project = (pt: LatLng): ProjectedPoint => {
      const dx = (pt.lng - centerLng) * cosLat * baseScale;
      const dy = -(pt.lat - centerLat) * baseScale;
      return {
        x: SVG_W / 2 + dx * zoom + pan.x,
        y: SVG_H / 2 + dy * zoom + pan.y,
      };
    };

    // Compute approximate real-world meters represented by a 64-unit scale bar
    const degPerSvgUnit = 1 / (baseScale * zoom);
    const metersPerSvgUnit = degPerSvgUnit * 111_320;
    const scaleBarMeters = Math.max(25, Math.round(metersPerSvgUnit * 64));

    return { project, scaleBarMeters };
  }, [visibleStops, visibleDayGroups, cachedRoutes, activeRecovery, zoom, pan]);

  // Compute day legs & flow summary metrics
  const legDataByDay = useMemo(() => {
    const legs: Array<{
      id: string;
      dayIndex: number;
      from: TripStop;
      to: TripStop;
      distanceMeters: number;
      durationMillis: number | null;
      cachedPath: LatLng[] | null;
      isCached: boolean;
    }> = [];

    for (const [dayIndex, group] of visibleDayGroups) {
      for (let i = 0; i < group.length - 1; i++) {
        const from = group[i];
        const to = group[i + 1];
        const cached = findMatchingCachedRoute(cachedRoutes, from, to);
        const estMeters = Math.round(haversineDistanceMeters(from, to) * 1.24);
        legs.push({
          id: `${from.id}_${to.id}`,
          dayIndex,
          from,
          to,
          distanceMeters: cached ? cached.distanceMeters : estMeters,
          durationMillis: cached ? cached.durationMillis : null,
          cachedPath: cached && cached.path.length > 1 ? cached.path : null,
          isCached: Boolean(cached && !cached.isOfflineEstimate),
        });
      }
    }
    return legs;
  }, [visibleDayGroups, cachedRoutes]);

  const flowMetrics = useMemo(() => {
    const targetLegs =
      scope === 'day'
        ? legDataByDay
        : legDataByDay.filter((l) => l.dayIndex === selectedDay);
    const activeDayStops = orderedAllStops.filter((s) => s.dayIndex === selectedDay);
    const totalMeters = targetLegs.reduce((sum, l) => sum + l.distanceMeters, 0);
    const allLegsTotalMeters = legDataByDay.reduce((sum, l) => sum + l.distanceMeters, 0);
    const totalDuration = targetLegs.reduce((sum, l) => sum + (l.durationMillis || 0), 0);
    const hasAllDurations = targetLegs.length > 0 && targetLegs.every((l) => l.durationMillis !== null);
    return {
      activeDayStopCount: activeDayStops.length,
      dayDistanceMeters: totalMeters,
      allDistanceMeters: allLegsTotalMeters,
      dayDurationMillis: hasAllDurations ? totalDuration : null,
    };
  }, [legDataByDay, orderedAllStops, scope, selectedDay]);

  const selectedStopIndex = useMemo(
    () => visibleStops.findIndex((s) => s.id === selectedStopId),
    [visibleStops, selectedStopId]
  );
  const selectedStop = selectedStopIndex >= 0 ? visibleStops[selectedStopIndex] : null;

  const selectedStopNextInDay = useMemo(() => {
    if (!selectedStop) return null;
    const sameDay = orderedAllStops.filter((s) => s.dayIndex === selectedStop.dayIndex);
    const idx = sameDay.findIndex((s) => s.id === selectedStop.id);
    if (idx < 0 || idx >= sameDay.length - 1) return null;
    return sameDay[idx + 1];
  }, [selectedStop, orderedAllStops]);

  const selectedStopLeg = useMemo(() => {
    if (!selectedStop || !selectedStopNextInDay) return null;
    return legDataByDay.find(
      (l) => l.from.id === selectedStop.id && l.to.id === selectedStopNextInDay.id
    ) || null;
  }, [selectedStop, selectedStopNextInDay, legDataByDay]);

  const activeCalloutStop = useMemo(() => {
    const id = hoveredStopId || selectedStopId;
    return visibleStops.find((s) => s.id === id) || null;
  }, [hoveredStopId, selectedStopId, visibleStops]);

  const handleZoomIn = useCallback(() => {
    triggerHaptic('light');
    setZoom((z) => Math.min(6, Number((z * 1.35).toFixed(2))));
  }, []);

  const handleZoomOut = useCallback(() => {
    triggerHaptic('light');
    setZoom((z) => Math.max(0.75, Number((z / 1.35).toFixed(2))));
  }, []);

  const handleResetView = useCallback(() => {
    triggerHaptic('light');
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
      moved: false,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current.active || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dxPx = e.clientX - dragRef.current.startClientX;
    const dyPx = e.clientY - dragRef.current.startClientY;
    if (Math.abs(dxPx) > 4 || Math.abs(dyPx) > 4) {
      dragRef.current.moved = true;
    }
    const scaleX = SVG_W / rect.width;
    const scaleY = SVG_H / rect.height;
    setPan({
      x: dragRef.current.startPanX + dxPx * scaleX,
      y: dragRef.current.startPanY + dyPx * scaleY,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current.active) {
      dragRef.current.active = false;
      setIsDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if not captured
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
    setZoom((z) => Math.max(0.75, Math.min(6, Number((z * factor).toFixed(2)))));
  };

  const handleSelectPin = (stop: TripStop) => {
    if (dragRef.current.moved) return;
    triggerHaptic('light');
    setSelectedStopId(stop.id);
    if (stop.dayIndex !== selectedDay) {
      onSelectDay(stop.dayIndex);
    }
  };

  const handleStepStop = (delta: -1 | 1) => {
    if (visibleStops.length === 0) return;
    triggerHaptic('light');
    const nextIdx =
      selectedStopIndex < 0
        ? 0
        : (selectedStopIndex + delta + visibleStops.length) % visibleStops.length;
    const target = visibleStops[nextIdx];
    setSelectedStopId(target.id);
    if (target.dayIndex !== selectedDay) {
      onSelectDay(target.dayIndex);
    }
  };

  if (orderedAllStops.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 p-6 text-center space-y-2">
        <Sparkles className="w-5 h-5 text-emerald-500 mx-auto" />
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
          No stops to map yet
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Add stops from search or GeoInteract AI to visualize your connected daily pin flow here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-4">
      {/* Scope Controls & Day Flow Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Map scope"
          className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800"
        >
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setScope('all');
            }}
            className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors min-h-[32px] ${
              scope === 'all'
                ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            All Days ({orderedAllStops.length})
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setScope('day');
            }}
            className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors min-h-[32px] ${
              scope === 'day'
                ? 'bg-white dark:bg-[#182030] text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Day {selectedDay + 1} ({flowMetrics.activeDayStopCount})
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          <span>
            {scope === 'day'
              ? formatDistance(flowMetrics.dayDistanceMeters)
              : `${formatDistance(flowMetrics.allDistanceMeters)} total`}
          </span>
          {flowMetrics.dayDurationMillis && scope === 'day' && (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(flowMetrics.dayDurationMillis)}</span>
            </>
          )}
        </div>
      </div>

      {/* Interactive Simplified SVG Flow Map Canvas */}
      {visibleStops.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-800 p-5 text-center space-y-2">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            No stops on Day {selectedDay + 1}
          </p>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setScope('all');
            }}
            className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline min-h-[36px] px-2"
          >
            Show all {orderedAllStops.length} trip stops
          </button>
        </div>
      ) : (
        <div className="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0B0F17] overflow-hidden select-none">
          {/* Top-left Compass & Day Legend */}
          <div className="absolute top-2.5 left-2.5 z-10 flex items-center gap-2 pointer-events-none">
            <div className="w-7 h-7 rounded-lg border border-slate-200/90 dark:border-slate-700/80 bg-white/90 dark:bg-[#121824]/90 backdrop-blur-sm flex items-center justify-center text-[10px] font-mono font-bold text-slate-700 dark:text-slate-200">
              N
            </div>
            {dayGroups.length > 1 && scope === 'all' && (
              <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-slate-200/90 dark:border-slate-700/80 bg-white/90 dark:bg-[#121824]/90 backdrop-blur-sm px-2 py-1">
                {dayGroups.map(([dayIdx, grp]) => {
                  const style = getDayStyle(dayIdx);
                  const isCurrent = dayIdx === selectedDay;
                  return (
                    <button
                      key={dayIdx}
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        onSelectDay(dayIdx);
                        if (grp[0]) setSelectedStopId(grp[0].id);
                      }}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-opacity ${
                        isCurrent
                          ? 'text-slate-900 dark:text-slate-100 font-semibold'
                          : 'text-slate-500 dark:text-slate-400 opacity-75 hover:opacity-100'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full ${style.dotClass}`} aria-hidden="true" />
                      <span>D{dayIdx + 1}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top-right Zoom & Fit Controls */}
          <div className="absolute top-2.5 right-2.5 z-10 flex flex-col gap-1">
            <button
              type="button"
              onClick={handleZoomIn}
              aria-label="Zoom in map view"
              title="Zoom in"
              className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-[#121824]/95 text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 flex items-center justify-center transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleZoomOut}
              aria-label="Zoom out map view"
              title="Zoom out"
              className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-[#121824]/95 text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 flex items-center justify-center transition-colors"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleResetView}
              aria-label="Fit all pins in view"
              title="Fit all pins"
              className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-[#121824]/95 text-slate-700 dark:text-slate-200 hover:border-emerald-500/60 flex items-center justify-center transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Bottom-left Dynamic Scale Bar */}
          {projection && (
            <div className="absolute bottom-2.5 left-2.5 z-10 pointer-events-none flex items-center gap-1.5 rounded-md bg-white/85 dark:bg-[#121824]/85 backdrop-blur-sm px-2 py-1 border border-slate-200/80 dark:border-slate-800">
              <div className="w-12 h-1 border-b-2 border-l border-r border-slate-500 dark:border-slate-400" />
              <span className="text-[10px] font-mono tabular-nums text-slate-600 dark:text-slate-300">
                {formatDistance(projection.scaleBarMeters)}
              </span>
            </div>
          )}

          {/* SVG Cartographic Viewport */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            role="img"
            aria-label="Interactive simplified map showing connected trip stops"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            className={`block w-full aspect-[10/7] touch-none ${
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            }`}
          >
            {/* Subtle Cartographic Graticule Grid */}
            <g className="stroke-slate-300/60 dark:stroke-slate-800/80" strokeWidth="0.75">
              {[56, 112, 168, 224].map((y) => (
                <line key={`h-${y}`} x1="0" y1={y} x2={SVG_W} y2={y} />
              ))}
              {[80, 160, 240, 320].map((x) => (
                <line key={`v-${x}`} x1={x} y1="0" x2={x} y2={SVG_H} />
              ))}
            </g>

            {/* Connected Route Legs per Day */}
            {projection &&
              legDataByDay.map((leg) => {
                const style = getDayStyle(leg.dayIndex);
                const isFocusedDay = scope === 'day' || leg.dayIndex === selectedDay;
                const isHighlightedLeg =
                  selectedStop &&
                  (leg.from.id === selectedStop.id || leg.to.id === selectedStop.id);

                const pFrom = projection.project(leg.from);
                const pTo = projection.project(leg.to);

                let pathD = '';
                let midX = (pFrom.x + pTo.x) / 2;
                let midY = (pFrom.y + pTo.y) / 2;
                let angleDeg =
                  (Math.atan2(pTo.y - pFrom.y, pTo.x - pFrom.x) * 180) / Math.PI;

                if (leg.cachedPath && leg.cachedPath.length > 1) {
                  const pts = leg.cachedPath.map((pt) => projection.project(pt));
                  pathD = pts
                    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
                    .join(' ');
                  const midIdx = Math.floor(pts.length / 2);
                  const prevPt = pts[Math.max(0, midIdx - 1)];
                  const nextPt = pts[Math.min(pts.length - 1, midIdx)];
                  midX = (prevPt.x + nextPt.x) / 2;
                  midY = (prevPt.y + nextPt.y) / 2;
                  angleDeg =
                    (Math.atan2(nextPt.y - prevPt.y, nextPt.x - prevPt.x) * 180) / Math.PI;
                } else {
                  // Slight orthogonal curve so overlapping return legs stay readable
                  const dx = pTo.x - pFrom.x;
                  const dy = pTo.y - pFrom.y;
                  const dist = Math.hypot(dx, dy) || 1;
                  const offset = Math.min(18, dist * 0.14);
                  const cx = (pFrom.x + pTo.x) / 2 - (dy / dist) * offset;
                  const cy = (pFrom.y + pTo.y) / 2 + (dx / dist) * offset;
                  pathD = `M ${pFrom.x.toFixed(1)} ${pFrom.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${pTo.x.toFixed(1)} ${pTo.y.toFixed(1)}`;
                  // Midpoint of quadratic Bézier at t = 0.5
                  midX = 0.25 * pFrom.x + 0.5 * cx + 0.25 * pTo.x;
                  midY = 0.25 * pFrom.y + 0.5 * cy + 0.25 * pTo.y;
                }

                const segPixelLen = Math.hypot(pTo.x - pFrom.x, pTo.y - pFrom.y);

                return (
                  <g
                    key={leg.id}
                    opacity={isHighlightedLeg ? 1 : isFocusedDay ? 0.88 : 0.32}
                  >
                    <path
                      d={pathD}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth={isHighlightedLeg ? 3 : isFocusedDay ? 2.25 : 1.5}
                      strokeDasharray={leg.isCached ? undefined : '5 4'}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    {/* Directional Flow Chevron at Leg Midpoint */}
                    {segPixelLen > 28 && (
                      <g transform={`translate(${midX.toFixed(1)}, ${midY.toFixed(1)}) rotate(${angleDeg.toFixed(1)})`}>
                        <path
                          d="M -3.5 -3 L 3 0 L -3.5 3"
                          fill="none"
                          stroke={style.stroke}
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </g>
                    )}
                  </g>
                );
              })}

            {/* Interactive Numbered Stop Pins (render focused day on top) */}
            {projection &&
              [...visibleStops]
                .sort((a, b) => {
                  const aScore =
                    (a.id === selectedStopId ? 4 : 0) +
                    (a.dayIndex === selectedDay ? 2 : 0);
                  const bScore =
                    (b.id === selectedStopId ? 4 : 0) +
                    (b.dayIndex === selectedDay ? 2 : 0);
                  return aScore - bScore;
                })
                .map((stop) => {
                  const pt = projection.project(stop);
                  const style = getDayStyle(stop.dayIndex);
                  const sameDayStops = orderedAllStops.filter((s) => s.dayIndex === stop.dayIndex);
                  const stopNum = sameDayStops.findIndex((s) => s.id === stop.id) + 1;

                  const isSelected = stop.id === selectedStopId;
                  const isHovered = stop.id === hoveredStopId;
                  const isFocusedDay = scope === 'day' || stop.dayIndex === selectedDay;
                  const isCompleted = stop.status === 'completed';
                  const isHigh = stop.priority === 'high';
                  const isNormalHighlighted =
                    stop.priority === 'normal' && prefs.highlightNormalTasks;

                  const isImpacted =
                    Boolean(activeRecovery?.affectedStopIds.includes(stop.id));
                  const radius = isSelected ? 12 : isFocusedDay ? 10 : 8;
                  const pinFill = isImpacted
                    ? '#F43F5E'
                    : isCompleted
                    ? '#10B981'
                    : isHigh
                    ? '#F43F5E'
                    : isNormalHighlighted
                    ? '#F59E0B'
                    : style.fill;

                  return (
                    <g
                      key={stop.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Day ${stop.dayIndex + 1}, stop ${stopNum}: ${stop.name}${
                        isCompleted ? ' (completed)' : ''
                      }${isImpacted ? ' (impacted by disruption)' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectPin(stop);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectPin(stop);
                        }
                      }}
                      onMouseEnter={() => setHoveredStopId(stop.id)}
                      onMouseLeave={() => setHoveredStopId((cur) => (cur === stop.id ? null : cur))}
                      opacity={isImpacted ? 0.55 : isFocusedDay || isSelected || isHovered ? 1 : 0.52}
                      className="cursor-pointer focus:outline-none"
                    >
                      {/* Impacted Stop Dashed Warning Ring */}
                      {isImpacted && (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={radius + 5}
                          fill="none"
                          stroke="#F43F5E"
                          strokeWidth="1.5"
                          strokeDasharray="3 2"
                        />
                      )}

                      {/* Selection Halo Ring */}
                      {(isSelected || isHovered) && (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={radius + 5}
                          fill={pinFill}
                          fillOpacity={isSelected ? 0.22 : 0.14}
                          stroke={pinFill}
                          strokeWidth="1.25"
                          strokeOpacity="0.7"
                        />
                      )}

                      {/* Pin Body */}
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={radius}
                        fill={pinFill}
                        className="stroke-white dark:stroke-[#0B0F17]"
                        strokeWidth="2"
                      />

                      {/* Order Index Inside Pin */}
                      <text
                        x={pt.x}
                        y={pt.y + 0.5}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#0F172A"
                        fontSize={isSelected ? 10 : 9}
                        fontWeight="700"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {stopNum}
                      </text>
                    </g>
                  );
                })}

            {/* Proposed Disruption Recovery Corridor & Replacement Pins */}
            {projection && activeRecovery && (
              <g aria-label="Proposed disruption recovery route">
                {activeRecovery.proposedStops.map((ps, idx) => {
                  if (idx >= activeRecovery.proposedStops.length - 1) return null;
                  const next = activeRecovery.proposedStops[idx + 1];
                  const matchingLeg = activeRecovery.legs?.[idx];
                  let d = '';
                  if (matchingLeg && matchingLeg.path.length > 1) {
                    const pts = matchingLeg.path.map((pt) => projection.project(pt));
                    d = pts
                      .map((pt, k) => `${k === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
                      .join(' ');
                  } else {
                    const a = projection.project(ps);
                    const b = projection.project(next);
                    d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
                  }
                  return (
                    <path
                      key={`rec_leg_${idx}`}
                      d={d}
                      fill="none"
                      stroke="#F59E0B"
                      strokeWidth="2.75"
                      strokeDasharray="6 3"
                      strokeLinecap="round"
                    />
                  );
                })}

                {activeRecovery.proposedStops
                  .filter((ps) => ps.isReplacement)
                  .map((ps, idx) => {
                    const pt = projection.project(ps);
                    return (
                      <g key={`rec_pin_${ps.id}_${idx}`}>
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={15}
                          fill="#F59E0B"
                          fillOpacity="0.22"
                          stroke="#F59E0B"
                          strokeWidth="1.5"
                        />
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={10}
                          fill="#F59E0B"
                          className="stroke-white dark:stroke-[#0B0F17]"
                          strokeWidth="2"
                        />
                        <text
                          x={pt.x}
                          y={pt.y + 0.5}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="#0F172A"
                          fontSize="9"
                          fontWeight="800"
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        >
                          R{idx + 1}
                        </text>
                      </g>
                    );
                  })}
              </g>
            )}

            {/* Floating Non-Clipping Callout Label for Active/Hovered Pin */}
            {projection && activeCalloutStop && (() => {
              const pt = projection.project(activeCalloutStop);
              const labelText =
                activeCalloutStop.name.length > 26
                  ? `${activeCalloutStop.name.slice(0, 25)}…`
                  : activeCalloutStop.name;
              const boxW = Math.min(186, Math.max(76, labelText.length * 6.3 + 18));
              const boxH = 22;
              const bx = Math.max(8, Math.min(SVG_W - boxW - 8, pt.x - boxW / 2));
              const placeBelow = pt.y < 42;
              const by = placeBelow ? pt.y + 18 : pt.y - 18 - boxH;

              return (
                <g pointerEvents="none">
                  <rect
                    x={bx}
                    y={by}
                    width={boxW}
                    height={boxH}
                    rx="6"
                    className="fill-slate-900/92 dark:fill-slate-100/95"
                  />
                  <text
                    x={bx + boxW / 2}
                    y={by + boxH / 2 + 0.5}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="10"
                    fontWeight="600"
                    className="fill-white dark:fill-slate-950"
                  >
                    {labelText}
                  </text>
                </g>
              );
            })()}
          </svg>
        </div>
      )}

      {/* Proposed Disruption Recovery Preview Action Banner */}
      {activeRecovery && (
        <div className="rounded-xl border border-amber-500/45 bg-amber-500/10 p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-amber-700 dark:text-amber-300 tabular-nums">
                  Disruption Recovery Preview · Day {activeRecovery.dayIndex + 1}
                  {activeRecovery.estimatedDelayAvoidedMinutes > 0
                    ? ` · Saves ~${activeRecovery.estimatedDelayAvoidedMinutes} min`
                    : ''}
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-200 mt-0.5 leading-snug">
                  {activeRecovery.summary}
                </p>
              </div>
            </div>
            {onDismissRecovery && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onDismissRecovery();
                }}
                aria-label="Dismiss recovery preview"
                className="p-1 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {activeRecovery.replacements.length > 0 && (
            <div className="space-y-1 text-xs text-slate-600 dark:text-slate-300 border-t border-amber-500/20 pt-2">
              {activeRecovery.replacements.map((rep, rIdx) => (
                <div key={`${rep.placeId}_${rIdx}`} className="flex items-start gap-1.5">
                  <span className="font-mono font-bold text-amber-600 dark:text-amber-400 shrink-0">
                    R{rIdx + 1}
                  </span>
                  <span className="leading-snug">
                    {rep.replacesStopName ? `${rep.replacesStopName} → ` : ''}
                    <strong className="font-semibold text-slate-900 dark:text-slate-100">
                      {rep.name}
                    </strong>
                    {rep.reason ? ` · ${rep.reason}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {hasEnterpriseLogTarget && (
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
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
            {onApplyRecovery && (
              <button
                type="button"
                disabled={applyingRecovery}
                onClick={async () => {
                  triggerHaptic('medium');
                  setApplyingRecovery(true);
                  try {
                    await onApplyRecovery(escalateEnterprise);
                  } finally {
                    setApplyingRecovery(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-50 min-h-[36px] whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{applyingRecovery ? 'Applying...' : 'Apply Recovery Plan'}</span>
              </button>
            )}
            {onDismissRecovery && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onDismissRecovery();
                }}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white min-h-[36px] whitespace-nowrap"
              >
                Cancel Preview
              </button>
            )}
          </div>
        </div>
      )}

      {/* Active Stop Inspector & Flow Stepper */}
      {selectedStop && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                <span className={`font-semibold ${getDayStyle(selectedStop.dayIndex).textClass}`}>
                  Day {selectedStop.dayIndex + 1}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  #{orderedAllStops
                    .filter((s) => s.dayIndex === selectedStop.dayIndex)
                    .findIndex((s) => s.id === selectedStop.id) + 1}
                </span>
                <span aria-hidden="true">·</span>
                <span>{selectedStop.category}</span>
                {selectedStop.status === 'completed' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      Completed
                    </span>
                  </>
                )}
              </div>
              <h4
                className={`text-sm font-semibold mt-0.5 truncate ${
                  selectedStop.status === 'completed'
                    ? 'line-through text-slate-400 dark:text-slate-500'
                    : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {selectedStop.name}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {selectedStop.address}
              </p>
            </div>

            {/* Pin-by-Pin Stepper */}
            {visibleStops.length > 1 && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => handleStepStop(-1)}
                  aria-label="Previous stop"
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-500/50 min-h-[36px] min-w-[36px] flex items-center justify-center"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleStepStop(1)}
                  aria-label="Next stop"
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-500/50 min-h-[36px] min-w-[36px] flex items-center justify-center"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Leg Preview to Next Stop */}
          {selectedStopNextInDay && selectedStopLeg && (
            <div className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300 pt-1.5 border-t border-slate-200/70 dark:border-slate-800/80 tabular-nums">
              <span className="truncate">
                Next: <strong className="font-medium">{selectedStopNextInDay.name}</strong>
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                {formatDistance(selectedStopLeg.distanceMeters)}
                {selectedStopLeg.durationMillis
                  ? ` · ${formatDuration(selectedStopLeg.durationMillis)}`
                  : ' est.'}
              </span>
            </div>
          )}

          {/* Action Row */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1.5 border-t border-slate-200/70 dark:border-slate-800/80">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onUpdateStop(
                    selectedStop.id,
                    { status: selectedStop.status === 'completed' ? 'planned' : 'completed' },
                    true
                  )
                }
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium min-h-[36px] whitespace-nowrap transition-colors ${
                  selectedStop.status === 'completed'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-emerald-500/50'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{selectedStop.status === 'completed' ? 'Completed' : 'Mark Done'}</span>
              </button>

              {onFocusStop && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    onFocusStop({ lat: selectedStop.lat, lng: selectedStop.lng });
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[36px] whitespace-nowrap"
                >
                  <Crosshair className="w-3.5 h-3.5 shrink-0" />
                  <span>Main Map</span>
                </button>
              )}

              {selectedStopNextInDay && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    onRouteLeg(
                      { lat: selectedStop.lat, lng: selectedStop.lng },
                      { lat: selectedStopNextInDay.lat, lng: selectedStopNextInDay.lng },
                      selectedStop.name,
                      selectedStopNextInDay.name
                    );
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 min-h-[36px] whitespace-nowrap"
                >
                  <Navigation className="w-3.5 h-3.5 shrink-0" />
                  <span>Route Leg</span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => onRemoveStop(selectedStop.id)}
              aria-label="Remove stop"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 min-h-[36px] min-w-[36px] flex items-center justify-center"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Pre-Commit Flow Optimization Prompt */}
      {flowMetrics.activeDayStopCount >= 2 && (
        <div className="flex items-center justify-between gap-2 px-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="truncate">
            Reviewing Day {selectedDay + 1} flow ({flowMetrics.activeDayStopCount} connected stops)
          </span>
          <button
            type="button"
            disabled={isOffline || optimizingDay}
            onClick={() => void onOptimizeSelectedDay()}
            className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400 font-medium hover:underline disabled:opacity-45 whitespace-nowrap shrink-0 min-h-[32px]"
          >
            <Route className="w-3.5 h-3.5 shrink-0" />
            <span>{optimizingDay ? 'Optimizing...' : 'Optimize Order'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
