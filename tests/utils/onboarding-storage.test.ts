import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ONBOARDING_COMPLETED_STORAGE_KEY,
  hasCompletedOnboarding,
  markOnboardingCompleted,
} from '@/utils/onboarding-storage';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `tests/utils/diary-storage.test.ts`と同じ方式。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('hasCompletedOnboarding', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('returns false when nothing has been stored yet (正常系: 初回起動)', async () => {
    expect(await hasCompletedOnboarding()).toBe(false);
  });

  it('returns true once markOnboardingCompleted has stored the completed flag (正常系: 2回目以降の起動)', async () => {
    await markOnboardingCompleted();

    expect(await hasCompletedOnboarding()).toBe(true);
  });

  it('reads exactly the ONBOARDING_COMPLETED_STORAGE_KEY key (回帰確認)', async () => {
    await markOnboardingCompleted();

    await hasCompletedOnboarding();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_STORAGE_KEY);
  });

  it('returns false when the stored value is not exactly the string "true" (境界値: 不正な値)', async () => {
    // 将来の実装変更やストレージの破損によって想定外の値が入っていても、
    // 「完了扱いにしすぎない(false寄りに倒す)」ことを確認する
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'TRUE');
    expect(await hasCompletedOnboarding()).toBe(false);

    await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'false');
    expect(await hasCompletedOnboarding()).toBe(false);

    await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, '');
    expect(await hasCompletedOnboarding()).toBe(false);
  });

  it('returns false (not throwing) when the underlying AsyncStorage.getItem call fails (異常系: 読み込み失敗時は未表示扱い)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    await expect(hasCompletedOnboarding()).resolves.toBe(false);
  });

  it('exports the expected AsyncStorage key value used across the app (回帰確認)', () => {
    // `app/_layout.tsx`側もこの定数を参照するため、キーの実際の値が意図せず変わっていないことを確認する
    expect(ONBOARDING_COMPLETED_STORAGE_KEY).toBe('onboarding-completed');
  });
});

describe('markOnboardingCompleted', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('stores the string "true" under ONBOARDING_COMPLETED_STORAGE_KEY (正常系)', async () => {
    await markOnboardingCompleted();

    expect(await AsyncStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY)).toBe('true');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_STORAGE_KEY, 'true');
  });

  it('leaves the completed flag set to "true" when called twice in a row (冪等性の確認)', async () => {
    await markOnboardingCompleted();
    await markOnboardingCompleted();

    expect(await AsyncStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY)).toBe('true');
  });

  it('propagates the error when the underlying AsyncStorage.setItem call fails (異常系: 保存失敗時はエラーを呼び出し元に伝える)', async () => {
    // 呼び出し側(app/_layout.tsx)がこのエラーを握りつぶす設計のため、
    // ここでは「関数自体はエラーを隠さずそのまま伝える」ことを確認する
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));

    await expect(markOnboardingCompleted()).rejects.toThrow('storage write error');
  });
});
