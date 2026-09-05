/**
 * 設定とスナップショットの保存。
 *
 * [改良版の設計](../../../docs/webapp-design.md)の 8 節のとおり IndexedDB を使う。
 * スナップショットは 1 件ごとに全試行の集計とスキルごとの集計を抱えるため、
 * `localStorage` の 5 MB 前後という上限にすぐ当たる。
 *
 * 保存は「できたらする」ものとして扱う。プライベートウィンドウや、
 * サイトデータを止めている環境では開けないことがある。
 * その場合はメモリ上だけで動き、画面は何も変わらない。
 */

const DB_NAME = 'raceemu';
const DB_VERSION = 1;
const STORE = 'state';

/** 保存形式の版。読めない版は捨てて既定値で立ち上げる。 */
export const RECORD_VERSION = 1;

export interface PersistedRecord<T> {
  readonly version: number;
  readonly value: T;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** 保存先が使えるか。使えない環境ではメモリ上だけで動く。 */
export async function isPersistenceAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function loadPersisted<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    let request: IDBRequest<unknown>;
    try {
      request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => {
      const record = request.result as PersistedRecord<T> | undefined;
      if (record === undefined || record.version !== RECORD_VERSION) resolve(null);
      else resolve(record.value);
    };
    request.onerror = () => resolve(null);
  });
}

export async function savePersisted<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE, 'readwrite');
      // 構造化クローンできない値が混じっていれば、ここで例外になる。
      transaction.objectStore(STORE).put({ version: RECORD_VERSION, value }, key);
    } catch {
      resolve();
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

/**
 * 書き込みをまとめる。設定は 1 文字打つたびに変わるので、
 * 落ち着いてから 1 回だけ書く。
 */
export function debounceSave<T>(key: string, waitMs = 400): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  return (value: T) => {
    pending = value;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pending !== null) void savePersisted(key, pending);
    }, waitMs);
  };
}
