import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import {
  DIARY_ENTRIES_STORAGE_KEY,
  DIARY_ENTRY_KEY_PREFIX,
  buildDiaryEntryKey,
  clearAllDiaryEntries,
  deleteDiaryEntry,
  getAllDiaryEntries,
  getDiaryEntryById,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `tests/app/index.test.tsx`と同じ方式。このモックは`getAllKeys`/`multiGet`/`multiSet`/
// `multiRemove`もサポートしている。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `jest-expo`が自動生成するexpo-cryptoのモックは`getRandomBytes`を持たないため、
// `tests/utils/diary-encryption.test.ts`と同様にNode標準の`crypto`モジュールで代替する。
// `getAllDiaryEntries`が内部で`getOrCreateEncryptionKey`(暗号鍵の生成・取得)を経由するために必要。
jest.mock('expo-crypto', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
    randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  };
});

// expo-secure-storeはjest-expoのオートモックだと`getItemAsync`が常に`undefined`を返し、
// 状態を永続化しない。`tests/utils/diary-encryption.test.ts`と同様、インメモリで
// キーと値を保持する独自モックに差し替える。
jest.mock('expo-secure-store', () => {
  let store: Record<string, string> = {};
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
    // テスト間で鍵の永続化状態を分離するためのヘルパー(実際のexpo-secure-storeには存在しない)
    __reset: () => {
      store = {};
    },
  };
});

const secureStoreMock = SecureStore as unknown as { __reset: () => void };

// 個別キー方式で保存されているエントリを、AsyncStorageから直接読み取って復号するヘルパー
async function readPersistedEntry(id: string): Promise<DiaryEntry | null> {
  const stored = await AsyncStorage.getItem(buildDiaryEntryKey(id));
  if (!stored) {
    return null;
  }
  const key = await getOrCreateEncryptionKey();
  return JSON.parse(decryptText(stored, key));
}

// テストの事前状態として、指定したエントリ群を個別キーへ暗号化して直接書き込むヘルパー
async function seedDiaryEntry(entry: DiaryEntry): Promise<void> {
  const key = await getOrCreateEncryptionKey();
  await AsyncStorage.setItem(buildDiaryEntryKey(entry.id), encryptText(JSON.stringify(entry), key));
}

describe('clearAllDiaryEntries', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('removes all entries stored under the per-entry keys from AsyncStorage (正常系)', async () => {
    await seedDiaryEntry({ id: '1', text: '1件目', createdAt: '2026-01-01T00:00:00.000Z' });
    await seedDiaryEntry({ id: '2', text: '2件目', createdAt: '2026-01-02T00:00:00.000Z' });

    await clearAllDiaryEntries();

    expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).toBeNull();
    expect(await AsyncStorage.getItem(buildDiaryEntryKey('2'))).toBeNull();
  });

  it('also removes the legacy single-key data if it still remains (念のためのレガシーキー削除)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');

    await clearAllDiaryEntries();

    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();
  });

  it('does not affect unrelated keys (他のキーに影響を与えないことの確認)', async () => {
    await seedDiaryEntry({ id: '1', text: '1件目', createdAt: '2026-01-01T00:00:00.000Z' });
    // 日記データ以外のキー(例: 他の設定値)が誤って削除されないことも確認する
    await AsyncStorage.setItem('other-unrelated-key', 'should survive');

    await clearAllDiaryEntries();

    expect(await AsyncStorage.getItem('other-unrelated-key')).toBe('should survive');
  });

  it('does not throw when there is no diary data to delete yet (境界値: 未保存状態での削除)', async () => {
    // 一度も日記を保存していない(=キーが存在しない)状態で呼び出しても例外にならないこと
    await expect(clearAllDiaryEntries()).resolves.toBeUndefined();
  });

  it('leaves AsyncStorage empty for the diary keys when called twice in a row (冪等性の確認)', async () => {
    await seedDiaryEntry({ id: '1', text: '1件目', createdAt: '2026-01-01T00:00:00.000Z' });

    await clearAllDiaryEntries();
    await clearAllDiaryEntries();

    expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).toBeNull();
  });

  it('propagates the error when the underlying AsyncStorage removal call fails (異常系)', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('storage error'));

    await expect(clearAllDiaryEntries()).rejects.toThrow('storage error');
  });

  it('exports the expected AsyncStorage key constants used across the app (回帰確認)', () => {
    // app/(tabs)/index.tsx側やこのテストファイルもこれらの定数を参照するため、
    // キーの実際の値そのものが意図せず変わっていないことを確認する
    expect(DIARY_ENTRIES_STORAGE_KEY).toBe('diary-entries');
    expect(DIARY_ENTRY_KEY_PREFIX).toBe('diary-entry:');
    expect(buildDiaryEntryKey('abc')).toBe('diary-entry:abc');
  });
});

describe('saveDiaryEntry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('persists a single entry under its own per-entry key, encrypted (正常系)', async () => {
    const entry: DiaryEntry = {
      id: '1',
      text: '今日はいい天気でした。',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await saveDiaryEntry(entry);

    const stored = await AsyncStorage.getItem(buildDiaryEntryKey('1'));
    expect(stored).toEqual(expect.stringMatching(/^encrypted:v1:/));
    expect(await readPersistedEntry('1')).toEqual(entry);
  });

  it('writes to exactly one AsyncStorage key without touching other entries (1回の書き込みで完結すること)', async () => {
    await seedDiaryEntry({
      id: 'other',
      text: '他のエントリ',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    jest.clearAllMocks();

    const entry: DiaryEntry = {
      id: 'new',
      text: '新規エントリ',
      createdAt: '2026-01-02T00:00:00.000Z',
    };
    await saveDiaryEntry(entry);

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      buildDiaryEntryKey('new'),
      expect.stringMatching(/^encrypted:v1:/),
    );
    // 既存の無関係なエントリは変化しない
    expect(await readPersistedEntry('other')).toEqual({
      id: 'other',
      text: '他のエントリ',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('overwrites the existing value when saving an edit to the same id (編集時の上書き)', async () => {
    const entry: DiaryEntry = {
      id: '1',
      text: '元のテキスト',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await saveDiaryEntry(entry);

    const updated: DiaryEntry = { ...entry, text: '編集後のテキスト' };
    await saveDiaryEntry(updated);

    expect(await readPersistedEntry('1')).toEqual(updated);
  });
});

describe('deleteDiaryEntry', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('removes only the specified entry key (正常系)', async () => {
    await seedDiaryEntry({ id: '1', text: '残す', createdAt: '2026-01-01T00:00:00.000Z' });
    await seedDiaryEntry({ id: '2', text: '消す', createdAt: '2026-01-02T00:00:00.000Z' });

    await deleteDiaryEntry('2');

    expect(await readPersistedEntry('1')).not.toBeNull();
    expect(await AsyncStorage.getItem(buildDiaryEntryKey('2'))).toBeNull();
  });

  it('does not throw when the entry does not exist (境界値)', async () => {
    await expect(deleteDiaryEntry('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('getDiaryEntryById', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('returns the decrypted entry matching the given id (正常系)', async () => {
    const entry: DiaryEntry = {
      id: '1',
      text: '編集画面から取得する日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await seedDiaryEntry(entry);
    await seedDiaryEntry({ id: '2', text: '別のエントリ', createdAt: '2026-01-02T00:00:00.000Z' });

    await expect(getDiaryEntryById('1')).resolves.toEqual(entry);
  });

  it('reads a plain (unencrypted) entry saved before encryption was introduced, for backward compatibility (正常系: 後方互換)', async () => {
    const entry: DiaryEntry = {
      id: '1',
      text: '暗号化対応前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await AsyncStorage.setItem(buildDiaryEntryKey('1'), JSON.stringify(entry));

    await expect(getDiaryEntryById('1')).resolves.toEqual(entry);
  });

  it('returns null when no entry exists for the given id (境界値)', async () => {
    await expect(getDiaryEntryById('does-not-exist')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the stored value fails to decrypt (異常系: 復号失敗)', async () => {
    await AsyncStorage.setItem(buildDiaryEntryKey('1'), 'encrypted:v1:not-a-real-payload');

    await expect(getDiaryEntryById('1')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the decrypted payload does not match the DiaryEntry shape (異常系: スキーマ不整合)', async () => {
    const key = await getOrCreateEncryptionKey();
    await AsyncStorage.setItem(
      buildDiaryEntryKey('1'),
      encryptText(JSON.stringify({ foo: 'bar' }), key),
    );

    await expect(getDiaryEntryById('1')).resolves.toBeNull();
  });

  it('does not read or write any other AsyncStorage key (他のエントリに影響を与えないこと)', async () => {
    await seedDiaryEntry({ id: '1', text: '対象', createdAt: '2026-01-01T00:00:00.000Z' });
    await seedDiaryEntry({ id: '2', text: '無関係', createdAt: '2026-01-02T00:00:00.000Z' });
    jest.clearAllMocks();

    await getDiaryEntryById('1');

    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(buildDiaryEntryKey('1'));
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

describe('getAllDiaryEntries', () => {
  // createdAt降順(新しい順)で返される仕様に合わせ、新しい順に並べて定義しておく
  const sampleEntries: DiaryEntry[] = [
    { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('returns an empty array when nothing has been saved yet (境界値: 未保存状態)', async () => {
    expect(await getAllDiaryEntries()).toEqual([]);
  });

  it('reads entries stored as individual per-entry keys, newest first (正常系)', async () => {
    for (const entry of sampleEntries) {
      await seedDiaryEntry(entry);
    }

    expect(await getAllDiaryEntries()).toEqual(sampleEntries);
  });

  it('sorts entries by createdAt descending regardless of the AsyncStorage key iteration order (並び順の保証)', async () => {
    // わざと古い順に書き込む
    await seedDiaryEntry(sampleEntries[1]);
    await seedDiaryEntry(sampleEntries[0]);

    expect(await getAllDiaryEntries()).toEqual(sampleEntries);
  });

  it('reads plain (unencrypted) per-entry values saved before encryption was introduced, for backward compatibility (正常系: 後方互換)', async () => {
    await AsyncStorage.setItem(buildDiaryEntryKey('1'), JSON.stringify(sampleEntries[1]));
    await AsyncStorage.setItem(buildDiaryEntryKey('2'), JSON.stringify(sampleEntries[0]));

    expect(await getAllDiaryEntries()).toEqual(sampleEntries);
  });

  it('skips a single corrupted entry without discarding the other valid entries (異常系: 1件だけ壊れている)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await seedDiaryEntry(sampleEntries[0]);
    await AsyncStorage.setItem(buildDiaryEntryKey('broken'), 'not-valid-json{{{');

    expect(await getAllDiaryEntries()).toEqual([sampleEntries[0]]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('skips an entry that fails decryption due to a wrong/mismatched key (異常系)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const otherKey = new Uint8Array(32).fill(9);
    const encryptedWithOtherKey = encryptText(JSON.stringify(sampleEntries[0]), otherKey);
    await AsyncStorage.setItem(buildDiaryEntryKey('1'), encryptedWithOtherKey);

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('skips an entry whose decrypted payload does not match the DiaryEntry shape (異常系: スキーマ不整合)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await getOrCreateEncryptionKey();
    await AsyncStorage.setItem(
      buildDiaryEntryKey('broken'),
      encryptText(JSON.stringify({ unexpected: 'shape' }), key),
    );
    await seedDiaryEntry(sampleEntries[0]);

    expect(await getAllDiaryEntries()).toEqual([sampleEntries[0]]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('1件');
    warnSpy.mockRestore();
  });

  it('does not log a warning when all entries are valid (正常系: ログが出ないこと)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const entry of sampleEntries) {
      await seedDiaryEntry(entry);
    }

    await getAllDiaryEntries();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns an empty array instead of throwing when AsyncStorage.getAllKeys itself rejects (異常系)', async () => {
    jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage read error'));

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  describe('レガシーキーからの移行(マイグレーション)', () => {
    it('migrates entries from the legacy single-key (encrypted) storage into per-entry keys (正常系)', async () => {
      const key = await getOrCreateEncryptionKey();
      // レガシー形式は「新しい順」を前提としていないため、あえて登録順(古い順)で保存する
      const legacyOrder = [sampleEntries[1], sampleEntries[0]];
      await AsyncStorage.setItem(
        DIARY_ENTRIES_STORAGE_KEY,
        encryptText(JSON.stringify(legacyOrder), key),
      );

      const result = await getAllDiaryEntries();

      // 移行後は個別キー方式のcreatedAt降順ルールに従って返る
      expect(result).toEqual(sampleEntries);
      expect(await readPersistedEntry('1')).toEqual(sampleEntries[1]);
      expect(await readPersistedEntry('2')).toEqual(sampleEntries[0]);
    });

    it('migrates entries from the legacy plain-JSON storage (pre-encryption) into per-entry keys (正常系: 後方互換)', async () => {
      const legacyOrder = [sampleEntries[1], sampleEntries[0]];
      await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, JSON.stringify(legacyOrder));

      expect(await getAllDiaryEntries()).toEqual(sampleEntries);
    });

    it('removes the legacy key once migration has completed (移行後にレガシーキーが削除されること)', async () => {
      const key = await getOrCreateEncryptionKey();
      await AsyncStorage.setItem(
        DIARY_ENTRIES_STORAGE_KEY,
        encryptText(JSON.stringify(sampleEntries), key),
      );

      await getAllDiaryEntries();

      expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();
    });

    it('is idempotent when triggered twice in a row (2回連続で呼び出されても壊れないこと)', async () => {
      const key = await getOrCreateEncryptionKey();
      await AsyncStorage.setItem(
        DIARY_ENTRIES_STORAGE_KEY,
        encryptText(JSON.stringify(sampleEntries), key),
      );

      const first = await getAllDiaryEntries();
      const second = await getAllDiaryEntries();

      expect(first).toEqual(sampleEntries);
      expect(second).toEqual(sampleEntries);
    });

    it('skips invalid elements found in the legacy array while migrating the valid ones, and logs a warning (異常系: 一部エントリのスキーマ不整合)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const key = await getOrCreateEncryptionKey();
      const mixed = [
        sampleEntries[0],
        { id: '2', text: '欠損データ' }, // createdAtが欠けている
        { id: 3, text: '型違い', createdAt: '2026-01-03T00:00:00.000Z' }, // idが数値
        null,
        sampleEntries[1],
      ];
      await AsyncStorage.setItem(
        DIARY_ENTRIES_STORAGE_KEY,
        encryptText(JSON.stringify(mixed), key),
      );

      const result = await getAllDiaryEntries();

      expect(result).toEqual(sampleEntries);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('2件');
      warnSpy.mockRestore();
    });

    it('does not migrate (and returns an empty array) when the legacy payload is corrupted/invalid JSON (異常系)', async () => {
      await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'not-valid-json{{{');

      await expect(getAllDiaryEntries()).resolves.toEqual([]);
    });

    it('does not run migration when there is no legacy data (レガシーキーが無い場合は何もしないこと)', async () => {
      await seedDiaryEntry(sampleEntries[0]);
      // seedDiaryEntry自体もAsyncStorage.setItem経由でmultiSetを呼ぶため、ここで一旦呼び出し履歴を
      // クリアしてから、getAllDiaryEntries内での呼び出しの有無だけを検証する
      jest.clearAllMocks();

      await getAllDiaryEntries();

      expect(AsyncStorage.multiSet).not.toHaveBeenCalled();
      // レガシーキーが元々存在しない以上、削除(removeItem)という不要な書き込みも
      // 発生しないはず(migrateLegacyEntriesIfNeededの早期returnを直接検証する)
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('createdAtが同一の場合の並び順(tie-break)', () => {
    beforeEach(async () => {
      await AsyncStorage.clear();
      secureStoreMock.__reset();
      jest.clearAllMocks();
    });

    // getAllDiaryEntriesの実装(diary-storage.ts)は、createdAtが完全に一致する場合に
    // idの降順で安定した順序を返す仕様になっている。この分岐は他のテストでは一度も
    // 通っていなかったため、明示的に検証する
    it('falls back to sorting by id descending when multiple entries share the exact same createdAt (境界値: 同時刻保存)', async () => {
      const sameCreatedAt = '2026-01-01T00:00:00.000Z';
      const entries: DiaryEntry[] = [
        { id: 'a', text: '1件目', createdAt: sameCreatedAt },
        { id: 'c', text: '3件目', createdAt: sameCreatedAt },
        { id: 'b', text: '2件目', createdAt: sameCreatedAt },
      ];
      // わざとid順ではない順番で書き込み、返り値の並び順が挿入順に依存していないことも確認する
      for (const entry of entries) {
        await seedDiaryEntry(entry);
      }

      const result = await getAllDiaryEntries();

      expect(result.map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
    });
  });
});
