import {extractCodes} from './core.js';
const $ = id => document.getElementById(id);
let workbook, rows = [], codes = [], results = [], busy = false, stopping = false, importing = false;
const send = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Нет ответа от расширения.');
  return reply.value;
};
function error(e) { $('error').textContent = e?.message || String(e); }
function controls() {
  $('run').disabled = busy || importing || !codes.length;
  for (const id of ['file', 'header']) $(id).disabled = busy || importing;
  for (const id of ['sheet', 'column']) $(id).disabled = busy || importing || !workbook;
  for (const id of ['export', 'json']) $(id).disabled = !results.length;
  $('stop').disabled = !busy || stopping;
}
async function status() {
  const auth = await send({type: 'status'});
  $('authStatus').textContent = auth.valid ? `Авторизация действует до ${new Date(auth.expiresAt).toLocaleString('ru-RU')}.` : 'Требуется авторизация с электронной подписью.';
  $('login').disabled = auth.valid || busy;
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
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.auth) status().catch(error); });
window.addEventListener('focus', () => status().catch(error));
function selectSheet() {
  const sheet = workbook.Sheets[$('sheet').value];
  rows = XLSX.utils.sheet_to_json(sheet, {header: 1, raw: true, defval: '', blankrows: true});
  const width = Math.max(0, ...rows.slice(0, 100).map(r => r.length));
  $('column').replaceChildren();
  for (let i = 0; i < width; i++) {
    const option = document.createElement('option'); option.value = i;
    option.textContent = `${XLSX.utils.encode_col(i)} — ${String(rows[0]?.[i] ?? '').slice(0, 60)}`;
    $('column').append(option);
  }
  importCodes();
}
function importCodes() {
  const parsed = extractCodes(rows, Number($('column').value), $('header').checked);
  codes = parsed.codes; results = []; render();
  $('fileStatus').textContent = `Уникальных КИЗ: ${codes.length}. Ошибок: ${parsed.errors.length}.`;
  $('importErrors').textContent = parsed.errors.slice(0, 100).join('\n') + (parsed.errors.length > 100 ? '\nПоказаны первые 100 ошибок.' : '');
  $('progress').textContent = 'Готово к запросу.'; controls();
}
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  $('error').textContent = ''; workbook = undefined; rows = []; codes = []; results = []; render();
  importing = true; controls();
  try {
    if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error('Выберите файл .xls или .xlsx.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер файла — 20 МБ.');
    const next = XLSX.read(await file.arrayBuffer(), {type: 'array', cellDates: false});
    if (!next.SheetNames.length) throw new Error('В книге нет листов.');
    workbook = next; $('sheet').replaceChildren();
    for (const name of workbook.SheetNames) { const option = document.createElement('option'); option.value = name; option.textContent = name; $('sheet').append(option); }
    selectSheet();
  } catch (e) { workbook = undefined; $('fileStatus').textContent = 'Файл не загружен.'; error(e); }
  finally { importing = false; controls(); }
};
$('sheet').onchange = () => { try { selectSheet(); } catch (e) { error(e); } };
$('column').onchange = importCodes; $('header').onchange = importCodes;
function render() {
  $('results').replaceChildren();
  // Keep the view responsive; export always contains all rows.
  for (const row of results.slice(0, 1000)) {
    const tr = document.createElement('tr');
    for (const key of ['cis', 'gtin', 'expirationDate', 'error']) { const td = document.createElement('td'); td.textContent = row[key] ?? ''; tr.append(td); }
    $('results').append(tr);
  }
  controls();
}
$('run').onclick = async () => {
  busy = true; stopping = false; results = []; $('error').textContent = ''; controls();
  try {
    if (!(await send({type: 'status'})).valid) throw new Error('Сначала авторизуйтесь через КриптоПро.');
    for (let i = 0; i < codes.length && !stopping; i += 100) {
      $('progress').textContent = `Запрос: ${i + 1}–${Math.min(i + 100, codes.length)} из ${codes.length}…`;
      const batch = await send({type: 'query', codes: codes.slice(i, i + 100)});
      results.push(...batch); render();
    }
    $('progress').textContent = `${stopping ? 'Остановлено' : 'Завершено'}. Получено ${results.length} из ${codes.length}. Ошибок по КИЗ: ${results.filter(r => r.error).length}. В таблице показаны первые 1000 строк; экспорт содержит все результаты.`;
  } catch (e) { error(e); $('progress').textContent = `Обработка прервана. Сохранено ${results.length} из ${codes.length}; доступен экспорт частичных результатов.`; }
  finally { busy = false; controls(); await status().catch(error); }
};
$('stop').onclick = () => { stopping = true; controls(); };
$('export').onclick = () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(results, {header: ['cis', 'gtin', 'expirationDate', 'error']});
  XLSX.utils.book_append_sheet(book, sheet, 'КИЗ'); XLSX.writeFile(book, 'kiz-results.xlsx');
};
$('json').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(results, null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'kiz-results.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
status().catch(error);
