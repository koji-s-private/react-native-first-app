import { act, renderHook } from '@testing-library/react-native';
import { createElement, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { Colors } from '@/constants/theme';
import {
  THEME_PREFERENCE_STORAGE_KEY,
  ThemePreferenceProvider,
  useThemePreference,
} from '@/contexts/theme-preference-context';
import { useThemeColor } from '@/hooks/use-theme-color';

// `hooks/use-color-scheme.ts`はreact-nativeの`useColorScheme`をそのままre-exportしているため、
// jest-expo(react-native)のオートモック(常に'light'を返すjest.fn)を直接上書きすることで
// ライト/ダークを切り替えられる(tests/app/index.test.tsxの「テーマに応じたエラー色」と同じ手法)
describe('useThemeColor', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  afterEach(() => {
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('sanity check: Colors.light and Colors.dark have different values for the colors used below', () => {
    // ライト/ダークで同じ値だと、以下のテストが誤って"たまたま"パスしてしまうことを防ぐための前提確認
    expect(Colors.light.text).not.toBe(Colors.dark.text);
    expect(Colors.light.background).not.toBe(Colors.dark.background);
  });

  it('returns Colors.light[colorName] when the system theme is light and no explicit color props are given', () => {
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemeColor({}, 'text'));

    expect(result.current).toBe(Colors.light.text);
  });

  it('returns Colors.dark[colorName] when the system theme is dark and no explicit color props are given', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemeColor({}, 'text'));

    expect(result.current).toBe(Colors.dark.text);
  });

  it('falls back to the light theme when useColorScheme returns null (e.g. platform cannot determine the scheme yet)', () => {
    mockedUseColorScheme.mockReturnValue(null);

    const { result } = renderHook(() => useThemeColor({}, 'background'));

    expect(result.current).toBe(Colors.light.background);
  });

  it('falls back to the light theme when useColorScheme returns undefined', () => {
    mockedUseColorScheme.mockReturnValue(undefined);

    const { result } = renderHook(() => useThemeColor({}, 'background'));

    expect(result.current).toBe(Colors.light.background);
  });

  it('prefers the explicit `light` color prop over Colors.light when in light mode', () => {
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemeColor({ light: '#123456' }, 'text'));

    expect(result.current).toBe('#123456');
  });

  it('prefers the explicit `dark` color prop over Colors.dark when in dark mode', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemeColor({ dark: '#abcdef' }, 'text'));

    expect(result.current).toBe('#abcdef');
  });

  it('ignores the `dark` color prop when in light mode and falls back to Colors.light', () => {
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemeColor({ dark: '#abcdef' }, 'text'));

    expect(result.current).toBe(Colors.light.text);
  });

  it('ignores the `light` color prop when in dark mode and falls back to Colors.dark', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemeColor({ light: '#123456' }, 'text'));

    expect(result.current).toBe(Colors.dark.text);
  });
});

// Issue #91: OSの設定だけでなく、アプリ内(設定画面)で選択されたテーマ設定
// (`ThemePreferenceProvider`/`useThemePreference`)経由でも正しく色が解決されることを確認する
describe('useThemeColor with ThemePreferenceProvider (Issue #91: アプリ内テーマ選択との統合)', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  beforeEach(async () => {
    // 前のテストでAsyncStorageへ書き込んだ選択内容が、次のテストのマウント時の
    // 読み込み(useEffect)に影響しないようクリアしておく
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedUseColorScheme.mockReturnValue('light');
  });

  // `setPreference`(コンテキスト操作)と`useThemeColor`(色の解決結果)の両方を
  // 同じProvider配下から取得するための結合フック
  function useThemeColorWithPreferenceControl() {
    const { setPreference } = useThemePreference();
    const color = useThemeColor({}, 'text');
    return { setPreference, color };
  }

  // このファイルは`.ts`拡張子(JSX非対応)のため、JSX構文の代わりに`createElement`を使う
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(ThemePreferenceProvider, null, children);

  // マウント直後に走るAsyncStorageからの読み込み(起動時復元)が完了してから
  // 選択操作を行いたいので、保留中のPromiseを明示的にフラッシュする
  async function flushPendingPromises() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('follows the OS color scheme when the in-app preference is left at the default "system" (正常系: 既定値は端末に合わせる)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');

    const { result } = renderHook(() => useThemeColor({}, 'text'), { wrapper });
    await flushPendingPromises();

    expect(result.current).toBe(Colors.dark.text);
  });

  it('resolves to Colors.light even when the OS scheme is dark, once "light" is explicitly selected (正常系: アプリ内選択がOS設定より優先される)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { result } = renderHook(() => useThemeColorWithPreferenceControl(), { wrapper });
    await flushPendingPromises();
    expect(result.current.color).toBe(Colors.dark.text);

    await act(async () => {
      result.current.setPreference('light');
    });

    expect(result.current.color).toBe(Colors.light.text);
  });

  it('resolves to Colors.dark even when the OS scheme is light, once "dark" is explicitly selected (正常系: アプリ内選択がOS設定より優先される)', async () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { result } = renderHook(() => useThemeColorWithPreferenceControl(), { wrapper });
    await flushPendingPromises();
    expect(result.current.color).toBe(Colors.light.text);

    await act(async () => {
      result.current.setPreference('dark');
    });

    expect(result.current.color).toBe(Colors.dark.text);
  });

  it('goes back to following the OS scheme once "system" is re-selected after choosing an explicit theme (正常系: 端末に合わせるへの再切り替え)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { result } = renderHook(() => useThemeColorWithPreferenceControl(), { wrapper });
    await flushPendingPromises();

    await act(async () => {
      result.current.setPreference('light');
    });
    expect(result.current.color).toBe(Colors.light.text);

    await act(async () => {
      result.current.setPreference('system');
    });
    expect(result.current.color).toBe(Colors.dark.text);
  });

  it('reflects a theme preference that was already saved in AsyncStorage before mount (正常系: 保存済み設定の反映)', async () => {
    await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'dark');
    mockedUseColorScheme.mockReturnValue('light');

    const { result } = renderHook(() => useThemeColor({}, 'text'), { wrapper });
    await flushPendingPromises();

    expect(result.current).toBe(Colors.dark.text);
  });
});
