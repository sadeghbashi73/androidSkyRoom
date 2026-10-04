/**
 * Storage Layer - IndexedDB wrapper
 * Stores rooms, credentials, settings in IndexedDB with Promise API.
 * Falls back to localStorage if IDB is unavailable.
 */

const DB_NAME = 'skyroom-pwa';
const DB_VERSION = 1;
const STORE_ROOMS = 'rooms';
const STORE_SETTINGS = 'settings';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        const s = db.createObjectStore(STORE_ROOMS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const Storage = {
  /* ---------- Rooms ---------- */
  async addRoom(room) {
    const store = await tx(STORE_ROOMS, 'readwrite');
    return promisify(store.add(room));
  },
  async updateRoom(room) {
    const store = await tx(STORE_ROOMS, 'readwrite');
    return promisify(store.put(room));
  },
  async deleteRoom(id) {
    const store = await tx(STORE_ROOMS, 'readwrite');
    return promisify(store.delete(id));
  },
  async getRoom(id) {
    const store = await tx(STORE_ROOMS);
    return promisify(store.get(id));
  },
  async getAllRooms() {
    const store = await tx(STORE_ROOMS);
    const rooms = await promisify(store.getAll());
    return (rooms || []).sort((a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt));
  },

  /* ---------- Settings ---------- */
  async getSetting(key, defaultValue = null) {
    try {
      const store = await tx(STORE_SETTINGS);
      const result = await promisify(store.get(key));
      return result ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  async setSetting(key, value) {
    const store = await tx(STORE_SETTINGS, 'readwrite');
    return promisify(store.put({ key, value }));
  },
};

/**
 * Quick util - generate a stable-ish ID for new entries.
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Sanitize a Skyroom class link and extract its room path.
 *
 * Real class links look like https://www.skyroom.online/ch/{account}/{room}.
 * Accepted input:
 *   - a full link (any https host, so white-label Skyroom domains work too)
 *   - a link without the protocol (skyroom.online/ch/acme/math)
 *   - just "{account}/{room}"
 * A single bare word is rejected: the account name cannot be guessed, and
 * the old guess (/chs/room/{id}) does not exist on Skyroom and gave a 404.
 *
 * @returns {{url:string, roomId:string|null}|null}
 */
export function normalizeSkyroomUrl(input) {
  if (!input) return null;
  let str = String(input).trim();
  if (!str) return null;

  // "account/room" shorthand.
  const short = str.match(/^\/?([\w-]+)\/([\w.-]+)\/?$/);
  if (short) {
    return {
      url: `https://www.skyroom.online/ch/${short[1]}/${short[2]}`,
      roomId: `${short[1]}/${short[2]}`,
    };
  }

  if (!/^https?:\/\//i.test(str)) {
    // Only something that starts with a host name can become a link.
    if (!/^[\w-]+(\.[\w-]+)+(\/|$)/.test(str)) return null;
    str = 'https://' + str;
  }

  let u;
  try { u = new URL(str); } catch { return null; }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (isLegacyBrokenUrl(u.toString())) return null;

  const m = u.pathname.match(/\/ch\/([^/]+)\/([^/?#]+)/i);
  return { url: u.toString(), roomId: m ? `${m[1]}/${m[2]}` : null };
}

/** True for links saved by older versions with the invented /chs/room/ path. */
export function isLegacyBrokenUrl(url) {
  return /skyroom\.online\/chs\/room\//i.test(url || '');
}