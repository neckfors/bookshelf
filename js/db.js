// books: saved covers (can be rebuilt). state: per-book settings (must survive refreshes). kv: the rest.
let dbPromise;
function open() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('bookshelf', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('books', { keyPath: 'path' });
      req.result.createObjectStore('state', { keyPath: 'path' });
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const getAll = store => run(store, 'readonly', s => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', s => s.put(value, key));
export const putMany = (store, values) => run(store, 'readwrite', s => { values.forEach(v => s.put(v)); });
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clear = store => run(store, 'readwrite', s => s.clear());
export const kvGet = key => run('kv', 'readonly', s => s.get(key));
export const kvSet = (key, value) => put('kv', value, key);
