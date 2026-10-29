// Real Chromium UI + real background module, mocked Chrome APIs and remote HTTP.
// This does not validate Chrome's extension loader or real CryptoPro signing.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import XLSX from '@e965/xlsx';
const stores = {local: {}, session: {}};
let listener;
const calls = [];
let failStatus = 0;
const storage = Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, {
  setAccessLevel: async () => {},
  get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values),
  remove: async key => { delete data[key]; }
}]));
globalThis.chrome = {
  storage, action: {onClicked: {addListener() {}}},
  tabs: {create: async () => ({id: 42}), update: async () => ({id: 42})},
  runtime: {getURL: path => `https://kiz.test/${path}`, onMessage: {addListener(fn) {listener = fn;}}}
};
globalThis.fetch = async (url, options) => {
  calls.push({url, ...options});
  if (url.endsWith('/auth/key')) return new Response(JSON.stringify({uuid: 'uuid', data: 'challenge-data'}));
  if (url.endsWith('/auth/simpleSignIn')) return new Response(JSON.stringify({token: 'test-token'}));
  if (failStatus) { const status = failStatus; failStatus = 0; return new Response('', {status}); }
  return new Response(JSON.stringify(JSON.parse(options.body).map(cis => ({cisInfo: {cis, gtin: '01234567890123', expirationDate: '2027-10-05T00:00:00.000Z'}}))));
};
await import('../extension/background.js');
const message = (data, sender = {url: 'https://kiz.test/app.html'}) => new Promise(resolve => listener(data, sender, resolve));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium', headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('sendToBackground', data => message(data));
  await page.exposeFunction('readDiagnosticLog', () => ({diagnosticLog: stores.local.diagnosticLog || []}));
  await page.addInitScript(() => {
    window.chrome = {runtime: {sendMessage: data => window.sendToBackground(data), getManifest: () => ({version: '1.0.1'})}, storage: {local: {get: () => window.readDiagnosticLog()}, onChanged: {addListener() {}}}};
  });
  await page.route('https://kiz.test/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!['app.html', 'app.css', 'app.js', 'core.js', 'diagnostics.js', 'vendor/xlsx.full.min.js'].includes(path)) return route.abort();
    await route.fulfill({body: await readFile(new URL('../' + (process.env.KIZ_TEST_SOURCE || 'dist') + '/' + path, import.meta.url)), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'});
  });
  await page.goto('https://kiz.test/app.html');
  await page.getByText('Требуется авторизация с электронной подписью.').waitFor();
  await page.locator('#login').click();
  await page.getByText(/Подпишите данные в открывшейся/).waitFor();
  await page.locator('summary').click();
  await page.locator('#signature').fill('A'.repeat(100));
  await page.locator('#signIn').click();
  await page.getByText(/Авторизация действует до/).waitFor();
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].body, undefined);
  assert.deepEqual(JSON.parse(calls[1].body), {uuid: 'uuid', data: 'A'.repeat(100)});
  assert.equal((await message({type: 'begin'})).value.valid, true);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/key')).length, 1);
  await page.locator('#scan').click();
  await page.locator('#scanInput').fill('x'.repeat(23));
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Отсканирован не КИЗ:', {exact: false}).waitFor();
  assert.equal(await page.locator('#run').isDisabled(), true);
  const scanned = '0104650096358972215xjGAn';
  const scannedFull = scanned + '\u001d931CRy';
  await page.locator('#scanInput').fill('0104650096358972215чоПФт\u001d931СКн');
  await page.locator('#scanInput').press('Enter');
  assert.equal(await page.locator('#scanInput').inputValue(), '');
  assert.equal(await page.locator('#run').isEnabled(), true);
  await page.locator('#scanInput').fill('0104650096358972215чоПФт\u001d931СКн');
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Этот КИЗ уже добавлен.', {exact: false}).waitFor();
  await page.locator('#closeScan').click();
  await page.locator('#run').click();
  await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
  assert.deepEqual(JSON.parse(calls.find(c => c.url.endsWith('/cises/info')).body), [scanned]);
  assert.equal(await page.locator('#results tr td').nth(1).textContent(), scannedFull);
  const book = XLSX.utils.book_new();
  const code = scanned;
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['КИЗ'], [code + 'tail'], [code]]), 'Коды');
  for (const bookType of ['xls', 'xlsx']) {
    await page.locator('#file').setInputFiles({name: `codes.${bookType}`, mimeType: 'application/octet-stream', buffer: XLSX.write(book, {type: 'buffer', bookType})});
    await page.getByText('Уникальных КИЗ: 1. Ошибок: 0.').waitFor();
    await page.locator('#run').click();
    await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
    assert.match(await page.locator('#results').innerText(), /05\.10\.2027/);
    const query = calls.find(c => c.url.endsWith('/cises/info'));
    assert.equal(query.headers.Authorization, 'Bearer test-token'); assert.deepEqual(JSON.parse(query.body), [code]);
  }
  // Manual codes survive file replacement and deduplicate against imported codes.
  await page.locator('#scan').click();
  await page.locator('#scanInput').fill('Z'.repeat(25));
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Вручную добавлено: 2. Всего уникальных КИЗ: 2.').waitFor();
  await page.locator('#scanInput').fill('Z'.repeat(25));
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Этот КИЗ уже добавлен.', {exact: false}).waitFor();
  await page.locator('#clearScans').click();
  await page.getByText('Вручную добавлено: 0. Всего уникальных КИЗ: 1.').waitFor();
  await page.locator('#scanInput').press('Escape');
  assert.equal(await page.locator('#scanDialog').isVisible(), false);
  await page.locator('#run').click();
  await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloadPromise;
  const exported = XLSX.read(await readFile(await download.path()), {type: 'buffer', cellNF: true});
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0].cis, code);
  const dateCell = exported.Sheets['КИЗ'].D2;
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0].cis_full, code + 'tail');
  assert.equal(dateCell.t, 'n');
  assert.equal(dateCell.z, 'dd"."mm"."yyyy');
  assert.equal(XLSX.SSF.format(dateCell.z, dateCell.v), '05.10.2027');
  const date = XLSX.SSF.parse_date_code(dateCell.v);
  assert.deepEqual([date.y, date.m, date.d, date.H, date.M, date.S], [2027, 10, 5, 0, 0, 0]);
  const jsonPromise = page.waitForEvent('download');
  await page.locator('#json').click();
  const jsonDownload = await jsonPromise;
  const jsonRows = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  assert.equal(jsonRows[0].expirationDate, '05.10.2027');
  assert.equal(jsonRows[0].cis_full, code + 'tail');
  assert.equal(jsonRows.length, 2);
  failStatus = 403;
  await page.locator('#run').click(); await page.locator('#error').filter({hasText: /HTTP 403/}).waitFor();
  assert.equal(stores.local.auth.token, 'test-token');
  failStatus = 401;
  await page.locator('#run').click(); await page.locator('#error').filter({hasText: /Токен недействителен/}).waitFor();
  assert.equal(stores.local.auth, undefined);
  await message({type: 'begin'});
  const denied = await message({type: 'signature', signature: 'A'.repeat(100)}, {url: 'https://evil.test/'});
  assert.equal(denied.ok, false);
  await message({type: 'signature', signature: 'A'.repeat(100)});
  stores.local.auth.expiresAt = Date.now() - 1;
  assert.equal((await message({type: 'status'})).value.valid, false);
  await message({type: 'begin'});
  assert.equal(calls.filter(c => c.url.endsWith('/auth/key')).length, 3);
  const signer = await browser.newPage();
  await signer.exposeFunction('signerMessage', data => message(data, {url: 'https://cryptopro.ru/sites/default/files/products/cades/demopage/cades_bes_sample.html', tab: {id: 42}}));
  await signer.route('https://cryptopro.ru/**', route => route.fulfill({contentType: 'text/html', body: '<html><body><textarea id="DataToSignTxtBox">Hello World</textarea><textarea id="SignatureTxtBox"></textarea></body></html>'}));
  await signer.goto('https://cryptopro.ru/sites/default/files/products/cades/demopage/cades_bes_sample.html');
  await signer.evaluate(() => { window.chrome = {runtime: {sendMessage: data => window.signerMessage(data)}}; });
  await signer.addScriptTag({path: new URL('../extension/cryptopro.js', import.meta.url).pathname});
  await signer.waitForFunction(() => [...document.body.children].some(e => e.tagName === 'DIV'));
  const cdp = await signer.context().newCDPSession(signer);
  async function panelClick(text) {
    const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
    let target;
    function walk(node) {
      if (node.nodeName === 'BUTTON' && node.children?.some(c => c.nodeValue === text)) target = node.backendNodeId;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
    }
    walk(root); assert.ok(target);
    const {object} = await cdp.send('DOM.resolveNode', {backendNodeId: target});
    await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: 'function(){this.click()}'});
  }
  await panelClick('Подставить данные для подписи');
  assert.equal(await signer.locator('#DataToSignTxtBox').inputValue(), 'challenge-data');
  await signer.locator('#SignatureTxtBox').fill('B'.repeat(100));
  await panelClick('Передать готовую подпись в КИЗ');
  await signer.waitForFunction(() => window.signerMessage({type: 'challenge'}).then(r => !r.ok));
  assert.equal(stores.local.auth.token, 'test-token');
  if (process.env.KIZ_TEST_WORKBOOK) {
    await page.locator('#file').setInputFiles(process.env.KIZ_TEST_WORKBOOK);
    await page.getByText('Уникальных КИЗ: 8. Ошибок: 0.').waitFor();
    assert.equal(await page.locator('#header').isChecked(), false);
    assert.equal(await page.locator('#run').isEnabled(), true);
    assert.equal(await page.locator('#sheet').inputValue() !== '', true);
    assert.equal(await page.locator('#column').inputValue(), '0');
  }
  const logPromise = page.waitForEvent('download');
  await page.locator('#downloadLog').click();
  const logDownload = await logPromise;
  const logText = await readFile(await logDownload.path(), 'utf8');
  const report = JSON.parse(logText);
  assert.ok(report.events.some(e => e.event === 'http.completed'));
  assert.equal(logText.includes('test-token'), false);
  assert.equal(logText.includes('challenge-data'), false);
  assert.equal(logText.includes(code), false);
  assert.equal(logText.includes('A'.repeat(100)), false);
  await page.locator('#clearLog').click();
  await page.getByText('Журнал очищен.').waitFor();
  assert.deepEqual(stores.local.diagnosticLog, []);
  assert.deepEqual(errors, []);
  await page.route('https://kiz.test/vendor/xlsx.full.min.js', route => route.abort());
  await page.reload();
  await page.locator('#error').filter({hasText: 'Библиотека Excel не загружена'}).waitFor();
  assert.equal(await page.locator('#file').isDisabled(), true);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#progress').innerText(), 'Пока нет результатов.');
  console.log('PASS: real Chromium UI + background logic with mocked Chrome APIs/HTTP: XLS/XLSX, signing payload, token reuse/expiry, 403 retention, 401 reset, Excel export, sender validation, CryptoPro DOM bridge (fixture).');
} finally { await browser.close(); }
