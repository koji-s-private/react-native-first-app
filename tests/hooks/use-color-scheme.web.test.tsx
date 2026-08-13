import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text, useColorScheme as useRNColorScheme } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme.web';

// テスト対象のフックの戻り値を画面に描画して確認するための小さなプローブコンポーネント
function ColorSchemeProbe() {
  const colorScheme = useColorScheme();
  return <Text testID="color-scheme">{String(colorScheme)}</Text>;
}

describe('useColorScheme (web)', () => {
  const mockedUseRNColorScheme = useRNColorScheme as jest.Mock;

  afterEach(() => {
    mockedUseRNColorScheme.mockReturnValue('light');
  });

  it("returns 'light' before the hydration effect has run, even if the system reports dark", () => {
    // Web版はSSR(静的レンダリング)との不整合を避けるため、マウント直後(useEffectが
    // 走る前)は常に'light'を返す実装になっている。この「hydration前」の状態を再現するため、
    // `useEffect`を一時的にno-op化し、hydration完了フラグが立たない状況をシミュレートする
    const useEffectSpy = jest.spyOn(React, 'useEffect').mockImplementation(() => {});
    mockedUseRNColorScheme.mockReturnValue('dark');

    render(<ColorSchemeProbe />);

    expect(screen.getByTestId('color-scheme')).toHaveTextContent('light');

    useEffectSpy.mockRestore();
  });

  it('returns the real system color scheme once mounted (hydration effect has run)', () => {
    mockedUseRNColorScheme.mockReturnValue('dark');

    render(<ColorSchemeProbe />);

    expect(screen.getByTestId('color-scheme')).toHaveTextContent('dark');
  });

  it('returns light when the system scheme is light and hydration has completed', () => {
    mockedUseRNColorScheme.mockReturnValue('light');

    render(<ColorSchemeProbe />);

    expect(screen.getByTestId('color-scheme')).toHaveTextContent('light');
  });

  it('returns null as-is once hydrated when react-native reports no determinable scheme', () => {
    mockedUseRNColorScheme.mockReturnValue(null);

    render(<ColorSchemeProbe />);

    expect(screen.getByTestId('color-scheme')).toHaveTextContent('null');
  });
});
