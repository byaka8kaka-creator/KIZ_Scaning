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
async function handle(message, sender) {
  const isApp = sender.url === chrome.runtime.getURL('app.html');
  const isSigner = sender.url?.split('?')[0].split('#')[0] === SIGN_PAGE;
  if (!isApp && !isSigner) throw new Error('Недопустимый источник сообщения.');
  if (isSigner) {
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
      const allowed = ['scan.saved', 'scan.rejected', 'scan.duplicate', 'scan.cleared', 'ui.started', 'ui.error', 'file.imported', 'file.import_failed', 'file.library_missing', 'query.started', 'query.stopped', 'export.xlsx', 'export.json', 'ui.unhandled_error'];
      if (allowed.includes(message.event)) await record(message.event, message.details);
      return {};
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
      try { return parseResults(await request('/cises/info', {body: codes, token: auth.token}), codes); }
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
  const operation = ['status', 'begin', 'signature', 'query', 'challenge', 'diagnostic', 'clearLogs', 'autoFailure'].includes(message?.type) ? message.type : 'unknown';
  initialization.then(() => handle(message, sender)).then(async value => {
    if (!['status', 'diagnostic', 'clearLogs'].includes(operation)) await record('operation.completed', {operation, durationMs: Date.now() - started, count: Array.isArray(value) ? value.length : 0});
    reply({ok: true, value});
  }, async error => {
    await record('operation.failed', {operation, durationMs: Date.now() - started, status: error.status, errorKind: error.name}, 'error');
    reply({ok: false, error: error.message || 'Ошибка операции.'});
  });
  return true;
});
