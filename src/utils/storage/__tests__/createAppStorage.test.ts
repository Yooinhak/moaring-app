import { createAppStorage, type KeyValueStorage, type SharedStorageNative } from '../createAppStorage';

function fakeNative(): SharedStorageNative & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (suite, key) => data.get(`${suite}/${key}`) ?? null,
    setItem: (suite, key, value) => void data.set(`${suite}/${key}`, value),
    removeItem: (suite, key) => void data.delete(`${suite}/${key}`),
  };
}

function fakeFallback(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
    multiRemove: async (keys) => keys.forEach((k) => data.delete(k)),
  };
}

describe('createAppStorage', () => {
  it('네이티브가 있으면 suite 로 네이티브에 읽고 쓴다', async () => {
    const native = fakeNative();
    const fallback = fakeFallback();
    const storage = createAppStorage(native, 'group.test', fallback);

    await storage.setItem('k', 'v');
    expect(native.data.get('group.test/k')).toBe('v');
    expect(fallback.data.size).toBe(0);
    expect(await storage.getItem('k')).toBe('v');

    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('multiRemove 는 모든 키를 지운다', async () => {
    const native = fakeNative();
    const storage = createAppStorage(native, 'g', fakeFallback());
    await storage.setItem('a', '1');
    await storage.setItem('b', '2');
    await storage.setItem('c', '3');

    await storage.multiRemove(['a', 'b']);

    expect(await storage.getItem('a')).toBeNull();
    expect(await storage.getItem('b')).toBeNull();
    expect(await storage.getItem('c')).toBe('3');
  });

  it('네이티브가 없으면(Android·웹) 폴백을 그대로 쓴다', async () => {
    const fallback = fakeFallback();
    const storage = createAppStorage(null, 'g', fallback);

    await storage.setItem('k', 'v');

    expect(fallback.data.get('k')).toBe('v');
    expect(storage).toBe(fallback);
  });
});
