import {extractCodes, excelExpirationDate, correctKeyboardLayout, attachFullCodes, formatExpirationDate} from './core.js';
import {parseCatalog, articleFor} from './catalog.js';
import {Archive} from './archive.js';
const archive = new Archive();
let archiveReady = archive.restore().catch(() => false);
const manualComments = new Map();
let recentComments = [];
const $ = id => document.getElementById(id);
let workbook, rows = [], codes = [], results = [], busy = false, stopping = false, importing = false;
let fileCodes = [];
let catalog = new Map(), catalogLoadedAt = null;
let catalogLoading = true;
const manualCodes = new Set();
const barcodeRows = [];
let barcodeArchiveQueue = Promise.resolve();
const send = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Нет ответа от расширения.');
  return reply.value;
};
function diagnostic(event, details = {}) { send({type: 'diagnostic', event, details}).catch(() => {}); }
window.addEventListener('error', () => diagnostic('ui.unhandled_error'));
window.addEventListener('unhandledrejection', () => diagnostic('ui.unhandled_error'));
function error(e) { diagnostic('ui.error', {errorKind: e?.name || 'Error'}); $('error').textContent = e?.message || String(e); }
function excelAvailable() { return typeof globalThis.XLSX?.read === 'function'; }
function controls() {
  $('run').disabled = busy || importing || catalogLoading || !codes.length;
  for (const id of ['file', 'header']) $(id).disabled = busy || importing || catalogLoading || !excelAvailable();
  for (const id of ['sheet', 'column']) $(id).disabled = busy || importing || catalogLoading || !workbook;
  for (const id of ['export', 'json']) $(id).disabled = !results.length || catalogLoading;
  $('loadCatalog').disabled = busy || importing || catalogLoading || !excelAvailable();
  $('scan').disabled = busy || importing || catalogLoading;
  $('scanBarcode').disabled = busy || importing || catalogLoading;
  $('clearData').disabled = busy || importing || catalogLoading;
  $('chooseArchive').disabled = busy || importing || catalogLoading;
  $('export').disabled = !results.length || catalogLoading || !excelAvailable();
  $('stop').disabled = !busy || stopping;
}
async function status() {
  const auth = await send({type: 'status'});
  $('authStatus').textContent = auth.valid ? `Авторизация действует до ${new Date(auth.expiresAt).toLocaleString('ru-RU')}.` : 'Требуется авторизация с электронной подписью.';
  $('login').disabled = auth.valid || busy;
  $('autoLogin').disabled = auth.valid || busy || auth.automaticAuth?.state === 'running';
  const reasons = {certificate: 'Не найден сертификат «Труфанова Лариса» с зелёной галочкой.', fields: 'Не найдены элементы страницы КриптоПро.', signature: 'Не получена подпись за отведённое время.', signing: 'Ошибка подписи или входа.', timeout: 'Истекло время ожидания. Проверьте КриптоПро и повторите вход.', startup: 'Не удалось запустить автоматическую авторизацию.'};
  $('autoAuthStatus').textContent = auth.valid ? '' : auth.automaticAuth?.state === 'running' ? 'Автоматическая авторизация выполняется…' : auth.automaticAuth?.state === 'failed' ? (reasons[auth.automaticAuth.reason] || 'Автоматическая авторизация не выполнена.') + ' Можно повторить или использовать обычный вход.' : '';
  $('signIn').disabled = auth.valid || busy;
}
$('login').onclick = async () => {
  $('error').textContent = ''; $('login').disabled = true;
  try {
    const auth = await send({type: 'begin'});
    if (auth.pending) $('authStatus').textContent = 'Подпишите данные в открывшейся вкладке КриптоПро и передайте подпись.';
    else await status();
  } catch (e) { error(e); } finally { $('login').disabled = false; }
};
$('signIn').onclick = async () => {
  $('error').textContent = ''; $('signIn').disabled = true;
  try { await send({type: 'signature', signature: $('signature').value}); $('signature').value = ''; await status(); }
  catch (e) { error(e); $('signIn').disabled = false; }
};
$('autoLogin').onclick = async () => {
  $('autoLogin').disabled = true; $('error').textContent = '';
  try { await send({type: 'begin', automatic: true}); } catch (e) { error(e); }
  finally { await status().catch(error); }
};
setInterval(() => { if ($('autoAuthStatus').textContent === 'Автоматическая авторизация выполняется…') status().catch(error); }, 2000);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.auth || changes.automaticAuth)) status().catch(error); });
window.addEventListener('focus', () => status().catch(error));
function selectSheet() {
  if (!workbook || !excelAvailable()) return;
  if ($('sheet').selectedIndex < 0) $('sheet').selectedIndex = 0;
  const sheet = workbook.Sheets[$('sheet').value];
  if (!sheet) throw new Error('Лист не выбран или не найден в книге.');
  rows = XLSX.utils.sheet_to_json(sheet, {header: 1, raw: true, defval: '', blankrows: true});
  const width = Math.max(0, ...rows.map(r => r.length));
  $('column').replaceChildren();
  for (let i = 0; i < width; i++) {
    const option = document.createElement('option'); option.value = i;
    option.textContent = `${XLSX.utils.encode_col(i)} — ${String(rows[0]?.[i] ?? '').slice(0, 60)}`;
    $('column').append(option);
  }
  $('column').selectedIndex = width ? 0 : -1;
  $('header').checked = !/^\s*01\d{14}21/.test(String(rows[0]?.[0] ?? ''));
  importCodes();
}
function importCodes() {
  if (!workbook || !excelAvailable()) return;
  const parsed = extractCodes(rows, Number($('column').value), $('header').checked);
  diagnostic('file.imported', {count: parsed.codes.length, rowCount: rows.length, columnCount: $('column').options.length, sheetCount: workbook.SheetNames.length, errorCount: parsed.errors.length, columnIndex: $('column').selectedIndex, hasHeader: $('header').checked});
  fileCodes = parsed.fullCodes; rebuildCodes();
  $('fileStatus').textContent = `Уникальных КИЗ: ${codes.length}. Ошибок: ${parsed.errors.length}.`;
  $('importErrors').textContent = parsed.errors.slice(0, 100).join('\n') + (parsed.errors.length > 100 ? '\nПоказаны первые 100 ошибок.' : '');
  $('progress').textContent = codes.length ? 'Готово к запросу.' : 'Нет КИЗ для запроса. Выберите лист и столбец с кодами, проверьте флажок заголовка и ошибки импорта.'; controls();
}
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  $('error').textContent = ''; workbook = undefined; rows = []; fileCodes = []; rebuildCodes();
  importing = true; controls();
  try {
    if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error('Выберите файл .xls или .xlsx.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер файла — 20 МБ.');
    if (!excelAvailable()) throw new Error('Библиотека Excel не загружена. Обновите расширение полной папкой из архива, включая vendor.');
    const next = XLSX.read(await file.arrayBuffer(), {type: 'array', cellDates: false});
    if (!next.SheetNames.length) throw new Error('В книге нет листов.');
    workbook = next; $('sheet').replaceChildren();
    for (const name of workbook.SheetNames) { const option = document.createElement('option'); option.value = name; option.textContent = name; $('sheet').append(option); }
    $('sheet').selectedIndex = 0;
    selectSheet();
  } catch (e) { workbook = undefined; rows = []; fileCodes = []; rebuildCodes(); $('sheet').replaceChildren(); $('column').replaceChildren(); $('importErrors').textContent = ''; $('fileStatus').textContent = 'Файл не загружен.'; $('progress').textContent = 'Импорт не выполнен. Исправьте ошибку и загрузите файл повторно.'; diagnostic('file.import_failed', {errorKind: e.name}); error(e); }
  finally { importing = false; controls(); }
};
$('sheet').onchange = () => { try { selectSheet(); } catch (e) { error(e); } };
$('column').onchange = importCodes; $('header').onchange = importCodes;
function render() {
  $('results').replaceChildren();
  // Keep the view responsive; export always contains all rows.
  for (const row of results.slice(0, 1000)) {
    const tr = document.createElement('tr');
    for (const key of ['cis', 'cis_full', 'gtin', 'expirationDate', 'comment', 'article', 'status', 'error']) { const td = document.createElement('td'); td.textContent = row[key] ?? ''; tr.append(td); }
    $('results').append(tr);
  }
  controls();
}
$('run').onclick = async () => {
  diagnostic('query.started', {count: codes.length});
  busy = true; stopping = false; results = barcodeResults(); $('error').textContent = ''; controls();
  let processed = 0, receivedAt = results.length ? new Date() : null;
  try {
    if (codes.length && !(await send({type: 'status'})).valid) throw new Error('Сначала авторизуйтесь через КриптоПро.');
    for (let i = 0; i < codes.length && !stopping; i += 100) {
      $('progress').textContent = `Запрос: ${i + 1}–${Math.min(i + 100, codes.length)} из ${codes.length}…`;
      const batch = await send({type: 'query', codes: codes.slice(i, i + 100)});
      results.push(...attachFullCodes(batch, [...fileCodes, ...manualCodes]).map(row => ({...row, comment: manualComments.get(row.cis_full) || '', article: articleFor(row.gtin, catalog)}))); receivedAt = new Date(); processed += batch.length; render();
    }
    $('progress').textContent = `${stopping ? 'Остановлено' : 'Завершено'}. Получено ${processed} из ${codes.length}. Ошибок по КИЗ: ${results.filter(r => r.error).length}. В таблице показаны первые 1000 строк; экспорт содержит все результаты.`;
  } catch (e) { error(e); $('progress').textContent = `Обработка прервана. Сохранено ${results.length} из ${codes.length}; доступен экспорт частичных результатов.`; }
  finally {
    if (results.length && receivedAt) {
      try {
        await archiveReady;
        const name = await archive.write(XLSX.write(resultWorkbook(), {type: 'array', bookType: 'xlsx'}), receivedAt);
        $('archiveStatus').textContent = `Автоматически сохранено: ${name}. Строк: ${results.length}.`;
        diagnostic('archive.saved', {count: results.length});
      } catch (e) {
        $('archiveStatus').textContent = `Автоархив не сохранён: ${e.message} Результаты доступны по кнопке «Скачать Excel».`;
        diagnostic('archive.failed', {errorKind: e.name});
      }
    }
    busy = false; controls(); await status().catch(error);
  }
};
$('stop').onclick = () => { stopping = true; diagnostic('query.stopped'); controls(); };
function resultWorkbook() {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(results, {header: ['cis', 'cis_full', 'gtin', 'expirationDate', 'comment', 'article', 'status', 'error']});
  results.forEach((row, i) => {
    const serial = excelExpirationDate(row.expirationDate);
    if (serial !== null) sheet[XLSX.utils.encode_cell({r: i + 1, c: 3})] = {t: 'n', v: serial, z: 'dd"."mm"."yyyy'};
  });
  sheet.D1 = {t: 's', v: 'Срок годности'};
  sheet.F1 = {t: 's', v: 'Артикул'};
  sheet.E1 = {t: 's', v: 'Комментарий'};
  sheet.G1 = {t: 's', v: 'Статус'};
  XLSX.utils.book_append_sheet(book, sheet, 'КИЗ'); return book;
}
$('export').onclick = () => {
  diagnostic('export.xlsx', {count: results.length});
  XLSX.writeFile(resultWorkbook(), 'kiz-results.xlsx');
};
$('json').onclick = () => {
  diagnostic('export.json', {count: results.length});
  const url = URL.createObjectURL(new Blob([JSON.stringify(results.map(({expirationDate, article, status = '', ...row}) => ({...row, 'Срок годности': expirationDate, 'Артикул': article, 'Статус': status})), null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'kiz-results.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
status().catch(error);

$('downloadLog').onclick = async () => {
  try {
    const {diagnosticLog = []} = await chrome.storage.local.get('diagnosticLog');
    const manifest = chrome.runtime.getManifest();
    const report = {exportedAt: new Date().toISOString(), version: manifest.version, browser: navigator.userAgent,
      capabilities: {localAccessControl: typeof chrome.storage.local.setAccessLevel === 'function', sessionStorage: !!chrome.storage.session}, events: diagnosticLog};
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = `kiz-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('logStatus').textContent = `Выгружено событий: ${diagnosticLog.length}.`;
  } catch (e) { error(e); }
};
$('clearLog').onclick = async () => {
  try { await send({type: 'clearLogs'}); $('logStatus').textContent = 'Журнал очищен.'; } catch (e) { error(e); }
};
diagnostic('ui.started');

if (!excelAvailable()) {
  diagnostic('file.library_missing');
  $('fileStatus').textContent = 'Чтение Excel недоступно: библиотека не загружена.';
  error(new Error('Библиотека Excel не загружена. Замените папку расширения целиком, включая vendor, и нажмите «Обновить» в chrome://extensions.'));
}
controls();

function rebuildCodes() {
  codes = [...new Set([...fileCodes, ...manualCodes].map(full => full.slice(0, 24)))];
  results = barcodeResults(); render();
  $('manualStatus').textContent = `Вручную добавлено: ${manualCodes.size}. Всего уникальных КИЗ: ${codes.length}.`;
  $('progress').textContent = codes.length ? 'Готово к запросу.' : 'Нет КИЗ для запроса.';
}
$('scan').onclick = () => {
  $('scanStatus').textContent = ''; $('scanInput').value = '';
  $('scanDialog').showModal(); $('scanInput').focus();
};
$('closeScan').onclick = () => $('scanDialog').close();
$('scanForm').onsubmit = event => {
  event.preventDefault();
  if (busy || importing) return;
  const input = $('scanInput');
  const value = correctKeyboardLayout(input.value.trim());
  if (value.length < 24) {
    $('scanStatus').textContent = 'Отсканирован не КИЗ: введено менее 24 символов. Код не сохранён.';
    diagnostic('scan.rejected'); input.select(); input.focus(); return;
  }
  const comment = $('scanComment').value.trim();
  const isDuplicate = fileCodes.includes(value) || manualCodes.has(value);
  const previousComment = manualComments.get(value) || '';
  if (!isDuplicate || previousComment !== comment) {
    manualComments.set(value, comment);
    if (comment) {
      recentComments = [comment, ...recentComments.filter(item => item !== comment)].slice(0, 5);
      updateCommentHistory();
      chrome.storage.local.set({recentScanComments: recentComments}).catch(error);
    }
  }
  const cis = value.slice(0, 24);
  if (isDuplicate) {
    if (previousComment !== comment) rebuildCodes();
    $('scanStatus').textContent = previousComment !== comment ? 'Комментарий к КИЗ обновлён.' : 'Этот КИЗ уже добавлен. Дубликат не сохранён.';
    diagnostic('scan.duplicate');
  } else {
    manualCodes.add(value); rebuildCodes();
    $('scanStatus').textContent = `КИЗ сохранён. Вручную добавлено: ${manualCodes.size}. Можно сканировать следующий.`;
    diagnostic('scan.saved', {count: manualCodes.size});
  }
  input.value = ''; input.focus();
};
$('clearScans').onclick = () => {
  if (busy || importing) return;
  manualCodes.clear(); manualComments.clear(); rebuildCodes();
  $('scanStatus').textContent = 'Ручной ввод очищен. КИЗ из файла сохранены.';
  diagnostic('scan.cleared'); $('scanInput').focus();
};

function updateCommentHistory() {
  $('commentHistory').replaceChildren();
  for (const text of recentComments) { const option = document.createElement('option'); option.value = text; $('commentHistory').append(option); }
}
chrome.storage.local.get('recentScanComments').then(({recentScanComments}) => {
  recentComments = Array.isArray(recentScanComments) ? [...new Set(recentScanComments.filter(value => typeof value === 'string' && value.trim()))].slice(0, 5) : [];
  updateCommentHistory();
}).catch(error);
archiveReady.then(ready => {
  $('archiveStatus').textContent = ready ? 'Папка архива подключена. Результаты будут сохраняться автоматически.' : 'Выберите папку C:\\ExtensionKIZ\\Архив и разрешите запись для автоматического сохранения.';
});
$('chooseArchive').onclick = async () => {
  try {
    const retained = await archive.choose();
    // A restored handle must not replace a folder just selected by the user.
    archiveReady = Promise.resolve(true);
    $('archiveStatus').textContent = retained ? 'Папка архива выбрана. Автоматическое сохранение включено.' : 'Автосохранение включено для текущей вкладки. После перезапуска выберите папку повторно.';
    diagnostic('archive.configured');
  } catch (e) { if (e.name !== 'AbortError') { $('archiveStatus').textContent = e.message; diagnostic('archive.failed', {errorKind: e.name}); } }
};
$('clearData').onclick = () => {
  if (busy || importing || !confirm('Вы уверены что хотите очистить список отсканированных и загруженных КИЗ')) return;
  barcodeRows.length = 0;
  $('barcodeInput').value = ''; $('barcodeComment').value = ''; $('barcodeDate').value = ''; $('barcodeStatus').textContent = '';
  manualCodes.clear(); manualComments.clear(); fileCodes = []; rows = []; workbook = undefined;
  $('file').value = ''; $('sheet').replaceChildren(); $('column').replaceChildren();
  $('importErrors').textContent = ''; $('fileStatus').textContent = 'Файл не выбран.';
  $('scanInput').value = ''; $('scanComment').value = ''; $('scanStatus').textContent = '';
  rebuildCodes(); diagnostic('data.cleared');
};

function catalogStatus() {
  $('catalogStatus').textContent = catalogLoadedAt
    ? `Записей: ${catalog.size}. Дата загрузки: ${new Date(catalogLoadedAt).toLocaleString('ru-RU')}.`
    : 'Справочник не загружен.';
}
chrome.storage.local.get('articleCatalog').then(({articleCatalog}) => {
  if (articleCatalog && Array.isArray(articleCatalog.entries)) {
    catalog = new Map(articleCatalog.entries); catalogLoadedAt = articleCatalog.loadedAt;
  }
  catalogStatus();
}).catch(e => { $('catalogErrors').textContent = 'Не удалось восстановить справочник. Загрузите файл повторно.'; diagnostic('catalog.failed', {errorKind: e.name}); })
  .finally(() => { catalogLoading = false; controls(); });
$('loadCatalog').onclick = () => $('catalogFile').click();
$('catalogFile').onchange = async () => {
  const file = $('catalogFile').files[0];
  if (!file || busy || importing || catalogLoading) return;
  catalogLoading = true; controls(); $('catalogErrors').textContent = '';
  try {
    if (!/\.(xlsx|xls)$/i.test(file.name) || file.size > 20 * 1024 * 1024) throw new Error('Выберите .xls/.xlsx размером до 20 МБ.');
    const book = XLSX.read(await file.arrayBuffer(), {type: 'array'});
    if (!book.SheetNames.length) throw new Error('В книге нет листов.');
    const entries = parseCatalog(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {header: 1, raw: true, defval: '', blankrows: true, range: 0}));
    const loadedAt = new Date().toISOString();
    // Commit only after validation and successful persistence. Invalid uploads preserve the previous catalog.
    await chrome.storage.local.set({articleCatalog: {entries, loadedAt}});
    catalog = new Map(entries); catalogLoadedAt = loadedAt; catalogStatus();
    results = results.map(row => ({...row, article: articleFor(row.gtin, catalog)})); render();
    diagnostic('catalog.loaded', {count: catalog.size});
    if (results.length) {
      try {
        await archiveReady;
        const name = await archive.write(XLSX.write(resultWorkbook(), {type: 'array', bookType: 'xlsx'}), new Date());
        $('archiveStatus').textContent = `Результаты с обновлёнными артикулами сохранены: ${name}.`;
      } catch (e) { $('archiveStatus').textContent = `Артикулы пересчитаны. Автоархив не сохранён: ${e.message} Используйте «Скачать Excel».`; }
    }
  } catch (e) {
    $('catalogErrors').textContent = `Справочник не обновлён. Предыдущие данные сохранены.\n${e.message}`;
    diagnostic('catalog.failed', {errorKind: e.name});
  } finally { catalogLoading = false; $('catalogFile').value = ''; controls(); }
};

// Barcode scans are independent entries, including repeated GTINs.
function barcodeResults() {
  return barcodeRows.map(row => ({...row, article: articleFor(row.gtin, catalog)}));
}
function refreshBarcodeResults() {
  results = [...results.filter(row => row.cis), ...barcodeResults()];
  render();
}
function archiveBarcodeResults() {
  if (!results.length) return;
  const receivedAt = new Date(), count = results.length;
  let bytes;
  try { bytes = XLSX.write(resultWorkbook(), {type: 'array', bookType: 'xlsx'}); }
  catch (e) { $('archiveStatus').textContent = `Автоархив не сохранён: ${e.message} Используйте ручную выгрузку.`; return; }
  // Snapshot each saved scan and serialize writes to avoid filename collisions.
  barcodeArchiveQueue = barcodeArchiveQueue.then(async () => {
    try {
      await archiveReady;
      const name = await archive.write(bytes, receivedAt);
      $('archiveStatus').textContent = `Автоматически сохранено: ${name}. Строк: ${count}.`;
      diagnostic('archive.saved', {count});
    } catch (e) {
      $('archiveStatus').textContent = `Автоархив не сохранён: ${e.message} Результаты доступны по кнопке «Скачать Excel».`;
      diagnostic('archive.failed', {errorKind: e.name});
    }
  });
}
$('scanBarcode').onclick = () => {
  $('barcodeStatus').textContent = ''; $('barcodeInput').value = '';
  $('barcodeDialog').showModal(); $('barcodeInput').focus();
};
$('closeBarcode').onclick = () => $('barcodeDialog').close();
$('barcodeForm').onsubmit = event => {
  event.preventDefault();
  if (busy || importing || catalogLoading) return;
  const input = $('barcodeInput');
  if (!/^[0-9]{13}$/.test(input.value)) {
    $('barcodeStatus').textContent = 'Отсканирован не ШК';
    input.select(); input.focus(); return;
  }
  const date = $('barcodeDate');
  if (date.validity.badInput || (date.value && !/^\d{4}-\d{2}-\d{2}$/.test(date.value))) {
    $('barcodeStatus').textContent = 'Введите корректный срок годности.'; date.focus(); return;
  }
  const comment = $('barcodeComment').value.trim();
  barcodeRows.push({cis: '', cis_full: '', gtin: '0' + input.value,
    expirationDate: formatExpirationDate(date.value), comment, status: '', error: ''});
  if (comment) {
    recentComments = [comment, ...recentComments.filter(item => item !== comment)].slice(0, 5);
    updateCommentHistory();
    chrome.storage.local.set({recentScanComments: recentComments}).catch(error);
  }
  refreshBarcodeResults(); archiveBarcodeResults();
  $('barcodeStatus').textContent = `ШК сохранён. Добавлено товаров без КИЗ: ${barcodeRows.length}. Можно сканировать следующий.`;
  input.value = ''; input.focus();
};
$('clearBarcodes').onclick = () => {
  if (busy || importing || catalogLoading) return;
  barcodeRows.length = 0; refreshBarcodeResults(); archiveBarcodeResults();
  $('barcodeInput').value = '';
  $('barcodeStatus').textContent = 'Ручной ввод ШК очищен. КИЗ сохранены.';
  $('barcodeInput').focus();
};
