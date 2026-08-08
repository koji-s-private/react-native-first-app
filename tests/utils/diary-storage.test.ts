import AsyncStorage from '@react-native-async-storage/async-storage';

import { DIARY_ENTRIES_STORAGE_KEY, clearAllDiaryEntries } from '@/utils/diary-storage';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `tests/app/index.test.tsx`と同じ方式。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('clearAllDiaryEntries', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
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
