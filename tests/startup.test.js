import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureAccess, record, safeDetails} from '../extension/diagnostics.js';
test('Chromium-Gost without setAccessLevel or session: worker registers and opens app', async () => {
  const data = {}; let clicked, received; const tabs = [];
  globalThis.chrome = {
    storage: {local: {get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values), remove: async key => {delete data[key];}}},
    runtime: {getURL: path => `chrome-extension://test/${path}`, onMessage: {addListener: fn => {received = fn;}}},
    action: {onClicked: {addListener: fn => {clicked = fn;}}},
    tabs: {create: async options => {tabs.push(options); return {id: 1};}}
  };
  await import('../extension/background.js');
  assert.equal(typeof received, 'function'); assert.equal(typeof clicked, 'function');
  await clicked(); assert.equal(tabs[0].url, 'chrome-extension://test/app.html');
  const reply = await new Promise(resolve => received({type: 'status'}, {url: 'chrome-extension://test/app.html'}, resolve));
  assert.equal(reply.ok, true);
  assert.equal(data.diagnosticLog.some(e => e.event === 'worker.started'), true);
  assert.equal(data.diagnosticLog.some(e => e.event === 'app.opened'), true);
  // Supported but rejected capability is also non-fatal.
  chrome.storage.local.setAccessLevel = async () => {throw new TypeError('unsupported');};
  await configureAccess();
  assert.equal(data.diagnosticLog.some(e => e.event === 'storage.access_control_failed'), true);
  for (let i = 0; i < 505; i++) await record('test.event', {count: i, token: 'SECRET', signature: 'SIGNATURE', cis: 'PRIVATE'});
  assert.equal(data.diagnosticLog.length, 500);
  assert.equal(JSON.stringify(data.diagnosticLog).includes('SECRET'), false);
  assert.deepEqual(safeDetails({operation: '/auth/key', body: 'private', status: 401}), {operation: '/auth/key', status: 401});
});
