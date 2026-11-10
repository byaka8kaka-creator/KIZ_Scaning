import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligibleReturns, returnDocument, documentBase64, RETURN_INN, RETURN_BATCH_SIZE} from '../extension/returns.js';
const cis = i => String(i).padStart(24, '0');
const row = (i, date = '11.11.2026', status = 'RETIRED') => ({cis: cis(i), cis_full: cis(i) + 'tail', status, expirationDate: date, article: 'A', unit: 'шт'});
test('return eligibility uses local calendar day, strictly future valid dates and deduplicates CIS', () => {
  const rows = [row(1), row(1), row(2, '10.11.2026'), row(3, '09.11.2026'), row(4, '', 'RETIRED'), row(5, '31.11.2026'), row(6, '11.11.2026', 'INTRODUCED'), row(7)];
  assert.deepEqual(eligibleReturns(rows, {[cis(7)]: 'document'}, new Date(2026, 10, 10, 23, 59)).map(r => r.cis), [cis(1)]);
  assert.equal(JSON.parse(returnDocument([row(1)])).trade_participant_inn, RETURN_INN);
  assert.equal(Buffer.from(documentBase64('данные'), 'base64').toString('utf8'), 'данные');
});
test('return worker batches, reuses query token, persists IDs, blocks duplicates and stops on failure', async () => {
  const local = {}, session = {}; let receive, nextTab = 1, fail = false;
  const calls = [], tabs = [];
  const area = data => ({get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values), remove: async key => {delete data[key];}});
  globalThis.chrome = {
    storage: {local: area(local), session: area(session)},
    runtime: {getURL: p => 'https://test/' + p, onMessage: {addListener(fn) {receive = fn;}}},
    action: {onClicked: {addListener() {}}},
    alarms: {clear: async () => {}, create: async () => {}, onAlarm: {addListener() {}}},
    tabs: {create: async () => {const tab = {id: nextTab++}; tabs.push(tab); return tab;}, update: async () => {}},
    windows: {create: async () => ({id: 1, tabs: [{id: nextTab++}]}), remove: async () => {}}
  };
  globalThis.fetch = async (url, options) => {
    calls.push({url, ...options});
    if (url.endsWith('/cises/info')) return new Response(JSON.stringify(JSON.parse(options.body).map(cis => ({cisInfo: {cis}}))));
    if (fail) return new Response('', {status: 403});
    return new Response('438cac2c-fbb5-4ef5-8a51-dfdb0cfea2e1');
  };
  await import('../extension/background.js');
  const app = {url: 'https://test/app.html'};
  const send = (message, sender = app) => new Promise(resolve => receive(message, sender, resolve));
  local.auth = {token: 'previous-query-token', expiresAt: Date.now() + 3600000};
  assert.equal((await send({type: 'query', codes: [cis(1)]})).ok, true);
  local.auth = {token: 'different-token', expiresAt: Date.now() + 3600000};
  const rows = Array.from({length: RETURN_BATCH_SIZE + 1}, (_, i) => row(i, '01.01.2099'));
  assert.equal((await send({type: 'beginReturn', rows, detached: true})).ok, true);
  const signer = {url: 'https://cryptopro.ru/sites/default/files/products/cades/demopage/cades_bes_sample.html', tab: {id: tabs.at(-1).id}};
  assert.equal((await send({type: 'challenge'}, signer)).value.detached, true);
  assert.equal((await send({type: 'signature', signature: 'A'.repeat(100)}, {...signer, tab: {id: 999}})).ok, false);
  assert.equal((await send({type: 'returnSignature', signature: 'A'.repeat(100)})).ok, true);
  const request = calls.at(-1);
  assert.equal(request.headers.Authorization, 'Bearer previous-query-token');
  const body = JSON.parse(request.body);
  assert.equal(body.type, 'LP_RETURN'); assert.equal(body.document_format, 'MANUAL');
  assert.deepEqual(JSON.parse(Buffer.from(body.product_document, 'base64')), {trade_participant_inn: RETURN_INN, return_type: 'OWN_USE_RETURN', products_list: rows.slice(0, RETURN_BATCH_SIZE).map(row => ({ki: row.cis}))});
  assert.equal(local.returnHistory.length, RETURN_BATCH_SIZE);
  fail = true;
  assert.equal((await send({type: 'returnSignature', signature: 'A'.repeat(100)})).ok, false);
  assert.equal((await send({type: 'returnStatus'})).value.state, 'failed');
  assert.equal(local.returnHistory.length, RETURN_BATCH_SIZE);
  fail = false;
  assert.equal((await send({type: 'beginReturn', rows, automatic: true})).ok, true);
  assert.equal(session.returnJob.batch.length, 1);
  assert.equal((await send({type: 'returnSignature', signature: 'A'.repeat(100)})).ok, true);
  assert.equal((await send({type: 'returnStatus'})).value.state, 'complete');
  assert.equal(local.returnHistory.length, RETURN_BATCH_SIZE + 1);
  assert.equal((await send({type: 'beginReturn', rows})).error, 'Товаров на возврат нету');
});
