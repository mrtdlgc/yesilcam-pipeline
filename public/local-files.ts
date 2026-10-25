import type { LocalWaveform } from './local-types.js';

// Share File references between studio and editor tabs. Never put a movie in IndexedDB.
const files = new Map<string, File>();
const channel =
  typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
    ? new BroadcastChannel(`yesilcam-local-media:${new URL('./', import.meta.url).pathname}`)
    : null;
channel?.addEventListener('message', (event) => {
  const { kind, id, request } = event.data ?? {};
  if (kind === 'request' && files.has(id))
    channel.postMessage({ kind: 'file', id, request, file: files.get(id) });
});
export function rememberLocalFile(id: string, file: File) {
  files.set(id, file);
}
export async function recallLocalFile(id: string): Promise<File | null> {
  if (files.has(id)) return files.get(id)!;
  if (!channel) return null;
  return new Promise((resolve) => {
    const request = crypto.randomUUID();
    const finish = (file: File | null) => {
      clearTimeout(timer);
      channel.removeEventListener('message', listen);
      resolve(file);
    };
    const listen = (event: MessageEvent) => {
      if (
        event.data?.kind === 'file' &&
        event.data.request === request &&
        event.data.file instanceof File
      ) {
        files.set(id, event.data.file);
        finish(event.data.file);
      }
    };
    const timer = setTimeout(() => finish(null), 700);
    channel.addEventListener('message', listen);
    channel.postMessage({ kind: 'request', id, request });
  });
}

async function cache(key: string, value?: LocalWaveform): Promise<LocalWaveform | null> {
  // Waveforms are small; failure to persist must never prevent playback or editing.
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yesilcam-local-waveforms', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('waveforms');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('waveforms', value ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('waveforms');
        const request = value ? store.put(value, key) : store.get(key);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => resolve(value ?? request.result ?? null);
      });
    } finally {
      db.close();
    }
  } catch {
    return value ?? null;
  }
}
export const readLocalWaveform = (key: string) => cache(key);
export const saveLocalWaveform = (key: string, value: LocalWaveform) => cache(key, value);
