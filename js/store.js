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
  // All records whose key starts with `prefix`, with the prefix stripped from the
  // returned key. Used to hydrate per-document ledgers (read::<docKey>).
  getAllByPrefix: (prefix)=> db().then(d => new Promise((resolve, reject)=>{
    const out = [];
    const req = d.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = ()=>{ const c = req.result; if(!c){ resolve(out); return; }
      const k = String(c.key); if(k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), val: c.value });
      c.continue(); };
    req.onerror = ()=> reject(req.error);
  })),
  // Per-document block-presentation preference. Same store, namespaced key — no
  // schema/VERSION bump. Tiny + book-scoped, so pruneStore() retains these keys.
  getBlockMode: (docKey)=> tx("readonly",  s=>s.get("blockmode::"+docKey)),
  putBlockMode: (docKey, val)=> tx("readwrite", s=>s.put(val, "blockmode::"+docKey)),
  // Per-document highlight ranges (index-based, re-anchor on reopen). Namespaced key.
  getHighlights: (docKey)=> tx("readonly",  s=>s.get("hl::"+docKey)),
  putHighlights: (docKey, val)=> tx("readwrite", s=>s.put(val, "hl::"+docKey)),
};
