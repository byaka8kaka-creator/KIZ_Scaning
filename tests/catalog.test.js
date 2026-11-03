import {test} from 'node:test';
import assert from 'node:assert/strict';
import XLSX from '@e965/xlsx';
import {parseCatalog, normalizeGtin, articleFor, unitFor, ARTICLE_MISSING} from '../extension/catalog.js';
for (const bookType of ['xls', 'xlsx']) test(`catalog ${bookType}: text zeros, numeric GTIN, same article for multiple GTINs, duplicate rows`, () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Артикул', 'GTIN'], ['000A', '04650096350778'], ['000A', 4650096352222], ['000A', '04650096350778']]), 'Справочник');
  const read = XLSX.read(XLSX.write(book, {type: 'buffer', bookType}), {type: 'buffer'});
  const entries = parseCatalog(XLSX.utils.sheet_to_json(read.Sheets['Справочник'], {header: 1, raw: true}));
  assert.equal(entries.length, 2);
  assert.equal(articleFor('04650096350778', new Map(entries)), '000A');
  assert.equal(articleFor('04650096352222', new Map(entries)), '000A');
  assert.equal(articleFor(null, new Map(entries)), ARTICLE_MISSING);
});
test('catalog rejects conflicts with actual row numbers, including normalized duplicate GTINs', () => {
  assert.throws(() => parseCatalog([[], ['GTIN', 'Артикул'], ['04650096350778', 'A'], [4650096350778, 'B']]), /строки 3 и 4/);
  assert.throws(() => parseCatalog([['GTIN', 'Артикул'], ['bad', 'A']]), /Строка 2/);
  assert.throws(() => parseCatalog([['GTIN', 'Артикул'], ['04650096350778', '']]), /Строка 2/);
  assert.throws(() => parseCatalog([['GTIN', 'GTIN', 'Артикул']]), /уникальные заголовки/);
  assert.throws(() => parseCatalog([]), /пуст/);
  assert.throws(() => parseCatalog([['GTIN', 'Артикул']]), /нет записей/);
  assert.equal(normalizeGtin('04650096350778'), '04650096350778');
  assert.equal(normalizeGtin(4650096350778), '04650096350778');
  assert.equal(normalizeGtin(12.34), null);
  assert.equal(normalizeGtin('1e13'), null);
});

test('catalog units follow normalized GTIN, persist and reject conflicting duplicates', () => {
  const entries = parseCatalog([['GTIN', 'Артикул', 'Единица измерений'],
    ['04650096350778', 'A', ' шт '], [4650096350778, 'A', 'шт'], ['04650096352222', 'A', 'кг']]);
  const catalog = new Map(JSON.parse(JSON.stringify(entries)));
  assert.equal(unitFor(4650096350778, catalog), 'шт');
  assert.equal(unitFor('04650096352222', catalog), 'кг');
  assert.equal(unitFor('1', catalog), '');
  assert.equal(articleFor('04650096350778', catalog), 'A');
  assert.equal(unitFor('1', new Map([['00000000000001', 'legacy']])), '');
  assert.equal(articleFor('1', new Map([['00000000000001', 'legacy']])), 'legacy');
  assert.equal(unitFor('1', new Map(parseCatalog([['GTIN', 'Артикул'], ['1', 'A']]))), '');
  assert.throws(() => parseCatalog([['GTIN', 'Артикул', 'Единица измерений'], ['1', 'A', 'шт'], ['1', 'A', 'кг']]), /строки 2 и 3/);
  assert.throws(() => parseCatalog([['GTIN', 'Артикул', 'Единица измерений', 'Единица измерений']]), /уникальным/);
});
