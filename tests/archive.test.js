import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Archive, archiveFilename} from '../extension/archive.js';
test('archive names contain local date and reception time; collision does not overwrite existing file', async () => {
  const received = new Date(2026, 9, 29, 12, 34, 56, 789);
  const name = archiveFilename(received);
  assert.equal(name, '2026-10-29_12-34-56-789.xlsx');
  const archive = new Archive();
  const files = new Map([[name, new Uint8Array([9])]]);
  archive.handle = {
    queryPermission: async () => 'granted',
    getFileHandle: async (path, options) => {
      if (!files.has(path) && !options?.create) throw Object.assign(new Error(), {name: 'NotFoundError'});
      return {createWritable: async () => ({write: async bytes => files.set(path, bytes), close: async () => {}})};
    }
  };
  const saved = await archive.write(new Uint8Array([1, 2]), received);
  assert.equal(saved, '2026-10-29_12-34-56-789_1.xlsx');
  assert.deepEqual(files.get(name), new Uint8Array([9]));
  assert.deepEqual(files.get(saved), new Uint8Array([1, 2]));
});
test('archive refuses missing/denied permission and aborts failed writes', async () => {
  const archive = new Archive();
  await assert.rejects(archive.write(new Uint8Array(), new Date()), /Сначала выберите папку/);
  archive.handle = {queryPermission: async () => 'prompt'};
  await assert.rejects(archive.write(new Uint8Array(), new Date()), /не разрешён/);
  let aborted = false;
  archive.handle = {
    queryPermission: async () => 'granted',
    getFileHandle: async (_, options) => {
      if (!options?.create) throw Object.assign(new Error(), {name: 'NotFoundError'});
      return {createWritable: async () => ({write: async () => {throw new Error('disk full');}, abort: async () => {aborted = true;}})};
    }
  };
  await assert.rejects(archive.write(new Uint8Array(), new Date()), /disk full/);
  assert.equal(aborted, true);
});
