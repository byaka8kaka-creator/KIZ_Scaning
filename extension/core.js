export const TOKEN_TTL = 10 * 60 * 60 * 1000;
export const API = 'https://markirovka.crpt.ru/api/v3/true-api';
export const SIGN_PAGE = 'https://cryptopro.ru/sites/default/files/products/cades/demopage/cades_bes_sample.html';
export function tokenValid(auth, now = Date.now()) {
  return !!(auth && typeof auth.token === 'string' && auth.token && Number.isFinite(auth.expiresAt) && auth.expiresAt > now);
}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function request(path, {body, token, fetchImpl = fetch} = {}) {
  const headers = {Accept: 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    // Do not expose response bodies: auth endpoints may echo credentials.
    throw new ApiError(response.status, response.status === 401
      ? 'Токен недействителен. Авторизуйтесь повторно.'
      : `API вернул HTTP ${response.status}. Повторите запрос позже или проверьте доступ к Честному знаку.`);
  }
  try { return await response.json(); }
  catch { throw new Error('API вернул некорректный JSON.'); }
}
export function extractCodes(rows, column, hasHeader) {
  const codes = [], errors = [], seen = new Set();
  rows.slice(hasHeader ? 1 : 0).forEach((row, i) => {
    const value = row[column];
    if (value === undefined || value === null || value === '') return;
    const line = i + (hasHeader ? 2 : 1);
    if (typeof value !== 'string') {
      errors.push(`Строка ${line}: КИЗ должен быть текстом; числовая ячейка может потерять нули и точность.`); return;
    }
    const text = value.trim();
    if (!text) return;
    if (text.length < 24) { errors.push(`Строка ${line}: меньше 24 символов.`); return; }
    const cis = text.slice(0, 24);
    if (!seen.has(cis)) { seen.add(cis); codes.push(cis); }
  });
  return {codes, errors};
}
export function parseResults(payload, requested) {
  if (!Array.isArray(payload)) throw new Error('Неожиданный формат ответа cises/info: ожидался массив.');
  const byCis = new Map();
  for (const item of payload) {
    const info = item?.cisInfo ?? item;
    const cis = info?.cis ?? item?.cis ?? item?.requestedCis;
    if (typeof cis !== 'string') continue;
    const errorCode = item?.errorCode ?? info?.errorCode;
    byCis.set(cis, {
      cis, gtin: info.gtin ?? '', expirationDate: info.expirationDate ?? '',
      error: errorCode ? `Ошибка API: ${errorCode}` : (item?.errorMessage ?? '')
    });
  }
  return requested.map(cis => byCis.get(cis) ?? {cis, gtin: '', expirationDate: '', error: 'Нет данных в ответе API'});
}
