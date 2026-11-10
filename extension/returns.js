export const RETURN_INN = '010501669800';
export const RETURN_BATCH_SIZE = 100;
export const RETURN_PATH = '/lk/documents/create?pg=petfood';
export function eligibleReturns(rows, documents = {}, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const seen = new Set();
  return rows.filter(row => {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(row.expirationDate || '');
    if (!match || row.status !== 'RETIRED' || typeof row.cis !== 'string' || row.cis.length !== 24 || documents[row.cis] || seen.has(row.cis)) return false;
    const [, day, month, year] = match.map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getTime() <= today) return false;
    seen.add(row.cis); return true;
  });
}
export function returnDocument(rows) {
  return JSON.stringify({trade_participant_inn: RETURN_INN, return_type: 'OWN_USE_RETURN', products_list: rows.map(row => ({ki: row.cis}))});
}
export function documentBase64(data) {
  return btoa(Array.from(new TextEncoder().encode(data), byte => String.fromCharCode(byte)).join(''));
}
