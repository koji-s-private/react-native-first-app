import { renderHook } from '@testing-library/react-native';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
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
