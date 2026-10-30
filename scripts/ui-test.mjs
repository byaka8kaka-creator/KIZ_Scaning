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
const automaticWindows = [], removedWindows = [];
let alarmListener;
const alarms = new Map();
const storage = Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, {
  setAccessLevel: async () => {},
  get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values),
  remove: async key => { delete data[key]; }
}]));
globalThis.chrome = {
  storage, action: {onClicked: {addListener() {}}},
  windows: {create: async options => {automaticWindows.push(options); return {id: 7, tabs: [{id: 42}]};}, remove: async id => {removedWindows.push(id);}},
  alarms: {create: async (name, options) => {alarms.set(name, options);}, clear: async name => alarms.delete(name), onAlarm: {addListener(fn) {alarmListener = fn;}}},
  tabs: {create: async () => ({id: 42}), update: async () => ({id: 42})},
  runtime: {getURL: path => `https://kiz.test/${path}`, onMessage: {addListener(fn) {listener = fn;}}}
};
globalThis.fetch = async (url, options) => {
  calls.push({url, ...options});
  if (url.endsWith('/auth/key')) return new Response(JSON.stringify({uuid: 'uuid', data: 'challenge-data'}));
  if (url.endsWith('/auth/simpleSignIn')) return new Response(JSON.stringify({token: 'test-token'}));
  if (failStatus) { const status = failStatus; failStatus = 0; return new Response('', {status}); }
  return new Response(JSON.stringify(JSON.parse(options.body).map(cis => ({cisInfo: {cis, gtin: '01234567890123', expirationDate: '2027-10-05T00:00:00.000Z', status: 'INTRODUCED'}}))));
};
await import('../extension/background.js');
const message = (data, sender = {url: 'https://kiz.test/app.html'}) => new Promise(resolve => listener(data, sender, resolve));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium', headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('sendToBackground', data => message(data));
  await page.exposeFunction('readDiagnosticLog', key => ({[key]: stores.local[key]}));
  await page.exposeFunction('storeBrowserSettings', values => storage.local.set(values));
  await page.addInitScript(() => {
    window.archiveWrites = [];
    const files = new Set();
    window.showDirectoryPicker = window.workingDirectoryPicker = async () => ({
      queryPermission: async () => 'granted',
      getFileHandle: async (name, options) => {
        if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
        files.add(name);
        return {createWritable: async () => ({write: async bytes => {window.archiveWrites.push({name, bytes: Array.from(new Uint8Array(bytes))});}, close: async () => {}, abort: async () => {}})};
      }
    });
    window.chrome = {runtime: {sendMessage: data => window.sendToBackground(data), getManifest: () => ({version: '1.0.1'})}, storage: {local: {get: key => window.readDiagnosticLog(key), set: values => window.storeBrowserSettings(values)}, onChanged: {addListener() {}}}};
  });
  await page.route('https://kiz.test/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!['app.html', 'app.css', 'app.js', 'core.js', 'diagnostics.js', 'archive.js', 'catalog.js', 'vendor/xlsx.full.min.js'].includes(path)) return route.abort();
    await route.fulfill({body: await readFile(new URL('../' + (process.env.KIZ_TEST_SOURCE || 'dist') + '/' + path, import.meta.url)), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'});
  });
  await page.goto('https://kiz.test/app.html');
  await page.getByText('Требуется авторизация с электронной подписью.').waitFor();
  await page.locator('#chooseArchive').click();
  await page.locator('#archiveStatus').filter({hasText: 'Автосохранение включено'}).waitFor();
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
  await page.locator('#scanComment').fill('Партия А');
  await page.locator('#scanInput').fill('x'.repeat(23));
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Отсканирован не КИЗ:', {exact: false}).waitFor();
  assert.equal(await page.locator('#commentHistory option').count(), 0);
  assert.equal(await page.locator('#run').isDisabled(), true);
  const scanned = '0104650096359269215&i88B';
  const scannedFull = scanned + '\u001d931CRy';
  await page.locator('#scanInput').fill('0104650096359269215?ш88И\u001d931СКн');
  await page.locator('#scanInput').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#commentHistory option').length === 1);
  assert.equal(stores.local.recentScanComments[0], 'Партия А');
  assert.equal(await page.locator('#scanInput').inputValue(), '');
  assert.equal(await page.locator('#run').isEnabled(), true);
  await page.locator('#scanInput').fill('0104650096359269215?ш88И\u001d931СКн');
  await page.locator('#scanInput').press('Enter');
  await page.getByText('Этот КИЗ уже добавлен.', {exact: false}).waitFor();
  await page.locator('#closeScan').click();
  await page.locator('#run').click();
  await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
  assert.deepEqual(JSON.parse(calls.find(c => c.url.endsWith('/cises/info')).body), [scanned]);
  assert.equal(await page.locator('#results tr td').nth(1).textContent(), scannedFull);
  assert.equal(await page.locator('#results tr td').nth(4).textContent(), 'Партия А');
  await page.locator('#archiveStatus').filter({hasText: 'Автоматически сохранено'}).waitFor();
  const archived = await page.evaluate(() => archiveWrites.at(-1));
  assert.match(archived.name, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.xlsx$/);
  const archiveBook = XLSX.read(Buffer.from(archived.bytes), {type: 'buffer', cellNF: true});
  const archiveRows = XLSX.utils.sheet_to_json(archiveBook.Sheets['КИЗ']);
  assert.equal(archiveRows[0]['Комментарий'], 'Партия А');
  assert.equal(archiveRows[0].cis_full, scannedFull);
  assert.equal(await page.locator('#results tr td').nth(5).textContent(), 'Не найден в справочнике');
  const apiCallsBeforeCatalog = calls.length;
  async function uploadCatalog(rows, bookType = 'xlsx') {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Справочник');
    await page.locator('#catalogFile').setInputFiles({name: `catalog.${bookType}`, mimeType: 'application/octet-stream', buffer: XLSX.write(book, {type: 'buffer', bookType})});
  }
  await uploadCatalog([['GTIN', 'Артикул'], ['01234567890123', '000A'], ['01234567890124', '000A']], 'xls');
  await page.locator('#catalogStatus').filter({hasText: 'Записей: 2.'}).waitFor();
  await page.locator('#archiveStatus').filter({hasText: 'обновлёнными артикулами сохранены'}).waitFor();
  assert.equal(await page.locator('#results tr td').nth(5).textContent(), '000A');
  assert.equal(calls.length, apiCallsBeforeCatalog);
  const catalogArchive = await page.evaluate(() => archiveWrites.at(-1));
  const archivedArticles = XLSX.read(Buffer.from(catalogArchive.bytes), {type: 'buffer'});
  assert.equal(XLSX.utils.sheet_to_json(archivedArticles.Sheets['КИЗ'])[0]['Артикул'], '000A');
  const previousCatalog = JSON.stringify(stores.local.articleCatalog);
  await uploadCatalog([['GTIN', 'Артикул'], ['01234567890123', 'wrong'], ['01234567890123', 'other']]);
  await page.locator('#catalogErrors').filter({hasText: 'строки 2 и 3'}).waitFor();
  assert.equal(JSON.stringify(stores.local.articleCatalog), previousCatalog);
  assert.equal(await page.locator('#results tr td').nth(5).textContent(), '000A');
  await uploadCatalog([['GTIN', 'Артикул'], ['01234567890123', '000B'], ['01234567890124', '000B']]);
  await page.locator('#results tr td').nth(5).filter({hasText: '000B'}).waitFor();
  await page.locator('#loadCatalog').waitFor({state: 'visible'});
  assert.equal(calls.length, apiCallsBeforeCatalog);
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
  assert.equal(await page.locator('th').nth(3).textContent(), 'Срок годности');
  assert.equal(exported.Sheets['КИЗ'].D1.v, 'Срок годности');
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0]['Артикул'], '000B');
  assert.equal(archiveBook.Sheets['КИЗ'].D1.v, 'Срок годности');
  const dateCell = exported.Sheets['КИЗ'].D2;
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0].cis_full, code + 'tail');
  assert.equal(dateCell.t, 'n');
  assert.equal(dateCell.z, 'dd"."mm"."yyyy');
  assert.equal(XLSX.SSF.format(dateCell.z, dateCell.v), '05.10.2027');
  const date = XLSX.SSF.parse_date_code(dateCell.v);
  assert.deepEqual([date.y, date.m, date.d, date.H, date.M, date.S], [2027, 10, 5, 0, 0, 0]);
  // Archive failure must preserve successful API results and allow manual export.
  await page.evaluate(() => { window.showDirectoryPicker = async () => ({queryPermission: async () => 'denied'}); });
  await page.locator('#chooseArchive').click();
  await page.locator('#run').click();
  await page.locator('#archiveStatus').filter({hasText: 'Автоархив не сохранён'}).waitFor();
  assert.equal(await page.locator('#export').isEnabled(), true);
  assert.equal(await page.locator('#results tr').count(), 2);
  const jsonPromise = page.waitForEvent('download');
  await page.locator('#json').click();
  const jsonDownload = await jsonPromise;
  const jsonRows = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  assert.equal(jsonRows[0]['Срок годности'], '05.10.2027');
  assert.equal('expirationDate' in jsonRows[0], false);
  assert.equal(jsonRows[0].cis_full, code + 'tail');
  assert.equal(jsonRows.length, 2);
  assert.equal(jsonRows[0]['Артикул'], '000B');
  assert.equal('article' in jsonRows[0], false);
  assert.equal(jsonRows[0]['Статус'], 'INTRODUCED');
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0]['Статус'], 'INTRODUCED');
  assert.equal(archiveRows[0]['Статус'], 'INTRODUCED');
  assert.equal(await page.locator('#results tr').first().locator('td').nth(6).textContent(), 'INTRODUCED');
  await page.evaluate(() => { window.showDirectoryPicker = window.workingDirectoryPicker; });
  await page.locator('#chooseArchive').click();
  const beforeBarcodeCalls = calls.length;
  await page.locator('#scanBarcode').click();
  await page.locator('#barcodeComment').fill('Без маркировки');
  const historyBefore = JSON.stringify(stores.local.recentScanComments);
  for (const invalid of ['123456789012', '12345678901234', '123456789012a', '123456789012я', ' 1234567890123', '123456789012!']) {
    await page.locator('#barcodeInput').fill(invalid);
    await page.locator('#barcodeInput').press('Enter');
    assert.equal(await page.locator('#barcodeStatus').textContent(), 'Отсканирован не ШК');
    assert.equal(await page.locator('#results tr').count(), 2);
    assert.equal(JSON.stringify(stores.local.recentScanComments), historyBefore);
  }
  for (const date of ['2028-02-29', '2029-03-01']) {
    await page.locator('#barcodeDate').fill(date);
    await page.locator('#barcodeInput').fill('1234567890123');
    await page.locator('#barcodeInput').press('Enter');
  }
  assert.equal(calls.length, beforeBarcodeCalls);
  assert.equal(await page.locator('#results tr').count(), 4);
  assert.deepEqual(await page.locator('#results tr').nth(2).locator('td').allTextContents(),
    ['', '', '01234567890123', '29.02.2028', 'Без маркировки', '000B', '', '']);
  assert.equal(stores.local.recentScanComments[0], 'Без маркировки');
  await page.locator('#closeBarcode').click();
  await page.waitForFunction(() => archiveWrites.some(w => {
    const b = XLSX.read(new Uint8Array(w.bytes), {type: 'array'});
    return XLSX.utils.sheet_to_json(b.Sheets['КИЗ']).length === 4;
  }));
  const barcodeJsonPromise = page.waitForEvent('download');
  await page.locator('#json').click();
  const barcodeJson = JSON.parse(await readFile(await (await barcodeJsonPromise).path(), 'utf8'));
  assert.equal(barcodeJson[2].cis, ''); assert.equal(barcodeJson[2].cis_full, '');
  assert.equal(barcodeJson[2].gtin, '01234567890123');
  assert.equal(barcodeJson[2]['Срок годности'], '29.02.2028');
  assert.equal(barcodeJson[3]['Срок годности'], '01.03.2029');
  assert.equal(barcodeJson[2]['Статус'], '');
  const barcodeExcelPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const barcodeBook = XLSX.read(await readFile(await (await barcodeExcelPromise).path()), {type: 'buffer', cellNF: true});
  assert.equal(XLSX.utils.sheet_to_json(barcodeBook.Sheets['КИЗ'])[2].gtin, '01234567890123');
  assert.equal(barcodeBook.Sheets['КИЗ'].D4.t, 'n');
  await page.locator('#run').click();
  await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
  assert.deepEqual(JSON.parse(calls.at(-1).body), [code]);
  assert.equal(await page.locator('#results tr').count(), 4);
  await page.locator('#scanBarcode').click(); await page.locator('#clearBarcodes').click();
  assert.equal(await page.locator('#results tr').count(), 2);
  await page.locator('#closeBarcode').click();
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
  // Automatic mode: first valid Larisa in visual list order, no manual clicks.
  stores.local.auth.expiresAt = Date.now() - 1;
  await message({type: 'begin', automatic: true});
  assert.deepEqual(automaticWindows[0], {url: 'about:blank', type: 'popup', state: 'minimized', focused: false});
  assert.ok(alarms.has('automatic-auth'));
  await signer.route('https://cryptopro.ru/**', route => route.fulfill({contentType: 'text/html', body: `<html><head><meta charset="utf-8"></head><body>
    <select id="CertListBox"><option value="expired">❌Труфанова Лариса</option><option value="other">✅Труфанов Вячеслав</option><option value="first">✅CN=Труфанова Лариса Анатольевна; первый</option><option value="second">✅Труфанова Лариса; второй</option></select>
    <label><input id="detached" type="checkbox" checked>Отделенная подпись</label><label><input id="verify" type="checkbox" checked>Проверять подписанта</label>
    <textarea id="DataToSignTxtBox">Hello World</textarea><button id="sign">Подписать</button><textarea id="SignatureTxtBox"></textarea></body></html>`}));
  await signer.reload();
  await signer.evaluate(() => {
    window.chrome = {runtime: {sendMessage: data => window.signerMessage(data)}};
    document.getElementById('sign').onclick = () => {
      window.signedWith = document.getElementById('CertListBox').value;
      window.signedData = document.getElementById('DataToSignTxtBox').value;
      window.detachedAtSign = document.getElementById('detached').checked;
      window.verifyAtSign = document.getElementById('verify').checked;
      document.getElementById('SignatureTxtBox').value = 'C'.repeat(100);
    };
  });
  await signer.addScriptTag({path: new URL('../extension/cryptopro.js', import.meta.url).pathname});
  await signer.waitForFunction(() => window.signerMessage({type: 'challenge'}).then(r => !r.ok));
  assert.deepEqual(await signer.evaluate(() => [signedWith, signedData, detachedAtSign, verifyAtSign]), ['first', 'challenge-data', false, false]);
  assert.equal(stores.local.automaticAuth.state, 'success');
  assert.equal(removedWindows.at(-1), 7);
  assert.equal(alarms.has('automatic-auth'), false);
  const windowCount = automaticWindows.length;
  await message({type: 'begin', automatic: true});
  assert.equal(automaticWindows.length, windowCount); // Existing 10-hour token reused.
  stores.local.auth.expiresAt = Date.now() - 1;
  await message({type: 'begin', automatic: true});
  // A Larisa without a green check must never be used.
  await signer.reload();
  await signer.clock.install();
  await signer.evaluate(() => {
    for (const option of document.querySelectorAll('option')) option.textContent = option.textContent.replaceAll('✅', '❌');
    window.chrome = {runtime: {sendMessage: async data => {
      const result = await window.signerMessage(data);
      if (data.type === 'challenge') window.challengeReceived = true;
      return result;
    }}};
  });
  await signer.addScriptTag({path: new URL('../extension/cryptopro.js', import.meta.url).pathname});
  await signer.waitForFunction(() => window.challengeReceived);
  await signer.clock.runFor(46000);
  await page.waitForFunction(() => window.sendToBackground({type: 'status'}).then(r => r.value.automaticAuth.state === 'failed'));
  assert.equal(stores.local.automaticAuth.reason, 'certificate');
  await signer.clock.resume();
  await message({type: 'begin', automatic: true});
  alarmListener({name: 'automatic-auth'});
  await page.waitForFunction(() => window.sendToBackground({type: 'status'}).then(r => r.value.automaticAuth.state === 'failed'));
  assert.equal(stores.local.automaticAuth.reason, 'timeout');
  assert.equal(stores.session.challenge, undefined);
  await page.locator('#scan').click();
  for (let i = 1; i <= 6; i++) {
    await page.locator('#scanComment').fill(`Комментарий ${i}`);
    await page.locator('#scanInput').fill('K'.repeat(24));
    await page.locator('#scanInput').press('Enter');
  }
  assert.deepEqual(await page.locator('#commentHistory option').evaluateAll(nodes => nodes.map(node => node.value)), ['Комментарий 6', 'Комментарий 5', 'Комментарий 4', 'Комментарий 3', 'Комментарий 2']);
  await page.locator('#closeScan').click();
  page.once('dialog', async dialog => {
    assert.equal(dialog.message(), 'Вы уверены что хотите очистить список отсканированных и загруженных КИЗ');
    await dialog.dismiss();
  });
  await page.locator('#clearData').click();
  assert.equal(await page.locator('#run').isEnabled(), true);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clearData').click();
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#file').inputValue(), '');
  assert.equal(await page.locator('#sheet option').count(), 0);
  assert.equal(await page.locator('#results tr').count(), 0);
  assert.equal(await page.locator('#scanComment').inputValue(), '');
  assert.equal(await page.locator('#commentHistory option').count(), 5);
  // Barcode-only scanning works with expired authorization; clearing CIS preserves barcodes.
  const noAuthCalls = calls.length;
  await page.locator('#scanBarcode').click();
  await page.locator('#barcodeInput').fill('0000000000001');
  await page.locator('#barcodeInput').press('Enter');
  await page.locator('#closeBarcode').click();
  assert.equal(await page.locator('#results tr').count(), 1);
  assert.equal(await page.locator('#results td').nth(2).textContent(), '00000000000001');
  assert.equal(await page.locator('#json').isEnabled(), true);
  assert.equal(calls.length, noAuthCalls);
  await page.locator('#scan').click();
  await page.locator('#scanInput').fill('M'.repeat(24));
  await page.locator('#scanInput').press('Enter');
  await page.locator('#clearScans').click();
  await page.locator('#closeScan').click();
  assert.equal(await page.locator('#results tr').count(), 1);
  await page.locator('#scanBarcode').click(); await page.locator('#clearBarcodes').click();
  await page.locator('#closeBarcode').click();
  assert.equal(await page.locator('#results tr').count(), 0);
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
  await page.locator('#catalogStatus').filter({hasText: 'Записей: 2.'}).waitFor();
  assert.equal(stores.local.articleCatalog.entries[0][1], '000B');
  await page.locator('#error').filter({hasText: 'Библиотека Excel не загружена'}).waitFor();
  assert.equal(await page.locator('#file').isDisabled(), true);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#progress').innerText(), 'Пока нет результатов.');
  console.log('PASS: real Chromium UI + background logic with mocked Chrome APIs/HTTP: XLS/XLSX, signing payload, token reuse/expiry, 403 retention, 401 reset, Excel export, sender validation, CryptoPro DOM bridge (fixture).');
} finally { await browser.close(); }
