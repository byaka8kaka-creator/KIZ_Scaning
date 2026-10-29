import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tokenValid, TOKEN_TTL, request, extractCodes, parseResults, formatExpirationDate, excelExpirationDate, correctKeyboardLayout, attachFullCodes} from '../extension/core.js';
import XLSX from '@e965/xlsx';
test('token is reused for 10 hours, expires on boundary', () => {
  const auth = {token: 'test', expiresAt: 1000 + TOKEN_TTL};
  assert.equal(tokenValid(auth, 1000 + TOKEN_TTL - 1), true);
  assert.equal(tokenValid(auth, 1000 + TOKEN_TTL), false);
  assert.equal(tokenValid(null), false);
});
test('GET has no body; signing and CIS requests use expected payload and bearer', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({url, ...options}); return new Response('{}'); };
  await request('/auth/key', {fetchImpl});
  await request('/auth/simpleSignIn', {fetchImpl, body: {uuid: 'u', data: 'signed'}});
  await request('/cises/info', {fetchImpl, body: ['a'.repeat(24)], token: 't'});
  assert.equal(calls[0].method, 'GET'); assert.equal('body' in calls[0], false);
  assert.equal(calls[1].body, '{"uuid":"u","data":"signed"}');
  assert.equal(calls[2].headers.Authorization, 'Bearer t');
  assert.equal(calls[2].body, JSON.stringify(['a'.repeat(24)]));
});
test('API errors preserve status and do not expose response secrets', async () => {
  await assert.rejects(request('/cises/info', {fetchImpl: async () => new Response('SECRET', {status: 401})}), e => e.status === 401 && !e.message.includes('SECRET'));
  await assert.rejects(request('/auth/key', {fetchImpl: async () => new Response('bad json')}), /JSON/);
});
for (const bookType of ['xls', 'xlsx']) test(`${bookType}: import preserves exact text, trims 24 chars, deduplicates, rejects numbers`, () => {
  const code = '010123456789012321AbCdEf';
  assert.equal(code.length, 24);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['КИЗ'], [code + 'extra'], [code], [123456789012345], ['short']]), 'Лист');
  const parsed = XLSX.read(XLSX.write(book, {type: 'buffer', bookType}), {type: 'buffer'});
  const rows = XLSX.utils.sheet_to_json(parsed.Sheets['Лист'], {header: 1, raw: true});
  const result = extractCodes(rows, 0, true);
  assert.deepEqual(result.codes, [code]); assert.equal(result.errors.length, 2);
});
test('CIS response maps nested and flat records by cis; missing and API errors stay visible', () => {
  const parsed = parseResults([{cisInfo: {cis: 'a', gtin: '01', expirationDate: '2027-01-01'}}, {cis: 'b', errorCode: 404}], ['b', 'a', 'c']);
  assert.match(parsed[0].error, /404/); assert.equal(parsed[1].gtin, '01'); assert.equal(parsed[1].expirationDate, '01.01.2027'); assert.match(parsed[2].error, /Нет данных/);
  assert.throws(() => parseResults({}, []), /массив/);
});

test('expiration dates omit time and timezone without shifting calendar day', () => {
  for (const [input, expected] of [
    ['2027-10-05T00:00:00.000Z', '05.10.2027'],
    ['2027-10-19T23:00:00-05:00', '19.10.2027'],
    ['2028-02-29', '29.02.2028'], ['', ''], [null, ''],
    ['2027-02-29', '2027-02-29'], ['unknown', 'unknown']
  ]) assert.equal(formatExpirationDate(input), expected);
  const serial = excelExpirationDate('05.10.2027');
  const decoded = XLSX.SSF.parse_date_code(serial);
  assert.deepEqual([decoded.y, decoded.m, decoded.d, decoded.H, decoded.M, decoded.S], [2027, 10, 5, 0, 0, 0]);
  assert.equal(excelExpirationDate(''), null);
  assert.equal(excelExpirationDate('31.02.2027'), null);
});

test('Russian scanner layout preserves case, full payload and GS; API receives 24 chars', () => {
  const raw = '0104650096358972215чоПФт\u001d931СКн';
  const full = '0104650096358972215xjGAn\u001d931CRy';
  assert.equal(correctKeyboardLayout(raw), full);
  assert.equal(correctKeyboardLayout(full), full);
  assert.equal(correctKeyboardLayout('ёЁхХъЪжЖэЭбБюЮ'), "`~[{]};:'\",<.>");
  const imported = extractCodes([[raw], [full], [full + 'extra']], 0, false);
  assert.deepEqual(imported.codes, [full.slice(0, 24)]);
  assert.deepEqual(imported.fullCodes, [full, full + 'extra']);
  const rows = attachFullCodes([{cis: imported.codes[0], gtin: '01'}], imported.fullCodes);
  assert.deepEqual(rows.map(r => r.cis_full), imported.fullCodes);
  assert.equal(rows.length, 2);
});
