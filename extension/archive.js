export function archiveFilename(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.xlsx`;
}
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kiz-archive', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function setting(value, write = false) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('settings');
      const request = write ? store.put(value, 'directory') : store.get('directory');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export class Archive {
  handle = null;
  async restore() {
    const restored = await setting();
    if (!this.handle) this.handle = restored;
    return this.handle && await this.handle.queryPermission({mode: 'readwrite'}) === 'granted';
  }
  async choose() {
    if (typeof globalThis.showDirectoryPicker !== 'function') throw new Error('Этот браузер не поддерживает выбор папки для автоматического архива. Используйте «Скачать Excel».');
    this.handle = await globalThis.showDirectoryPicker({id: 'kiz-archive', mode: 'readwrite'});
    // Keep the usable handle even if this browser cannot persist it.
    let retained = true;
    try { await setting(this.handle, true); } catch { retained = false; }
    return retained;
  }
  async write(bytes, receivedAt) {
    if (!this.handle) throw new Error('Сначала выберите папку C:\\ExtensionKIZ\\Архив кнопкой «Выбрать папку архива».');
    if (await this.handle.queryPermission({mode: 'readwrite'}) !== 'granted') throw new Error('Доступ к папке архива не разрешён. Выберите папку повторно.');
    const base = archiveFilename(receivedAt);
    let name = base;
    for (let index = 1; ; index++) {
      try { await this.handle.getFileHandle(name); }
      catch (error) { if (error.name === 'NotFoundError') break; throw error; }
      name = base.replace('.xlsx', `_${index}.xlsx`);
    }
    const file = await this.handle.getFileHandle(name, {create: true});
    const writable = await file.createWritable();
    try { await writable.write(bytes); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
    return name;
  }
}
