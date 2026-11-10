import {eligibleReturns, returnDocument, documentBase64, RETURN_BATCH_SIZE, RETURN_PATH} from './returns.js';
import {TOKEN_TTL, SIGN_PAGE, tokenValid, request, parseResults} from './core.js';
import {configureAccess, record} from './diagnostics.js';
// Register listeners synchronously. Optional compatibility features must never stop startup.
const challengeStorage = chrome.storage.session || chrome.storage.local;
const initialization = configureAccess().catch(() => {});
chrome.action.onClicked.addListener(async () => {
  await record('app.open_requested');
  try { await chrome.tabs.create({url: chrome.runtime.getURL('app.html')}); await record('app.opened'); }
  catch (error) { await record('app.open_failed', {errorKind: error.name}, 'error'); }
});
globalThis.addEventListener?.('error', () => { void record('worker.unhandled_error', {}, 'error'); });
globalThis.addEventListener?.('unhandledrejection', () => { void record('worker.unhandled_rejection', {}, 'error'); });
let authOperation = null;
async function authState() {
  const {auth} = await chrome.storage.local.get('auth');
  const {automaticAuth} = await chrome.storage.local.get('automaticAuth');
  return {valid: tokenValid(auth), expiresAt: tokenValid(auth) ? auth.expiresAt : null, automaticAuth};
}
async function closeAutomatic(challenge) {
  if (challenge?.automatic && Number.isInteger(challenge.windowId)) {
    await chrome.windows.remove(challenge.windowId).catch(() => {});
  }
  await chrome.alarms.clear('automatic-auth');
}
async function failAutomatic(reason) {
  const {challenge} = await challengeStorage.get('challenge');
  if (!challenge?.automatic) return;
  await chrome.storage.local.set({automaticAuth: {state: 'failed', reason}});
  await record('auth.auto_failed', {operation: reason}, 'error');
  await challengeStorage.remove('challenge');
  await closeAutomatic(challenge);
}
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === 'return-signing') void failReturn('Истекло время ожидания подписи.');
  if (alarm.name === 'automatic-auth') void failAutomatic('timeout');
});
async function begin(automatic = false) {
  if ((await authState()).valid) { await record('auth.token_reused'); return authState(); }
  const existing = (await challengeStorage.get('challenge')).challenge;
  if (existing?.automatic) {
    if (automatic && existing.createdAt + 150000 > Date.now()) return {pending: true, automatic: true};
    await closeAutomatic(existing);
    await challengeStorage.remove('challenge');
  } else if (!automatic && existing && existing.createdAt + 5 * 60 * 1000 > Date.now()) {
    try { await chrome.tabs.update(existing.tabId, {active: true}); return {pending: true}; }
    catch { await challengeStorage.remove('challenge'); }
  }
  await chrome.storage.local.set({automaticAuth: {state: automatic ? 'running' : 'idle'}});
  try {
    const challenge = await request('/auth/key');
    if (typeof challenge.uuid !== 'string' || !challenge.uuid || typeof challenge.data !== 'string' || !challenge.data) {
      throw new Error('В ответе auth/key отсутствуют uuid или data.');
    }
    let tab, windowId;
    if (automatic) {
      const window = await chrome.windows.create({url: 'about:blank', type: 'popup', state: 'minimized', focused: false});
      windowId = window.id; tab = window.tabs?.[0];
      if (!Number.isInteger(tab?.id)) {
        await chrome.windows.remove(windowId).catch(() => {});
        throw new Error('Не удалось создать окно автоматической авторизации.');
      }
    } else tab = await chrome.tabs.create({url: 'about:blank'});
    const pending = {...challenge, tabId: tab.id, windowId, automatic, createdAt: Date.now()};
    await challengeStorage.set({challenge: pending});
    if (automatic) await chrome.alarms.create('automatic-auth', {delayInMinutes: 2.5});
    await chrome.tabs.update(tab.id, {url: SIGN_PAGE});
    await record(automatic ? 'auth.auto_started' : 'auth.manual_started');
    return {pending: true, automatic};
  } catch (error) {
    if (automatic) {
      await failAutomatic('startup');
      await chrome.storage.local.set({automaticAuth: {state: 'failed', reason: 'startup'}});
    }
    throw error;
  }
}
async function signIn(signature) {
  if ((await authState()).valid) { await record('auth.token_reused'); return authState(); }
  const {challenge} = await challengeStorage.get('challenge');
  if (!challenge || challenge.createdAt + 5 * 60 * 1000 <= Date.now()) {
    throw new Error('Запрос подписи истёк. Нажмите «Авторизоваться» ещё раз.');
  }
  const data = String(signature ?? '').replace(/\s/g, '');
  if (data.length < 40 || data.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('Вставьте полную подпись в формате Base64.');
  }
  const issuedAt = Date.now();
  const response = await request('/auth/simpleSignIn', {body: {uuid: challenge.uuid, data}});
  if (typeof response.token !== 'string' || !response.token) throw new Error('API не вернул token.');
  await record('auth.succeeded');
  await chrome.storage.local.set({auth: {token: response.token, expiresAt: issuedAt + TOKEN_TTL}});
  await challengeStorage.remove('challenge');
  if (challenge.automatic) {
    await chrome.storage.local.set({automaticAuth: {state: 'success'}});
    await record('auth.auto_succeeded');
    await closeAutomatic(challenge);
  }
  return authState();
}
async function returnState() {
  const {returnJob} = await challengeStorage.get('returnJob');
  const {returnHistory = []} = await chrome.storage.local.get('returnHistory');
  return {state: returnJob?.state || 'idle', error: returnJob?.error || '', rows: returnHistory, data: returnJob?.state === 'signing' ? returnJob.data : ''};
}
async function closeReturn(job) {
  await chrome.alarms?.clear('return-signing');
  if (job?.automatic && Number.isInteger(job.windowId)) await chrome.windows.remove(job.windowId).catch(() => {});
}
async function failReturn(error) {
  const {returnJob} = await challengeStorage.get('returnJob');
  if (!returnJob || !['signing', 'submitting'].includes(returnJob.state)) return;
  await challengeStorage.set({returnJob: {...returnJob, state: 'failed', error, token: null}});
  await closeReturn(returnJob);
}
async function openReturnBatch(job) {
  const batch = job.remaining.slice(0, RETURN_BATCH_SIZE);
  if (!batch.length) {
    await challengeStorage.set({returnJob: {...job, state: 'complete', data: '', token: null, batch: [], remaining: []}}); return;
  }
  const data = returnDocument(batch);
  let tab, windowId;
  if (job.automatic) {
    const window = await chrome.windows.create({url: 'about:blank', type: 'popup', state: 'minimized', focused: false});
    windowId = window.id; tab = window.tabs?.[0];
  } else tab = await chrome.tabs.create({url: 'about:blank'});
  const pending = {...job, batch, data, tabId: tab?.id, windowId, state: 'signing'};
  await challengeStorage.set({returnJob: pending});
  if (!Number.isInteger(tab?.id)) throw new Error('Не удалось открыть КриптоПро.');
  await chrome.alarms?.create('return-signing', {delayInMinutes: 5});
  await chrome.tabs.update(tab.id, {url: SIGN_PAGE});
}
let returnStarting = false;
async function beginReturn(message) {
  if (returnStarting) throw new Error('Возврат уже запускается.');
  returnStarting = true;
  try { return await beginReturnOnce(message); } finally { returnStarting = false; }
}
async function beginReturnOnce(message) {
  const current = (await challengeStorage.get('returnJob')).returnJob;
  if (current && ['signing', 'submitting'].includes(current.state)) throw new Error('Возврат уже выполняется.');
  const {returnDocuments = {}} = await chrome.storage.local.get('returnDocuments');
  if (!Array.isArray(message.rows)) throw new Error('Не переданы результаты КИЗ.');
  const rows = eligibleReturns(message.rows, returnDocuments);
  if (!rows.length) throw new Error('Товаров на возврат нету');
  const {lastQueryAuth} = await challengeStorage.get('lastQueryAuth');
  if (!tokenValid(lastQueryAuth)) throw new Error('Получите данные КИЗ с действующим токеном перед возвратом.');
  try { await openReturnBatch({remaining: rows, token: lastQueryAuth.token, automatic: message.automatic === true, detached: message.detached === true}); }
  catch (e) { await failReturn(e.message); throw e; }
  return returnState();
}
let returnSubmission = null;
async function submitReturn(signature) {
  if (returnSubmission) throw new Error('Документ уже отправляется.');
  returnSubmission = submitReturnOnce(signature).finally(() => {returnSubmission = null;});
  return returnSubmission;
}
async function submitReturnOnce(signature) {
  const {returnJob: job} = await challengeStorage.get('returnJob');
  if (job?.state !== 'signing') throw new Error('Нет документа для подписи.');
  const signed = String(signature ?? '').replace(/\s/g, '');
  if (signed.length < 40 || signed.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed)) throw new Error('Вставьте полную подпись в формате Base64.');
  await challengeStorage.set({returnJob: {...job, state: 'submitting'}});
  try {
    const raw = await request(RETURN_PATH, {token: job.token, responseType: 'text', body: {
      document_format: 'MANUAL', product_document: documentBase64(job.data), type: 'LP_RETURN', signature: signed
    }});
    const document = raw.trim().replace(/^"|"$/g, '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(document)) throw new Error('API не вернул номер документа. Проверьте документ в личном кабинете перед повторной отправкой.');
    const {returnDocuments = {}} = await chrome.storage.local.get('returnDocuments');
    const {returnHistory = []} = await chrome.storage.local.get('returnHistory');
    for (const row of job.batch) returnDocuments[row.cis] = document;
    await chrome.storage.local.set({returnDocuments, returnHistory: [...returnHistory, ...job.batch.map(row => ({...row, returnDocument: document}))]});
    await closeReturn(job);
    await openReturnBatch({...job, remaining: job.remaining.slice(job.batch.length)});
    return returnState();
  } catch (error) {
    await failReturn(error.message + ' Отправка остановлена. При неизвестном результате проверьте документы в личном кабинете перед повтором.');
    throw error;
  }
}
async function handle(message, sender) {
  const isApp = sender.url === chrome.runtime.getURL('app.html');
  const isSigner = sender.url?.split('?')[0].split('#')[0] === SIGN_PAGE;
  if (!isApp && !isSigner) throw new Error('Недопустимый источник сообщения.');
  if (isSigner) {
    const {returnJob} = await challengeStorage.get('returnJob');
    if (returnJob?.state === 'signing' && sender.tab?.id === returnJob.tabId) {
      if (message.type === 'challenge') return {data: returnJob.data, automatic: returnJob.automatic, detached: returnJob.detached, purpose: 'return'};
      if (message.type === 'signature') return submitReturn(message.signature);
      if (message.type === 'autoFailure') { await failReturn('Не удалось подписать документ. Проверьте КриптоПро.'); return {}; }
      if (message.type === 'diagnostic') return {};
      throw new Error('Недопустимая команда.');
    }
    const {challenge} = await challengeStorage.get('challenge');
    if (!challenge || sender.tab?.id !== challenge.tabId) throw new Error('Нет активного запроса подписи для этой вкладки.');
    if (message.type === 'diagnostic' && ['signer.loaded', 'signer.field_missing', 'signer.data_filled', 'signer.signature_missing', 'signer.auto_selected', 'signer.auto_signing'].includes(message.event)) { await record(message.event); return {}; }
    if (message.type === 'autoFailure' && challenge.automatic) {
      const reason = ['certificate', 'fields', 'signature', 'signing'].includes(message.reason) ? message.reason : 'signing';
      await failAutomatic(reason); return {};
    }
    if (message.type === 'challenge') return {data: challenge.data, automatic: !!challenge.automatic};
    if (message.type === 'signature') return exclusive(() => signIn(message.signature));
    throw new Error('Недопустимая команда.');
  }
  switch (message.type) {
    case 'diagnostic': {
      const allowed = ['catalog.loaded', 'catalog.failed', 'archive.saved', 'archive.failed', 'archive.configured', 'data.cleared', 'scan.saved', 'scan.rejected', 'scan.duplicate', 'scan.cleared', 'ui.started', 'ui.error', 'file.imported', 'file.import_failed', 'file.library_missing', 'query.started', 'query.stopped', 'export.xlsx', 'export.json', 'ui.unhandled_error'];
      if (allowed.includes(message.event)) await record(message.event, message.details);
      return {};
    }
    case 'returnStatus': return returnState();
    case 'beginReturn': return beginReturn(message);
    case 'returnSignature': return submitReturn(message.signature);
    case 'cancelReturn': {
      if ((await challengeStorage.get('returnJob')).returnJob?.state === 'submitting') throw new Error('Дождитесь ответа API на текущий документ.');
      await failReturn('Возврат остановлен пользователем.');
      return returnState();
    }
    case 'clearLogs': await chrome.storage.local.set({diagnosticLog: []}); return {};
    case 'status': return authState();
    case 'begin': return exclusive(() => begin(message.automatic === true));
    case 'signature': return exclusive(() => signIn(message.signature));
    case 'query': {
      const codes = message.codes;
      if (!Array.isArray(codes) || !codes.length || codes.length > 100 || codes.some(c => typeof c !== 'string' || c.length !== 24)) {
        throw new Error('Ожидается от 1 до 100 КИЗ длиной 24 символа.');
      }
      const {auth} = await chrome.storage.local.get('auth');
      if (!tokenValid(auth)) throw new Error('Необходима авторизация.');
      try {
        const rows = parseResults(await request('/cises/info', {body: codes, token: auth.token}), codes);
        await challengeStorage.set({lastQueryAuth: auth});
        return rows;
      }
      catch (error) {
        if (error.status === 401) {
          await record('auth.token_rejected', {status: 401}, 'warn');
          const current = (await chrome.storage.local.get('auth')).auth;
          if (current?.token === auth.token) await chrome.storage.local.remove('auth');
        }
        throw error;
      }
    }
    default: throw new Error('Неизвестная команда.');
  }
}
function exclusive(fn) {
  if (!authOperation) authOperation = fn().finally(() => { authOperation = null; });
  return authOperation;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const started = Date.now();
  const operation = ['status', 'begin', 'signature', 'query', 'challenge', 'diagnostic', 'clearLogs', 'autoFailure', 'returnStatus', 'beginReturn', 'returnSignature', 'cancelReturn'].includes(message?.type) ? message.type : 'unknown';
  initialization.then(() => handle(message, sender)).then(async value => {
    if (!['status', 'returnStatus', 'diagnostic', 'clearLogs'].includes(operation)) await record('operation.completed', {operation, durationMs: Date.now() - started, count: Array.isArray(value) ? value.length : 0});
    reply({ok: true, value});
  }, async error => {
    await record('operation.failed', {operation, durationMs: Date.now() - started, status: error.status, errorKind: error.name}, 'error');
    reply({ok: false, error: error.message || 'Ошибка операции.'});
  });
  return true;
});
