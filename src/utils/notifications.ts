import { TripAlert, UserPreferences } from '../types/travel';
import { triggerHaptic } from './haptics';

export function shouldTriggerPushNotification(
  alert: TripAlert,
  prefs: UserPreferences
): boolean {
  // Minor updates that don't impact schedule never trigger distracting push pings
  if (alert.severity === 'minor' && prefs.suppressMinorAlerts) {
    return false;
  }
  if (alert.severity === 'minor' && Math.abs(alert.scheduleDeltaMinutes) < 10 && prefs.suppressMinorAlerts) {
    return false;
  }

  switch (alert.category) {
    case 'geofence':
      return prefs.notifyGeofence;
    case 'collab':
      return prefs.notifyCollab;
    case 'schedule':
      return alert.severity === 'last_minute_alert'
        ? prefs.notifyLastMinuteAlerts
        : prefs.notifyScheduleImpact;
    case 'transit':
    case 'weather':
    case 'venue':
      return alert.severity === 'last_minute_alert'
        ? prefs.notifyLastMinuteAlerts
        : prefs.notifyScheduleImpact;
    default:
      return alert.severity !== 'minor';
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function dispatchSmartNotification(
  alert: TripAlert,
  prefs: UserPreferences
): Promise<{ delivered: boolean; suppressed: boolean }> {
  if (!shouldTriggerPushNotification(alert, prefs)) {
    return { delivered: false, suppressed: true };
  }

  triggerHaptic(alert.category === 'geofence' ? 'geofence' : 'warning');

  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && typeof reg.showNotification === 'function') {
          await reg.showNotification(alert.title, {
            body: alert.body,
            icon: '/pwa-192x192.png',
            badge: '/pwa-192x192.png',
            tag: alert.id,
          });
          return { delivered: true, suppressed: false };
        }
      }
      new Notification(alert.title, {
        body: alert.body,
        icon: '/pwa-192x192.png',
        tag: alert.id,
      });
    } catch {
      // Fallback to in-app toast delivery only
    }
  }

  return { delivered: true, suppressed: false };
}
