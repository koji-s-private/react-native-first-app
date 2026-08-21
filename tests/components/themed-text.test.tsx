import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';

// jest-expo(react-native)のオートモックされた`useColorScheme`(常に'light'を返す)を
// 直接上書きすることでライト/ダークを切り替える(tests/app/index.test.tsxと同じ手法)
describe('ThemedText', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  afterEach(() => {
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('renders the given text content', () => {
    render(<ThemedText>こんにちは</ThemedText>);

    expect(screen.getByText('こんにちは')).toBeTruthy();
  });

  it('applies Colors.light.text as the default color in light mode', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(<ThemedText>本文</ThemedText>);

    const text = screen.getByText('本文');
    expect(StyleSheet.flatten(text.props.style).color).toBe(Colors.light.text);
  });

  it('applies Colors.dark.text as the default color in dark mode', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<ThemedText>本文</ThemedText>);

    const text = screen.getByText('本文');
    expect(StyleSheet.flatten(text.props.style).color).toBe(Colors.dark.text);
  });

  it('prefers the explicit lightColor prop over the theme default in light mode', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(<ThemedText lightColor="#123456">本文</ThemedText>);

    const text = screen.getByText('本文');
    expect(StyleSheet.flatten(text.props.style).color).toBe('#123456');
  });

  it('prefers the explicit darkColor prop over the theme default in dark mode', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<ThemedText darkColor="#abcdef">本文</ThemedText>);

    const text = screen.getByText('本文');
    expect(StyleSheet.flatten(text.props.style).color).toBe('#abcdef');
  });

  it.each([
    ['default', { fontSize: 16, lineHeight: 24 }],
    ['defaultSemiBold', { fontSize: 16, lineHeight: 24, fontWeight: '600' }],
    ['title', { fontSize: 32, fontWeight: 'bold', lineHeight: 32 }],
    ['subtitle', { fontSize: 20, fontWeight: 'bold' }],
    ['link', { lineHeight: 30, fontSize: 16, color: Colors.light.link }],
  ] as const)('applies the expected style for type="%s"', (type, expectedStyle) => {
    render(<ThemedText type={type}>本文</ThemedText>);

    const flattened = StyleSheet.flatten(screen.getByText('本文').props.style);
    expect(flattened).toMatchObject(expectedStyle);
  });

  it('applies Colors.dark.link (not the light tint) as the link color in dark mode (Issue #153)', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<ThemedText type="link">リンク</ThemedText>);

    const flattened = StyleSheet.flatten(screen.getByText('リンク').props.style);
    expect(flattened.color).toBe(Colors.dark.link);
    expect(flattened.color).not.toBe(Colors.light.link);
  });

  it('merges a caller-provided style on top of the type-based style without discarding it', () => {
    render(<ThemedText style={{ marginTop: 8 }}>本文</ThemedText>);

    const flattened = StyleSheet.flatten(screen.getByText('本文').props.style);
    expect(flattened.marginTop).toBe(8);
    // デフォルトtypeのスタイルも維持されたままであること
    expect(flattened.fontSize).toBe(16);
  });
});
