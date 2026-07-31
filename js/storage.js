/* ─────────────────────────────────────────────
   Aurora — offline storage layer
   IndexedDB for reports (works offline), localStorage for settings
   ───────────────────────────────────────────── */
const Storage = (() => {
  const DB_NAME = 'aurora-reports';
  const DB_VER = 1;
  const STORE = 'reports';
  const SETTINGS_KEY = 'aurora-settings';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const req = fn(store);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const api = {
    supported() {
      return typeof indexedDB !== 'undefined';
    },

    // ── settings ──
    getSettings() {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      } catch { return {}; }
    },
    saveSettings(s) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    },

    // ── reports ──
    saveReport(report) {
      if (!api.supported()) return Promise.reject(new Error('IndexedDB not available'));
      return tx('readwrite', store => store.put(report));
    },
    getAllReports() {
      if (!api.supported()) return Promise.resolve([]);
      return tx('readonly', store => store.getAll()).then(list =>
        (list || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    },
    getReport(id) {
      return tx('readonly', store => store.get(id));
    },
    deleteReport(id) {
      return tx('readwrite', store => store.delete(id));
    },
    clearAll() {
      return tx('readwrite', store => store.clear());
    },
    count() {
      return tx('readonly', store => store.count());
    },
  };

  return api;
})();
