import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, useColorScheme } from 'react-native';

import ParallaxScrollView from '@/components/parallax-scroll-view';

// jest-expo(react-native)のオートモックされた`useColorScheme`(常に'light'を返す)を
// 直接上書きすることでライト/ダークを切り替える(tests/app/index.test.tsxと同じ手法)
describe('ParallaxScrollView', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  afterEach(() => {
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('renders the header image and the children content', () => {
    render(
      <ParallaxScrollView
        headerImage={<Text>ヘッダー画像</Text>}
        headerBackgroundColor={{ light: '#fff', dark: '#000' }}
      >
        <Text>本文</Text>
      </ParallaxScrollView>,
    );

    expect(screen.getByText('ヘッダー画像')).toBeTruthy();
    expect(screen.getByText('本文')).toBeTruthy();
  });

  it('uses headerBackgroundColor.light for the header when the system theme is light', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(
      <ParallaxScrollView
        headerImage={<Text>ヘッダー画像</Text>}
        headerBackgroundColor={{ light: '#fff', dark: '#000' }}
      >
        <Text>本文</Text>
      </ParallaxScrollView>,
    );

    // ヘッダー画像を包むAnimated.View(host要素)は、テキスト要素から2階層上に位置する
    const headerView = screen.getByText('ヘッダー画像').parent?.parent;
    const flattened = StyleSheet.flatten(headerView?.props.style);
    expect(flattened.backgroundColor).toBe('#fff');
  });

  it('uses headerBackgroundColor.dark for the header when the system theme is dark', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(
      <ParallaxScrollView
        headerImage={<Text>ヘッダー画像</Text>}
        headerBackgroundColor={{ light: '#fff', dark: '#000' }}
      >
        <Text>本文</Text>
      </ParallaxScrollView>,
    );

    const headerView = screen.getByText('ヘッダー画像').parent?.parent;
    const flattened = StyleSheet.flatten(headerView?.props.style);
    expect(flattened.backgroundColor).toBe('#000');
  });
});
