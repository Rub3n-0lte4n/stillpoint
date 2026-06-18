// Local file cache backed by IndexedDB — stores uploaded files (and pasted text)
// on the device so the recent library can reopen them without re-uploading.
// Everything stays local; nothing is ever sent anywhere.
const DB_NAME = "stillpoint", STORE = "files", VERSION = 1;
let dbPromise = null;

function db(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = ()=>{ const d=req.result; if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror   = ()=>reject(req.error);
  });
  return dbPromise;
}
function tx(mode, fn){
  return db().then(d => new Promise((resolve, reject)=>{
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = ()=>resolve(req && req.result);
    t.onerror = t.onabort = ()=>reject(t.error);
  }));
}

export const Store = {
  put: (key, val)=> tx("readwrite", s=>s.put(val, key)),
  get: (key)=> tx("readonly",  s=>s.get(key)),
  del: (key)=> tx("readwrite", s=>s.delete(key)),
  keys:()=> tx("readonly",  s=>s.getAllKeys()),
};
