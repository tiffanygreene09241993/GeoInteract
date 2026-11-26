let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    try {
      sharedAudioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/**
 * Plays a crisp, low-fatigue harmonic chime via Web Audio API for hands-free
 * arrival, departure, and group check-in cues.
 */
export function playArrivalChime(kind: 'enter' | 'exit' | 'checkin' = 'enter'): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const notes =
      kind === 'enter'
        ? [
            { freq: 587.33, start: 0, dur: 0.22, gain: 0.14 }, // D5
            { freq: 880.0, start: 0.11, dur: 0.34, gain: 0.16 }, // A5
            { freq: 1174.66, start: 0.22, dur: 0.42, gain: 0.12 }, // D6
          ]
        : kind === 'exit'
        ? [
            { freq: 659.25, start: 0, dur: 0.2, gain: 0.11 }, // E5
            { freq: 493.88, start: 0.12, dur: 0.28, gain: 0.1 }, // B4
          ]
        : [
            { freq: 783.99, start: 0, dur: 0.16, gain: 0.12 }, // G5
            { freq: 1046.5, start: 0.09, dur: 0.24, gain: 0.13 }, // C6
          ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note.freq, now + note.start);

      gainNode.gain.setValueAtTime(0.0001, now + note.start);
      gainNode.gain.exponentialRampToValueAtTime(note.gain, now + note.start + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.dur);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(now + note.start);
      osc.stop(now + note.start + note.dur + 0.03);
    }
  } catch {
    // Ignore autoplay restriction errors until user interacts
  }
}

/**
 * Announces arrival or navigation status via the browser Web Speech API
 * when the user explicitly opts in to hands-free voice cues.
 */
export function speakArrivalCue(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const clean = text.trim();
  if (!clean) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore speech synthesis failures on restricted browsers
  }
}
