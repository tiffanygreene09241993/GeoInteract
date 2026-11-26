import { CachedRoute, Trip, TripAlert, TripGeofence, TripStop } from '../types/travel';
import { formatDistance, formatDuration } from './geofence';

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'geointeract-trip'
  );
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatIcsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(
    date.getHours()
  )}${pad(date.getMinutes())}00`;
}

function parseStartTime(timeWindow: string | undefined, fallbackHour: number): { hour: number; minute: number } {
  if (timeWindow) {
    const m = timeWindow.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (m) {
      let hour = Number(m[1]);
      const minute = Number(m[2] || 0);
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute };
      }
    }
  }
  return { hour: Math.min(22, fallbackHour), minute: 0 };
}

export function buildTripICS(trip: Trip, stops: TripStop[]): string {
  const sorted = [...stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
  const baseDate = new Date(`${trip.startDate || new Date().toISOString().slice(0, 10)}T09:00:00`);
  const stamp = formatIcsDate(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GeoInteract//Field & Travel Itinerary//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(trip.title)}`,
  ];

  sorted.forEach((stop, idx) => {
    const dayDate = new Date(baseDate.getTime() + stop.dayIndex * 86400000);
    const sameDayIdx = sorted.filter((s) => s.dayIndex === stop.dayIndex).findIndex((s) => s.id === stop.id);
    const { hour, minute } = parseStartTime(stop.timeWindow, 9 + sameDayIdx * 2);
    dayDate.setHours(hour, minute, 0, 0);
    const endDate = new Date(dayDate.getTime() + 60 * 60 * 1000);

    const descParts: string[] = [
      `Day ${stop.dayIndex + 1} · Stop #${sameDayIdx + 1} (${stop.category})`,
      `Status: ${stop.status} | Priority: ${stop.priority}`,
    ];
    if (stop.timeWindow) descParts.push(`Window: ${stop.timeWindow}`);
    if (stop.notes) descParts.push(`Notes: ${stop.notes}`);
    if (stop.googleMapsUri) descParts.push(`Map: ${stop.googleMapsUri}`);
    if (stop.enterpriseLinks?.length) {
      descParts.push(
        'Enterprise Records: ' +
          stop.enterpriseLinks
            .map((l) => `${l.target.toUpperCase()} ${l.recordId}${l.recordUrl ? ` (${l.recordUrl})` : ''}`)
            .join(', ')
      );
    }

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(stop.id || `stop-${idx}`)}@geointeract.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsDate(dayDate)}`,
      `DTEND:${formatIcsDate(endDate)}`,
      `SUMMARY:${escapeIcsText(`${stop.name} (Day ${stop.dayIndex + 1})`)}`,
      `LOCATION:${escapeIcsText(stop.address || `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`)}`,
      `GEO:${stop.lat.toFixed(6)};${stop.lng.toFixed(6)}`,
      `DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`,
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function buildTripGPX(trip: Trip, stops: TripStop[], cachedRoutes: CachedRoute[]): string {
  const sorted = [...stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
  const nowIso = new Date().toISOString();

  const waypoints = sorted
    .map(
      (s, i) => `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">
    <name>${escapeXml(`D${s.dayIndex + 1} #${i + 1} ${s.name}`)}</name>
    <desc>${escapeXml([s.category, s.address, s.notes].filter(Boolean).join(' · '))}</desc>
    <type>${escapeXml(s.category)}</type>
  </wpt>`
    )
    .join('\n');

  const routeSegments = cachedRoutes
    .filter((r) => r.path && r.path.length > 1)
    .map(
      (r) => `  <trk>
    <name>${escapeXml(`${r.originName} -> ${r.destinationName} (${r.travelMode})`)}</name>
    <trkseg>
${r.path.map((pt) => `      <trkpt lat="${pt.lat.toFixed(6)}" lon="${pt.lng.toFixed(6)}" />`).join('\n')}
    </trkseg>
  </trk>`
    )
    .join('\n');

  const fallbackTrack =
    routeSegments ||
    (sorted.length > 1
      ? `  <trk>
    <name>${escapeXml(trip.title)}</name>
    <trkseg>
${sorted.map((s) => `      <trkpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}" />`).join('\n')}
    </trkseg>
  </trk>`
      : '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GeoInteract" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(trip.title)}</name>
    <desc>${escapeXml(`${trip.destination} (${trip.startDate} to ${trip.endDate})`)}</desc>
    <time>${nowIso}</time>
  </metadata>
${waypoints}
${fallbackTrack}
</gpx>`;
}

export function buildTripMarkdown(
  trip: Trip,
  stops: TripStop[],
  geofences: TripGeofence[],
  alerts: TripAlert[],
  cachedRoutes: CachedRoute[]
): string {
  const sorted = [...stops].sort((a, b) => a.dayIndex - b.dayIndex || a.orderIndex - b.orderIndex);
  const completedCount = sorted.filter((s) => s.status === 'completed').length;
  const pct = sorted.length > 0 ? Math.round((completedCount / sorted.length) * 100) : 0;

  const lines: string[] = [
    `# ${trip.title} — Field & Travel Brief`,
    '',
    `- **Destination**: ${trip.destination}`,
    `- **Dates**: ${trip.startDate} to ${trip.endDate}`,
    `- **Travel Mode**: ${trip.travelMode}`,
    `- **Completion**: ${completedCount}/${sorted.length} stops (${pct}%)`,
    `- **E2EE Fingerprint**: \`${trip.keyFingerprint}\``,
    '',
  ];

  const days = Array.from(new Set(sorted.map((s) => s.dayIndex))).sort((a, b) => a - b);
  for (const d of days) {
    const dayStops = sorted.filter((s) => s.dayIndex === d);
    lines.push(`## Day ${d + 1}`);
    dayStops.forEach((s, idx) => {
      const check = s.status === 'completed' ? 'x' : ' ';
      const meta = [s.category, s.priority.toUpperCase(), s.timeWindow].filter(Boolean).join(' · ');
      lines.push(`- [${check}] **#${idx + 1} ${s.name}** (${meta})`);
      lines.push(`  - Address: ${s.address} (\`${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}\`)`);
      if (s.notes) lines.push(`  - Notes: ${s.notes}`);
      if (s.enterpriseLinks?.length) {
        lines.push(
          `  - Linked Records: ${s.enterpriseLinks
            .map((l) =>
              l.recordUrl
                ? `[${l.target.toUpperCase()} ${l.recordId}](${l.recordUrl})`
                : `${l.target.toUpperCase()} ${l.recordId}`
            )
            .join(', ')}`
        );
      }
    });
    lines.push('');
  }

  if (cachedRoutes.length > 0) {
    lines.push('## Cached Route Legs');
    cachedRoutes.forEach((r) => {
      lines.push(
        `- ${r.originName} → ${r.destinationName}: ${formatDistance(r.distanceMeters)} · ${formatDuration(r.durationMillis)} (${r.travelMode})`
      );
    });
    lines.push('');
  }

  if (geofences.length > 0) {
    lines.push('## Active Geofences & Check-Ins');
    geofences.forEach((g) => {
      const links = g.enterpriseLinks?.length
        ? ' — ' +
          g.enterpriseLinks
            .map((l) => {
              const dwell = l.dwellDurationSeconds
                ? ` (${Math.max(1, Math.round(l.dwellDurationSeconds / 60))}m dwell)`
                : '';
              return l.recordUrl
                ? `[${l.target.toUpperCase()} ${l.recordId}](${l.recordUrl})${dwell}`
                : `${l.target.toUpperCase()} ${l.recordId}${dwell}`;
            })
            .join(', ')
        : '';
      lines.push(`- **${g.label}** (${g.radiusMeters}m, ${g.triggerOn})${links}`);
    });
    lines.push('');
  }

  const impactfulAlerts = alerts.filter((a) => !a.suppressed && a.severity !== 'minor');
  if (impactfulAlerts.length > 0) {
    lines.push('## Travel & Operations Alerts');
    impactfulAlerts.slice(0, 10).forEach((a) => {
      lines.push(`- **${a.title}** (${a.severity}): ${a.body}`);
    });
    lines.push('');
  }

  lines.push(`_Exported from GeoInteract on ${new Date().toLocaleString()}_`);
  return lines.join('\n');
}

export function triggerFileDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportTripICS(trip: Trip, stops: TripStop[]): void {
  triggerFileDownload(`${slugify(trip.title)}.ics`, buildTripICS(trip, stops), 'text/calendar;charset=utf-8');
}

export function exportTripGPX(trip: Trip, stops: TripStop[], cachedRoutes: CachedRoute[]): void {
  triggerFileDownload(
    `${slugify(trip.title)}.gpx`,
    buildTripGPX(trip, stops, cachedRoutes),
    'application/gpx+xml;charset=utf-8'
  );
}

export function exportTripMarkdown(
  trip: Trip,
  stops: TripStop[],
  geofences: TripGeofence[],
  alerts: TripAlert[],
  cachedRoutes: CachedRoute[]
): void {
  triggerFileDownload(
    `${slugify(trip.title)}-brief.md`,
    buildTripMarkdown(trip, stops, geofences, alerts, cachedRoutes),
    'text/markdown;charset=utf-8'
  );
}
