import React, { useCallback, useMemo } from 'react';
import { Compass, Sparkles } from 'lucide-react';
import { GeofenceEntryCue, LatLng, TripGeofence, TripStop } from '../types/travel';
import { haversineDistanceMeters } from '../utils/geofence';
import { triggerHaptic } from '../utils/haptics';

interface DemoVectorMapProps {
  center: LatLng;
  stops: TripStop[];
  geofences: TripGeofence[];
  userLocation: LatLng | null;
  highlightNormalTasks: boolean;
  simulateClickMode: boolean;
  onSimulateLocation: (pos: LatLng) => void;
  onSelectStop: (stop: TripStop) => void;
  onLoadInteractiveDemo?: () => void;
  reasonLabel: string;
  triggeredGeofenceCues?: GeofenceEntryCue[];
}

/**
 * Interactive vector map fallback rendered whenever live Google Maps tiles are
 * unavailable so users still have a working, clearly labeled interactive demo map.
 */
export const DemoVectorMap: React.FC<DemoVectorMapProps> = ({
  center,
  stops,
  geofences,
  userLocation,
  highlightNormalTasks,
  simulateClickMode,
  onSimulateLocation,
  onSelectStop,
  onLoadInteractiveDemo,
  reasonLabel,
  triggeredGeofenceCues = [],
}) => {
  const bounds = useMemo(() => {
    const pts: LatLng[] = [
      center,
      ...stops.map((s) => ({ lat: s.lat, lng: s.lng })),
      ...geofences.map((g) => ({ lat: g.lat, lng: g.lng })),
      ...(userLocation ? [userLocation] : []),
    ];
    let minLat = center.lat - 0.014;
    let maxLat = center.lat + 0.014;
    let minLng = center.lng - 0.018;
    let maxLng = center.lng + 0.018;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    const padLat = (maxLat - minLat) * 0.2 || 0.01;
    const padLng = (maxLng - minLng) * 0.2 || 0.01;
    return {
      minLat: minLat - padLat,
      maxLat: maxLat + padLat,
      minLng: minLng - padLng,
      maxLng: maxLng + padLng,
    };
  }, [center, stops, geofences, userLocation]);

  const project = useCallback(
    (p: LatLng) => ({
      x: ((p.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 800,
      y: (1 - (p.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 500,
    }),
    [bounds]
  );

  const orderedStops = useMemo(
    () => [...stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex),
    [stops]
  );

  return (
    <div className="relative w-full h-full flex flex-col bg-[#0B0F17] text-slate-100 p-3 sm:p-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 pr-36 sm:pr-44">
        <div className="inline-flex items-center gap-2 rounded-lg border border-sky-500/35 bg-sky-500/12 px-3 py-1.5 text-xs font-medium text-sky-200">
          <Compass className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span>Interactive Demo Vector Map · {reasonLabel}</span>
        </div>

        {stops.length === 0 && onLoadInteractiveDemo && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium');
              onLoadInteractiveDemo();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 min-h-[36px] whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Load Demo Trip
          </button>
        )}
      </div>

      <svg
        viewBox="0 0 800 500"
        role="img"
        aria-label="Interactive demo vector map with trip stops and geofences"
        className={`w-full flex-1 rounded-2xl border border-slate-800 bg-[#0E1420] ${
          simulateClickMode ? 'cursor-crosshair' : 'cursor-pointer'
        }`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rx = (e.clientX - rect.left) / rect.width;
          const ry = (e.clientY - rect.top) / rect.height;
          const lng = bounds.minLng + rx * (bounds.maxLng - bounds.minLng);
          const lat = bounds.minLat + (1 - ry) * (bounds.maxLat - bounds.minLat);
          triggerHaptic('medium');
          onSimulateLocation({ lat, lng });
        }}
      >
        {/* Coordinate Grid */}
        {[1, 2, 3, 4, 5, 6, 7].map((i) => (
          <line key={`vx_${i}`} x1={i * 100} y1={0} x2={i * 100} y2={500} stroke="#1E293B" strokeWidth="1" />
        ))}
        {[1, 2, 3, 4].map((i) => (
          <line key={`hy_${i}`} x1={0} y1={i * 100} x2={800} y2={i * 100} stroke="#1E293B" strokeWidth="1" />
        ))}

        {/* Connected Itinerary Path */}
        {orderedStops.length > 1 && (
          <polyline
            fill="none"
            stroke="#10B981"
            strokeWidth="2.5"
            strokeDasharray="6 4"
            opacity="0.75"
            points={orderedStops
              .map((s) => {
                const pt = project(s);
                return `${pt.x},${pt.y}`;
              })
              .join(' ')}
          />
        )}

        {/* Active Geofences */}
        {geofences
          .filter((g) => g.active)
          .map((g) => {
            const pt = project(g);
            const isTriggered = triggeredGeofenceCues.some((c) => c.geofenceId === g.id);
            return (
              <g key={g.id}>
                {isTriggered && (
                  <>
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={32}
                      fill="rgba(16, 185, 129, 0.24)"
                      stroke="#34D399"
                      strokeWidth="2.5"
                      className="geofence-svg-ring-pulse"
                    />
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={32}
                      fill="none"
                      stroke="#38BDF8"
                      strokeWidth="2"
                      className="geofence-svg-ring-pulse geofence-svg-ring-pulse-delayed"
                    />
                  </>
                )}
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={40}
                  fill={isTriggered ? 'rgba(56, 189, 248, 0.22)' : 'rgba(16, 185, 129, 0.14)'}
                  stroke={isTriggered ? '#34D399' : '#10B981'}
                  strokeWidth={isTriggered ? '2.5' : '1.5'}
                  strokeDasharray="4 4"
                />
                <text x={pt.x} y={pt.y + 54} textAnchor="middle" fill="#6EE7B7" fontSize="11">
                  {g.label}
                </text>
              </g>
            );
          })}

        {/* Trip Stop Pins */}
        {orderedStops.map((s, idx) => {
          const pt = project(s);
          const entryCue = triggeredGeofenceCues.find(
            (cue) =>
              (cue.linkedStopId && cue.linkedStopId === s.id) ||
              haversineDistanceMeters(s, cue) <= Math.max(cue.radiusMeters, 150)
          );
          const fill = entryCue
            ? '#10B981'
            : s.status === 'completed'
            ? '#10B981'
            : s.priority === 'high'
            ? '#EF4444'
            : s.priority === 'normal' && highlightNormalTasks
            ? '#F59E0B'
            : '#64748B';
          return (
            <g
              key={s.id}
              onClick={(ev) => {
                ev.stopPropagation();
                triggerHaptic('light');
                onSelectStop(s);
              }}
              className="cursor-pointer"
            >
              {entryCue && (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={16}
                  fill="rgba(16, 185, 129, 0.3)"
                  stroke="#38BDF8"
                  strokeWidth="2"
                  className="geofence-svg-ring-pulse"
                />
              )}
              <g key={entryCue ? entryCue.id : s.id} className={entryCue ? 'geofence-svg-pin-3d' : undefined}>
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={entryCue ? 14 : 12}
                  fill={fill}
                  stroke={entryCue ? '#38BDF8' : '#0B0F17'}
                  strokeWidth={entryCue ? '2.5' : '2'}
                />
                <text x={pt.x} y={pt.y + 4} textAnchor="middle" fill="#0B0F17" fontSize="10" fontWeight="700">
                  {idx + 1}
                </text>
              </g>
              {entryCue && (
                <g>
                  <rect x={pt.x - 28} y={pt.y - 36} width={56} height={16} rx={8} fill="#34D399" />
                  <text
                    x={pt.x}
                    y={pt.y - 25}
                    textAnchor="middle"
                    fill="#0B0F17"
                    fontSize="8.5"
                    fontWeight="800"
                  >
                    ARRIVED
                  </text>
                </g>
              )}
              <text x={pt.x + 16} y={pt.y + 4} fill="#E2E8F0" fontSize="12" fontWeight="500">
                {s.name.slice(0, 24)}
              </text>
            </g>
          );
        })}

        {/* Simulated or Active Explorer Beacon */}
        {userLocation && (
          <g>
            <circle cx={project(userLocation).x} cy={project(userLocation).y} r={15} fill="rgba(56, 189, 248, 0.25)" />
            <circle
              cx={project(userLocation).x}
              cy={project(userLocation).y}
              r={6}
              fill="#38BDF8"
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      <div className="pt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>Tap anywhere on the vector grid to simulate your position and test geofence alerts safely.</span>
        <span className="font-mono tabular-nums">
          {stops.length} stops · {geofences.filter((g) => g.active).length} active geofences
        </span>
      </div>
    </div>
  );
};
