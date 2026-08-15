import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import {
  DIARY_ENTRIES_STORAGE_KEY,
  clearAllDiaryEntries,
  getAllDiaryEntries,
  type DiaryEntry,
} from '@/utils/diary-storage';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `tests/app/index.test.tsx`と同じ方式。
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

describe('clearAllDiaryEntries', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('removes the diary entries stored under DIARY_ENTRIES_STORAGE_KEY from AsyncStorage (正常系)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');

    await clearAllDiaryEntries();

    // 削除後は該当キーの値がAsyncStorageから実際に消えている(nullが返る)ことを検証する
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();
  });

  it('calls AsyncStorage.removeItem with exactly the diary entries key (他のキーに影響を与えないことの確認)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');
    // 日記データ以外のキー(例: 他の設定値)が誤って削除されないことも確認する
    await AsyncStorage.setItem('other-unrelated-key', 'should survive');

    await clearAllDiaryEntries();

    expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DIARY_ENTRIES_STORAGE_KEY);
    expect(await AsyncStorage.getItem('other-unrelated-key')).toBe('should survive');
  });

  it('does not throw when there is no diary data to delete yet (境界値: 未保存状態での削除)', async () => {
    // 一度も日記を保存していない(=キーが存在しない)状態で呼び出しても例外にならないこと
    await expect(clearAllDiaryEntries()).resolves.toBeUndefined();
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();
  });

  it('leaves AsyncStorage empty for the key when called twice in a row (冪等性の確認)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');

    await clearAllDiaryEntries();
    await clearAllDiaryEntries();

    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();
  });

  it('propagates the error when the underlying AsyncStorage.removeItem call fails (異常系)', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('storage error'));

    await expect(clearAllDiaryEntries()).rejects.toThrow('storage error');
  });

  it('exports the expected AsyncStorage key value used across the app (回帰確認)', () => {
    // app/(tabs)/index.tsx側もこの定数を参照するリファクタリングが行われているため、
    // キーの実際の値そのものが意図せず変わっていないことを確認する
    expect(DIARY_ENTRIES_STORAGE_KEY).toBe('diary-entries');
  });
});

describe('getAllDiaryEntries', () => {
  const sampleEntries: DiaryEntry[] = [
    { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
  ];

  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  it('returns an empty array when nothing has been saved yet (境界値: 未保存状態)', async () => {
    expect(await getAllDiaryEntries()).toEqual([]);
  });

  it('returns an empty array when the stored value is an empty string (境界値)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, '');
    expect(await getAllDiaryEntries()).toEqual([]);
  });

  it('decrypts and returns entries stored in the current encrypted format (正常系)', async () => {
    const key = await getOrCreateEncryptionKey();
    const encrypted = encryptText(JSON.stringify(sampleEntries), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    expect(await getAllDiaryEntries()).toEqual(sampleEntries);
  });

  it('returns an empty array when there are 0 diary entries stored in encrypted form (境界値: 0件)', async () => {
    const key = await getOrCreateEncryptionKey();
    const encrypted = encryptText(JSON.stringify([]), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    expect(await getAllDiaryEntries()).toEqual([]);
  });

  it('reads plain (unencrypted) JSON saved before encryption was introduced, for backward compatibility (正常系: 後方互換)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, JSON.stringify(sampleEntries));

    expect(await getAllDiaryEntries()).toEqual(sampleEntries);
  });

  it('returns an empty array instead of throwing when the stored value is corrupted/invalid JSON (異常系)', async () => {
    // 暗号化プレフィックスを持たない、壊れたJSON文字列
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'not-valid-json{{{');

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when decryption fails due to a wrong/mismatched key (異常系)', async () => {
    // 別の鍵で暗号化されたペイロード(=保存されている鍵と一致しない)を保存する
    const otherKey = new Uint8Array(32).fill(9);
    const encryptedWithOtherKey = encryptText(JSON.stringify(sampleEntries), otherKey);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encryptedWithOtherKey);

    // getOrCreateEncryptionKeyは別の(実際にストレージへ保存される)鍵を新規生成するため、
    // 復号時にGCMの認証タグ検証に失敗し、例外を投げずに空配列を返すことを確認する
    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when the encrypted payload is truncated/tampered (異常系)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:AAAA');

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when AsyncStorage.getItem itself rejects (異常系)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when the decrypted payload is not an array at all (異常系: スキーマ不整合)', async () => {
    const key = await getOrCreateEncryptionKey();
    // 日記データではない別のJSON構造(オブジェクト)を暗号化して保存する
    const encrypted = encryptText(JSON.stringify({ unexpected: 'shape' }), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    // JSON.parse自体は成功するが、配列でないため型ガードにより空配列が返る
    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });

  it('filters out elements that do not match the DiaryEntry shape while keeping valid ones (異常系: 一部エントリのスキーマ不整合)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await getOrCreateEncryptionKey();
    const mixed = [
      sampleEntries[0],
      { id: '2', text: '欠損データ' }, // createdAtが欠けている
      { id: 3, text: '型違い', createdAt: '2026-01-03T00:00:00.000Z' }, // idが数値
      null,
      sampleEntries[1],
    ];
    const encrypted = encryptText(JSON.stringify(mixed), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    // 不正な要素のみがスキップされ、有効なエントリだけが返る
    await expect(getAllDiaryEntries()).resolves.toEqual(sampleEntries);
    warnSpy.mockRestore();
  });

  it('logs a warning with the skipped count when some entries are filtered out (不正エントリのスキップをログで検知できること)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await getOrCreateEncryptionKey();
    const mixed = [sampleEntries[0], { id: '2', text: '欠損データ' }, null, sampleEntries[1]];
    const encrypted = encryptText(JSON.stringify(mixed), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    await getAllDiaryEntries();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('2件');
    warnSpy.mockRestore();
  });

  it('does not log a warning when all entries are valid (正常系: ログが出ないこと)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await getOrCreateEncryptionKey();
    const encrypted = encryptText(JSON.stringify(sampleEntries), key);
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, encrypted);

    await getAllDiaryEntries();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns an empty array when the stored plain JSON is not an array (異常系: 後方互換データのスキーマ不整合)', async () => {
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, JSON.stringify({ unexpected: 'shape' }));

    await expect(getAllDiaryEntries()).resolves.toEqual([]);
  });
});
