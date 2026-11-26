/**
 * Validates external URLs before binding to `<a href>` so untrusted strings
 * cannot inject `javascript:`, `data:`, or other unsafe URI schemes.
 */
export function sanitizeExternalUrl(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
