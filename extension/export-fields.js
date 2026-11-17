export const OPTIONAL_FIELDS = [
  'ownerName', 'ownerInn', 'applicationDate', 'introducedDate', 'isVarQuantity',
  'isMultipleSales', 'isTracking', 'manufacturerInn', 'manufacturerName', 'requestedCis',
  'tnVedEaes', 'tnVedEaesGroup', 'productName', 'productGroupId', 'productGroup', 'brand',
  'producedDate', 'emissionDate', 'emissionType', 'packageType', 'generalPackageType',
  'statusEx', 'child', 'producerInn', 'producerName', 'prVetDocument', 'markWithdraw'
];
export const DEFAULT_OPTIONAL_FIELDS = ['ownerName', 'ownerInn'];
export const REQUIRED_FIELDS = ['cis', 'cis_full', 'gtin', 'expirationDate', 'comment', 'article', 'status', 'unit', 'error'];
export function selectedFields(saved) {
  return Array.isArray(saved) ? OPTIONAL_FIELDS.filter(key => saved.includes(key)) : [...DEFAULT_OPTIONAL_FIELDS];
}
export function apiFields(info, item) {
  return Object.fromEntries(OPTIONAL_FIELDS.map(key => {
    let value = info?.[key] ?? item?.[key] ?? '';
    if (key === 'child' && Array.isArray(value)) value = value.join(', ');
    else if (typeof value === 'object') value = JSON.stringify(value);
    if (key.endsWith('Inn') || key === 'ownerName') value = String(value);
    return [key, value];
  }));
}
export function exportFields(optional, returning = false) {
  return [...REQUIRED_FIELDS, ...selectedFields(optional), ...(returning ? ['returnDocument'] : [])];
}
export function projectExport(rows, optional, returning = false) {
  const fields = exportFields(optional, returning);
  return rows.map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? ''])));
}
export function jsonExport(rows, optional, returning = false) {
  const labels = {expirationDate: 'Срок годности', article: 'Артикул', status: 'Статус', unit: 'Единица измерений', returnDocument: '№Документа на возврат'};
  return projectExport(rows, optional, returning).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [labels[key] || key, value])));
}
