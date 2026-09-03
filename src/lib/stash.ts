/*
 * stash.ts — keeping the user's video across the trip to Stripe.
 *
 * THE PROBLEM
 * Stripe's hosted Checkout is a full navigation off the origin. The /app
 * document is torn down, and with it the File the user dropped, the scan, and
 * the object URL. On return they face an empty dropzone and have to select the
 * same file again and press Download again — which is exactly the complaint
 * "I had to go through the whole process again".
 *
 * Nothing about the paywall causes this. Even POSTing to checkout directly from
 * the tool, with no intermediate page, still ends in `window.location.href =
 * stripeUrl`. The document dies either way, so the file has to be persisted or
 * the journey cannot be seamless.
 *
 * WHY INDEXEDDB
 * It is the only browser store that takes a Blob of this size. localStorage is
 * strings only and caps around 5 MB; sessionStorage is the same and is also
 * cleared by the cross-origin round trip in some browsers. IndexedDB stores the
 * Blob by reference in most engines, so writing a 200 MB file does not mean
 * serialising 200 MB through JavaScript.
 *
 * THE PRIVACY CLAIM IS UNAFFECTED. This is the user's own browser writing to
 * the user's own disk. The video still never reaches a server — the only thing
 * that is ever uploaded is the index. But it IS a copy the user did not
 * explicitly ask for, so it is deleted the moment it has been used, and on any
 * failure, and it carries an explicit expiry.
 *
 * EVERY OPERATION IS BEST-EFFORT. Quota limits vary enormously — a phone with a
 * full disk, Safari's stricter budget, a private window where the whole API may
 * be unavailable. A failed stash must degrade to "drop your file again", never
 * to a broken page.
 */

const DB_NAME = 'pristine';
const STORE = 'stash';
const KEY = 'pending';
/*
 * A day. It was an hour, and the copy now has to outlive sign-in AND the
 * payment page AND however long someone takes between the two. It lives in
 * the reader's own browser profile on their own disk, is deleted the moment a
 * download succeeds, and never leaves the device -- the same promise the site
 * makes about the file itself.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
/* Copies up to this size are re-read into memory on restore (see rehydrateFile). */
const REHYDRATE_MAX = 400 * 1024 * 1024;

export interface StashedFile {
  file: File;
  name: string;
  savedAt: number;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // A blocked upgrade (another tab holding the old version) must not hang
      // the checkout the user is trying to start.
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      t.onabort = () => resolve(null);   // quota exceeded lands here
      t.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Save the file before leaving for Stripe.
 *
 * Returns false when it could not be stored — out of quota, private browsing,
 * IndexedDB unavailable. The caller must treat that as "the user will have to
 * re-select on return" and not as an error worth showing them now, because the
 * payment is the thing they are in the middle of.
 */
export async function stashFile(file: File): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  try {
    const put = (f: File) => tx(db, 'readwrite', (s) =>
      s.put({ file: f, name: f.name, savedAt: Date.now() }, KEY) as IDBRequest<IDBValidKey>);
    if ((await put(file)) !== null) return true;
    /*
     * A file that came back out of this store is disk-backed in a way some
     * engines will not write back in. One retry with a plain in-memory copy,
     * for anything that fits.
     */
    if (file.size > REHYDRATE_MAX) return false;
    const copy = new File([await file.arrayBuffer()], file.name, { type: file.type || 'video/mp4', lastModified: file.lastModified });
    return (await put(copy)) !== null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * A restored file, made plain.
 *
 * A File read back from IndexedDB is backed by the browser's blob store rather
 * than by memory, and a <video> element plays those less reliably than an
 * ordinary one -- the reported symptom was a preview that came back black
 * while the same bytes scanned fine. Re-reading it into memory gives the
 * media pipeline an ordinary blob. Bounded by size so a very large file is
 * used as it is rather than risking the memory.
 */
export async function rehydrateFile(file: File): Promise<File> {
  if (file.size > REHYDRATE_MAX) return file;
  try {
    return new File([await file.arrayBuffer()], file.name, {
      type: file.type || 'video/mp4',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

/**
 * Read WITHOUT consuming. The caller restores the file and only then clears
 * the stash (clearStash), so an interrupted restore -- a re-mounted effect, a
 * navigation mid-way -- does not lose the one copy there is. The previous
 * take-and-delete did exactly that under React's development double-mount:
 * the first run took the file and was cancelled, the second found nothing.
 */
export async function peekStashedFile(): Promise<File | null> {
  const db = await open();
  if (!db) return null;
  try {
    const row = await tx<StashedFile>(db, 'readonly', (s) =>
      s.get(KEY) as IDBRequest<StashedFile>);
    if (!row || !row.file) return null;
    if (Date.now() - row.savedAt > TTL_MS) {
      /* Past its time: remove it rather than leave a copy of someone's video
       * sitting on disk for a return that is not coming. */
      await tx(db, 'readwrite', (s) => s.delete(KEY)).catch(() => {});
      return null;
    }
    return row.file;
  } finally {
    db.close();
  }
}

/** Retrieve and immediately delete. Reading it twice is never wanted. */
export async function takeStashedFile(): Promise<File | null> {
  const db = await open();
  if (!db) return null;
  try {
    const row = await tx<StashedFile>(db, 'readonly', (s) =>
      s.get(KEY) as IDBRequest<StashedFile>);
    await tx(db, 'readwrite', (s) => s.delete(KEY) as unknown as IDBRequest<undefined>);

    if (!row || !row.file) return null;
    // A file left behind by an abandoned checkout should not resurface days
    // later on a machine the user has since handed to someone else.
    if (Date.now() - row.savedAt > TTL_MS) return null;
    return row.file;
  } finally {
    db.close();
  }
}

/** Drop anything stashed. Safe to call when there is nothing there. */
export async function clearStash(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (s) => s.delete(KEY) as unknown as IDBRequest<undefined>);
  } finally {
    db.close();
  }
}
