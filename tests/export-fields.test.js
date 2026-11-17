import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OPTIONAL_FIELDS, REQUIRED_FIELDS, selectedFields, projectExport, jsonExport} from '../extension/export-fields.js';
import {parseResults} from '../extension/core.js';
test('all optional API fields are preserved, child is joined, false and zero remain typed', () => {
  const details = Object.fromEntries(OPTIONAL_FIELDS.map(key => [key, key + '-value']));
  Object.assign(details, {child: ['child1', 'child2'], isVarQuantity: false, isTracking: true, isMultipleSales: false, productGroupId: 0, ownerInn: '001234567890'});
  const [row] = parseResults([{requestedCis: 'requested', cisInfo: {cis: 'code', ...details}}], ['code']);
  const expected = {...details, child: 'child1, child2'};
  for (const field of OPTIONAL_FIELDS) assert.equal(row[field], expected[field], field);
  assert.equal(parseResults([{requestedCis: 'code', cisInfo: {cis: 'code'}}], ['code'])[0].requestedCis, 'code');
  assert.equal(parseResults([{cis: 'code', child: []}], ['code'])[0].child, '');
});
test('export projection always keeps mandatory fields and excludes unchecked or unknown fields', () => {
  const row = {cis: 'code', ownerName: 'Owner', ownerInn: '001234567890', isTracking: false, child: 'a, b', productGroupId: 0, privateField: 'hidden'};
  assert.deepEqual(selectedFields(undefined), ['ownerName', 'ownerInn']);
  assert.deepEqual(selectedFields(['privateField', 'ownerName']), ['ownerName']);
  assert.deepEqual(Object.keys(projectExport([row], [])[0]), REQUIRED_FIELDS);
  const selected = projectExport([row], ['ownerInn', 'isTracking', 'child', 'productGroupId'])[0];
  assert.equal('ownerName' in selected, false); assert.equal('privateField' in selected, false);
  assert.equal(selected.isTracking, false); assert.equal(selected.productGroupId, 0);
  assert.equal(selected.ownerInn, '001234567890');
  const json = jsonExport([row], ['isTracking', 'child'])[0];
  assert.equal(json.isTracking, false); assert.equal(json.child, 'a, b');
  assert.equal('ownerInn' in json, false); assert.equal('expirationDate' in json, false);
  assert.equal(json['Срок годности'], '');
  assert.equal(Object.keys(jsonExport([row], [], true)[0]).at(-1), '№Документа на возврат');
});
