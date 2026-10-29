// Structured metadata only: never store arbitrary messages, HTTP bodies or user input.
const KEYS = new Set(['operation', 'durationMs', 'status', 'count', 'valid', 'localAccessControl', 'sessionAccessControl', 'sessionStorage', 'errorKind', 'rowCount', 'columnCount', 'sheetCount', 'errorCount', 'columnIndex', 'hasHeader']);
let pending = Promise.resolve();
export function safeDetails(details = {}) {
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => KEYS.has(key) &&
    (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,80}$/.test(value)))));
}
export function record(event, details = {}, level = 'info') {
  const entry = {time: new Date().toISOString(), level, event, details: safeDetails(details)};
  pending = pending.catch(() => {}).then(async () => {
    const {diagnosticLog = []} = await chrome.storage.local.get('diagnosticLog');
    await chrome.storage.local.set({diagnosticLog: [...diagnosticLog, entry].slice(-500)});
  }).catch(() => { console.warn('KIZ diagnostic storage unavailable'); });
  return pending;
}
export async function configureAccess() {
  const capabilities = {
    localAccessControl: typeof chrome.storage.local.setAccessLevel === 'function',
    sessionAccessControl: typeof chrome.storage.session?.setAccessLevel === 'function',
    sessionStorage: !!chrome.storage.session
  };
  for (const area of [chrome.storage.local, chrome.storage.session]) {
    if (typeof area?.setAccessLevel === 'function') {
      try { await area.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}); }
      catch (error) { await record('storage.access_control_failed', {errorKind: error.name}, 'warn'); }
    }
  }
  await record('worker.started', capabilities);
}
