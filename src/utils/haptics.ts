export type HapticKind = 'light' | 'medium' | 'success' | 'warning' | 'geofence';

let hapticsEnabledGlobal = true;
let audioCtx: AudioContext | null = null;

export function setHapticsEnabled(enabled: boolean) {
  hapticsEnabledGlobal = enabled;
}

function playSubtleTactileClick(kind: HapticKind) {
  if (typeof window === 'undefined') return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // Subtle micro-tactile audio pulse fallback for iOS Safari where navigator.vibrate is unsupported
  if (!isIOS && 'vibrate' in navigator) return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'geofence' || kind === 'warning' ? 320 : kind === 'success' ? 520 : 180;
    gain.gain.setValueAtTime(0.015, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.035);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.04);
  } catch {
    // Ignore audio context restrictions prior to user gesture
  }
}

export function triggerHaptic(kind: HapticKind = 'light') {
  if (!hapticsEnabledGlobal || typeof window === 'undefined') return;

  const patterns: Record<HapticKind, number | number[]> = {
    light: 12,
    medium: 24,
    success: [15, 35, 22],
    warning: [30, 50, 30],
    geofence: [40, 60, 40, 60, 80],
  };

  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(patterns[kind]);
    } catch {
      // Ignore vibration errors in restricted frames
    }
  }

  playSubtleTactileClick(kind);
}
