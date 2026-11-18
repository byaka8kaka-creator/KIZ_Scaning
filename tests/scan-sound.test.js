import {test} from 'node:test';
import assert from 'node:assert/strict';
import {playScanSound} from '../extension/scan-sound.js';
test('scan sounds are short, distinct, reusable and tolerate unavailable audio', async () => {
  // Unsupported browsers still save scans without throwing.
  playScanSound('success');
  let created = 0;
  const oscillators = [];
  globalThis.AudioContext = class {
    constructor() { created++; this.state = 'suspended'; this.currentTime = 10; this.destination = {}; }
    async resume() { this.state = 'running'; }
    createOscillator() {
      const oscillator = {frequency: {}, connect() {}, disconnect() {}, start(time) {this.started = time;}, stop(time) {this.stopped = time;}};
      oscillators.push(oscillator); return oscillator;
    }
    createGain() {return {gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}, connect() {}, disconnect() {}};}
  };
  playScanSound('success'); await Promise.resolve();
  assert.deepEqual(oscillators.map(o => o.frequency.value), [660, 880]);
  assert.ok(oscillators.at(-1).stopped - 10 < 1.5);
  playScanSound('error'); await Promise.resolve();
  assert.equal(created, 1);
  assert.deepEqual(oscillators.slice(-2).map(o => o.frequency.value), [330, 220]);
  assert.ok(oscillators.at(-1).stopped - 10 < 1.5);
  assert.equal(oscillators[0].stopped, undefined); // Old sound is stopped immediately.
  delete globalThis.AudioContext;
});
