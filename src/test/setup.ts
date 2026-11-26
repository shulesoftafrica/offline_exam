/**
 * Test environment.
 *
 * `fake-indexeddb/auto` gives Dexie a real IndexedDB implementation in Node, so the storage
 * and sync tests exercise the same code paths a lab machine does — transactions, indexes,
 * key collisions and all. Nothing in the core layer is mocked.
 */
import 'fake-indexeddb/auto';

// jsdom does not provide structuredClone, which Dexie uses when cloning records.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
    if (value instanceof Blob) return value; // blobs are passed by reference in tests
    if (Array.isArray(value)) return value.map((v) => globalThis.structuredClone(v)) as unknown as T;
    if (value instanceof Map) {
      return new Map(
        [...value.entries()].map(([k, v]) => [globalThis.structuredClone(k), globalThis.structuredClone(v)]),
      ) as unknown as T;
    }
    if (value instanceof Set) {
      return new Set([...value].map((v) => globalThis.structuredClone(v))) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = globalThis.structuredClone(v);
    }
    return out as T;
  };
}

// jsdom's Blob lacks arrayBuffer() on some versions; the file store depends on it.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
}
