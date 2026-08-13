import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, useColorScheme } from 'react-native';

import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';

// jest-expo(react-native)のオートモックされた`useColorScheme`(常に'light'を返す)を
// 直接上書きすることでライト/ダークを切り替える(tests/app/index.test.tsxと同じ手法)
describe('ThemedView', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  afterEach(() => {
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('renders its children', () => {
    render(
      <ThemedView>
        <Text>子要素</Text>
      </ThemedView>,
    );

    expect(screen.getByText('子要素')).toBeTruthy();
  });

  it('applies Colors.light.background as the default backgroundColor in light mode', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(<ThemedView testID="view" />);

    const view = screen.getByTestId('view');
    expect(StyleSheet.flatten(view.props.style).backgroundColor).toBe(Colors.light.background);
  });

  it('applies Colors.dark.background as the default backgroundColor in dark mode', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<ThemedView testID="view" />);

    const view = screen.getByTestId('view');
    expect(StyleSheet.flatten(view.props.style).backgroundColor).toBe(Colors.dark.background);
  });

  it('prefers the explicit lightColor prop over the theme default in light mode', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(<ThemedView testID="view" lightColor="#123456" />);

    const view = screen.getByTestId('view');
    expect(StyleSheet.flatten(view.props.style).backgroundColor).toBe('#123456');
  });

  it('prefers the explicit darkColor prop over the theme default in dark mode', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<ThemedView testID="view" darkColor="#abcdef" />);

    const view = screen.getByTestId('view');
    expect(StyleSheet.flatten(view.props.style).backgroundColor).toBe('#abcdef');
  });

  it('merges a caller-provided style on top of the backgroundColor style without discarding it', () => {
    render(<ThemedView testID="view" style={{ padding: 12 }} />);

    const flattened = StyleSheet.flatten(screen.getByTestId('view').props.style);
    expect(flattened.padding).toBe(12);
    expect(flattened.backgroundColor).toBe(Colors.light.background);
  });
});
