import {TOKEN_TTL, SIGN_PAGE, tokenValid, request, parseResults} from './core.js';
chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
chrome.action.onClicked.addListener(() => chrome.tabs.create({url: chrome.runtime.getURL('app.html')}));
let authOperation = null;
async function authState() {
  const {auth} = await chrome.storage.local.get('auth');
  return {valid: tokenValid(auth), expiresAt: tokenValid(auth) ? auth.expiresAt : null};
}
async function begin() {
  if ((await authState()).valid) return authState();
  const existing = (await chrome.storage.session.get('challenge')).challenge;
  if (existing && existing.createdAt + 5 * 60 * 1000 > Date.now()) {
    try { await chrome.tabs.update(existing.tabId, {active: true}); }
    catch {
      const tab = await chrome.tabs.create({url: 'about:blank'});
      await chrome.storage.session.set({challenge: {...existing, tabId: tab.id}});
      await chrome.tabs.update(tab.id, {url: SIGN_PAGE});
    }
    return {pending: true};
  }
  const challenge = await request('/auth/key');
  if (typeof challenge.uuid !== 'string' || !challenge.uuid || typeof challenge.data !== 'string' || !challenge.data) {
    throw new Error('В ответе auth/key отсутствуют uuid или data.');
  }
  const tab = await chrome.tabs.create({url: 'about:blank'});
  await chrome.storage.session.set({challenge: {...challenge, tabId: tab.id, createdAt: Date.now()}});
  await chrome.tabs.update(tab.id, {url: SIGN_PAGE});
  return {pending: true};
}
async function signIn(signature) {
  if ((await authState()).valid) return authState();
  const {challenge} = await chrome.storage.session.get('challenge');
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
  await chrome.storage.local.set({auth: {token: response.token, expiresAt: issuedAt + TOKEN_TTL}});
  await chrome.storage.session.remove('challenge');
  return authState();
}
async function handle(message, sender) {
  const isApp = sender.url === chrome.runtime.getURL('app.html');
  const isSigner = sender.url?.split('?')[0].split('#')[0] === SIGN_PAGE;
  if (!isApp && !isSigner) throw new Error('Недопустимый источник сообщения.');
  if (isSigner) {
    const {challenge} = await chrome.storage.session.get('challenge');
    if (!challenge || sender.tab?.id !== challenge.tabId) throw new Error('Нет активного запроса подписи для этой вкладки.');
    if (message.type === 'challenge') return {data: challenge.data};
    if (message.type === 'signature') return exclusive(() => signIn(message.signature));
    throw new Error('Недопустимая команда.');
  }
  switch (message.type) {
    case 'status': return authState();
    case 'begin': return exclusive(begin);
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
  handle(message, sender).then(value => reply({ok: true, value}), error => reply({ok: false, error: error.message || 'Ошибка операции.'}));
  return true;
});
