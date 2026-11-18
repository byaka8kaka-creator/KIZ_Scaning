// Short shared notification tones, generated locally without audio downloads.
const tones = {
  success: [[660, 0, 0.12], [880, 0.14, 0.18]],
  error: [[330, 0, 0.16], [220, 0.18, 0.22]]
};
let context, active = [], generation = 0;
export function playScanSound(result) {
  const current = ++generation;
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio || !tones[result]) return;
    context ??= new Audio();
    // Start/resume inside the Save/Enter user gesture to meet browser audio rules.
    const ready = context.state === 'suspended' ? context.resume() : Promise.resolve();
    void ready.then(() => {
      if (current !== generation) return;
      for (const oscillator of active) { try { oscillator.stop(); } catch {} }
      active = [];
      for (const [frequency, offset, duration] of tones[result]) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.14, start + 0.015);
        gain.gain.linearRampToValueAtTime(0, start + duration);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); active = active.filter(item => item !== oscillator); };
        active.push(oscillator);
        oscillator.start(start); oscillator.stop(start + duration);
      }
    }).catch(() => {});
  } catch { /* Audio availability must never prevent saving a scan. */ }
}
