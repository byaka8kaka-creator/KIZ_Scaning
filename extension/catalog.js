export const ARTICLE_MISSING = 'Не найден в справочнике';
export function normalizeGtin(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  return /^\d{1,14}$/.test(text) ? text.padStart(14, '0') : null;
}
export function parseCatalog(rows) {
  const first = rows.findIndex(row => row.some(value => value !== '' && value != null));
  if (first < 0) throw new Error('Справочник пуст.');
  const headers = rows[first].map(value => String(value ?? '').trim().toLowerCase());
  const gtinColumn = headers.indexOf('gtin'), articleColumn = headers.indexOf('артикул');
  if (gtinColumn < 0 || articleColumn < 0 || headers.lastIndexOf('gtin') !== gtinColumn || headers.lastIndexOf('артикул') !== articleColumn) {
    throw new Error('В первой непустой строке нужны уникальные заголовки GTIN и Артикул.');
  }
  const entries = new Map(), sources = new Map(), errors = [];
  rows.slice(first + 1).forEach((row, index) => {
    const line = first + index + 2;
    const rawGtin = row[gtinColumn], rawArticle = row[articleColumn];
    if ([rawGtin, rawArticle].every(value => value == null || String(value).trim() === '')) return;
    const gtin = normalizeGtin(rawGtin);
    const article = typeof rawArticle === 'string' || (typeof rawArticle === 'number' && Number.isSafeInteger(rawArticle)) ? String(rawArticle).trim() : '';
    if (!gtin || !article) { errors.push(`Строка ${line}: GTIN должен содержать от 1 до 14 цифр, артикул не должен быть пустым.`); return; }
    if (entries.has(gtin) && entries.get(gtin) !== article) {
      errors.push(`Конфликт GTIN ${gtin}: строки ${sources.get(gtin)} и ${line} содержат разные артикулы.`);
    } else if (!entries.has(gtin)) { entries.set(gtin, article); sources.set(gtin, line); }
  });
  if (errors.length) throw new Error(errors.slice(0, 50).join('\n') + (errors.length > 50 ? '\nПоказаны первые 50 ошибок.' : ''));
  if (!entries.size) throw new Error('В справочнике нет записей.');
  return [...entries];
}
export function articleFor(gtin, entries) {
  return entries.get(normalizeGtin(gtin)) ?? ARTICLE_MISSING;
}
