import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import XLSX from '@e965/xlsx';
const profile = await mkdtemp(join(tmpdir(), 'kiz-test-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  ignoreDefaultArgs: ['--disable-extensions'],
  executablePath: process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--enable-unsafe-extension-debugging']
});
try {
  const browserSession = await context.browser().newBrowserCDPSession();
  const loaded = await browserSession.send('Extensions.loadUnpacked', {path: extension});
  console.log('Loaded extension', loaded.id);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  console.log('Extension worker loaded');
  await worker.evaluate(() => {
    globalThis.testCalls = [];
    globalThis.failNext = false;
    globalThis.fetch = async (url, options) => {
      testCalls.push({url, method: options.method, headers: options.headers, body: options.body});
      if (url.endsWith('/auth/key')) return new Response(JSON.stringify({uuid: 'test-uuid', data: 'challenge-data'}));
      if (url.endsWith('/auth/simpleSignIn')) return new Response(JSON.stringify({token: 'test-token'}));
      if (failNext) { failNext = false; return new Response('', {status: 401}); }
      return new Response(JSON.stringify(JSON.parse(options.body).map(cis => ({cisInfo: {cis, gtin: '01234567890123', expirationDate: '2027-10-02'}}))));
    };
  });
  await context.route('https://cryptopro.ru/**', route => route.fulfill({contentType: 'text/html', body: '<html><body><select><option>Тестовый сертификат</option></select><textarea id="DataToSignTxtBox">Hello World</textarea><button id="sign">Подписать</button><textarea id="SignatureTxtBox"></textarea><script>document.getElementById("sign").onclick = () => document.getElementById("SignatureTxtBox").value = "' + 'A'.repeat(100) + '";</script></body></html>'}));
  const page = await context.newPage();
  const failures = []; page.on('pageerror', e => failures.push(e.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.getByText('Требуется авторизация с электронной подписью.').waitFor();
  const signerPromise = context.waitForEvent('page');
  await page.locator('#login').click();
  const signer = await signerPromise;
  await signer.waitForURL('https://cryptopro.ru/**');
  console.log('Signing page opened');
  // Shadow root is intentionally closed; exercise its buttons through CDP DOM access.
  const cdp = await context.newCDPSession(signer);
  async function panelClick(text) {
    const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
    let target;
    function walk(node) {
      if (node.nodeName === 'BUTTON' && node.children?.some(c => c.nodeValue === text)) target = node.backendNodeId;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
    }
    walk(root); assert.ok(target, `panel button: ${text}`);
    const {object} = await cdp.send('DOM.resolveNode', {backendNodeId: target});
    await cdp.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: 'function(){this.click()}'});
  }
  await signer.locator('#DataToSignTxtBox').waitFor();
  // Wait for content script's panel without relying on arbitrary sleeps.
  await signer.waitForFunction(() => [...document.body.children].some(e => e.tagName === 'DIV'));
  await panelClick('Подставить данные для подписи');
  assert.equal(await signer.locator('#DataToSignTxtBox').inputValue(), 'challenge-data');
  await signer.locator('#sign').click();
  await panelClick('Передать готовую подпись в КИЗ');
  await page.getByText(/Авторизация действует до/).waitFor();
  const authCalls = await worker.evaluate(() => testCalls.filter(c => /\/auth\//.test(c.url)));
  assert.equal(authCalls.length, 2); assert.equal(authCalls[0].body, undefined);
  assert.deepEqual(JSON.parse(authCalls[1].body), {uuid: 'test-uuid', data: 'A'.repeat(100)});
  // Repeated authorization must not request another key.
  const repeated = await page.evaluate(() => chrome.runtime.sendMessage({type: 'begin'}));
  assert.equal(repeated.value.valid, true);
  assert.equal(await worker.evaluate(() => testCalls.filter(c => c.url.endsWith('/auth/key')).length), 1);
  const code = '010123456789012321AbCdEf';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['КИЗ'], [code + 'tail'], [code]]), 'Коды');
  await page.locator('#file').setInputFiles({name: 'codes.xls', mimeType: 'application/vnd.ms-excel', buffer: XLSX.write(book, {type: 'buffer', bookType: 'xls'})});
  await page.getByText('Уникальных КИЗ: 1. Ошибок: 0.').waitFor();
  await page.locator('#run').click();
  await page.getByText(/Завершено. Получено 1 из 1/).waitFor();
  assert.equal(await page.locator('#results tr').count(), 1);
  assert.match(await page.locator('#results').innerText(), /2027-10-02/);
  const query = await worker.evaluate(() => testCalls.find(c => c.url.endsWith('/cises/info')));
  assert.equal(query.headers.Authorization, 'Bearer test-token'); assert.deepEqual(JSON.parse(query.body), [code]);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloadPromise;
  const exported = XLSX.read(await readFile(await download.path()), {type: 'buffer'});
  assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['КИЗ'])[0].cis, code);
  await worker.evaluate(() => { globalThis.failNext = true; });
  await page.locator('#run').click();
  await page.locator('#error').filter({hasText: /Токен недействителен/}).waitFor();
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('auth'))).auth, undefined);
  assert.deepEqual(failures, []);
  console.log('PASS: MV3 Chromium: signing bridge, XLS import, auth reuse, CIS payload/results, Excel export, 401 invalidation.');
} finally { await context.close(); await rm(profile, {recursive: true, force: true}); }
