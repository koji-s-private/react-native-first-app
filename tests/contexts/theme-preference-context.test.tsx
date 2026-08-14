import { act, renderHook } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ThemePreferenceProvider,
  THEME_PREFERENCE_STORAGE_KEY,
  useThemePreference,
} from '@/contexts/theme-preference-context';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `jest.setup.js`でも全体に適用済みだが、他のテストファイルと同様に明示しておく。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `hooks/use-color-scheme.ts`はreact-nativeの`useColorScheme`をそのままre-exportしているため、
// jest-expo(react-native)のオートモック(常に'light'を返すjest.fn)を直接上書きすることで
// OS側のカラースキームをライト/ダークに切り替えられる(tests/hooks/use-theme-color.test.tsと同じ手法)
const mockedUseColorScheme = useColorScheme as jest.Mock;

const wrapper = ({ children }: PropsWithChildren) => (
  <ThemePreferenceProvider>{children}</ThemePreferenceProvider>
);

describe('ThemePreferenceProvider / useThemePreference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('defaults to "system" preference before AsyncStorage has resolved (初期値は端末に合わせる)', () => {
    const { result } = renderHook(() => useThemePreference(), { wrapper });

    expect(result.current.preference).toBe('system');
  });

  it('persists the new preference to AsyncStorage and updates colorScheme when setPreference("dark") is called (正常系)', async () => {
    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      result.current.setPreference('dark');
    });

    expect(result.current.preference).toBe('dark');
    expect(result.current.colorScheme).toBe('dark');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_STORAGE_KEY, 'dark');
    expect(await AsyncStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe('dark');
  });

  it('persists the new preference to AsyncStorage and updates colorScheme when setPreference("light") is called (正常系)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      result.current.setPreference('light');
    });

    expect(result.current.preference).toBe('light');
    expect(result.current.colorScheme).toBe('light');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_STORAGE_KEY, 'light');
  });

  it('resolves colorScheme to "light" when preference is "system" and the OS reports light mode (正常系: OS追従・ライト)', () => {
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    expect(result.current.preference).toBe('system');
    expect(result.current.colorScheme).toBe('light');
  });

  it('resolves colorScheme to "dark" when preference is "system" and the OS reports dark mode (正常系: OS追従・ダーク)', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    expect(result.current.preference).toBe('system');
    expect(result.current.colorScheme).toBe('dark');
  });

  it('re-resolves colorScheme when the OS color scheme changes while preference stays "system" (正常系: OS設定変更への追従)', () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { result, rerender } = renderHook(() => useThemePreference(), { wrapper });

    expect(result.current.colorScheme).toBe('light');

    mockedUseColorScheme.mockReturnValue('dark');
    rerender({});

    expect(result.current.colorScheme).toBe('dark');
  });

  it('falls back to "light" when preference is "system" and the OS cannot determine the scheme (境界値: useColorSchemeがnull)', () => {
    mockedUseColorScheme.mockReturnValue(null);

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    expect(result.current.colorScheme).toBe('light');
  });

  it('loads a previously saved preference from AsyncStorage on mount (正常系: 起動時の復元)', async () => {
    await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'dark');
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.preference).toBe('dark');
    expect(result.current.colorScheme).toBe('dark');
  });

  it('ignores a stored value that is not a valid ThemePreference and stays on the "system" default (境界値: 不正な保存値)', async () => {
    // AsyncStorageは文字列しか保存できないため、想定外の値(例: 過去バージョンの壊れたデータ)が
    // 入っている可能性がある。その場合は無視して既定値のままにする
    await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'invalid-value');

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.preference).toBe('system');
  });

  it('falls back to "system" without crashing when AsyncStorage.getItem rejects (異常系: 読み込み失敗)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.preference).toBe('system');
  });

  it('keeps the newly selected preference reflected in the UI without crashing even when AsyncStorage.setItem rejects (異常系: 保存失敗)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));
    const { result } = renderHook(() => useThemePreference(), { wrapper });

    await act(async () => {
      result.current.setPreference('dark');
      // setItemの失敗(rejectしたPromise)がハンドリングされるのを待つ
      await Promise.resolve();
    });

    // 保存に失敗しても、目の前の選択状態(見た目)は既に更新済みのまま
    expect(result.current.preference).toBe('dark');
    expect(result.current.colorScheme).toBe('dark');
  });

  it('falls back to the OS color scheme (light) when used outside of ThemePreferenceProvider (異常系/境界値: Provider外での利用)', () => {
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemePreference());

    expect(result.current.preference).toBe('system');
    expect(result.current.colorScheme).toBe('light');
  });

  it('falls back to the OS color scheme (dark) when used outside of ThemePreferenceProvider (異常系/境界値: Provider外での利用)', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemePreference());

    expect(result.current.colorScheme).toBe('dark');
  });

  it('does not throw when setPreference is called outside of ThemePreferenceProvider (境界値: Provider外でのsetPreferenceはno-op)', () => {
    const { result } = renderHook(() => useThemePreference());

    expect(() => result.current.setPreference('dark')).not.toThrow();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
