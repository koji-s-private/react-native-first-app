import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID,
  TabScreenContainer,
} from '@/components/tab-screen-container';

// 実機では`expo-router`の`ExpoRoot`が自動的に`SafeAreaProvider`で全体をラップするが、
// このテストでは`TabScreenContainer`を単体でレンダリングするケースがあるため、
// `useSafeAreaInsets`が`SafeAreaProvider`配下でないと投げるエラーを避けるべく、
// ライブラリ公式のjestモック(常にゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

describe('TabScreenContainer (Issue #125: タブ画面共通のセーフエリア対応コンテナ)', () => {
  it('renders its children', () => {
    render(
      <TabScreenContainer>
        <Text>子要素</Text>
      </TabScreenContainer>,
    );

    expect(screen.getByText('子要素')).toBeTruthy();
  });

  it('does not add extra top padding when the safe area top inset is zero (e.g. Android without a notch)', () => {
    render(
      <TabScreenContainer>
        <Text>子要素</Text>
      </TabScreenContainer>,
    );

    const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
    expect(StyleSheet.flatten(safeAreaWrapper.props.style).paddingTop).toBe(0);
  });

  it('adds the safe area top inset as paddingTop on the outer wrapper so content does not overlap the status bar/notch/Dynamic Island', () => {
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, left: 0, right: 0, bottom: 34 },
        }}
      >
        <TabScreenContainer>
          <Text>子要素</Text>
        </TabScreenContainer>
      </SafeAreaProvider>,
    );

    const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
    expect(StyleSheet.flatten(safeAreaWrapper.props.style).paddingTop).toBe(59);
  });

  it('applies the caller-provided style (e.g. flex/padding) to the inner content view without being overridden by the safe area paddingTop', () => {
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, left: 0, right: 0, bottom: 34 },
        }}
      >
        <TabScreenContainer style={{ flex: 1, padding: 16 }} testID="content">
          <Text>子要素</Text>
        </TabScreenContainer>
      </SafeAreaProvider>,
    );

    const content = screen.getByTestId('content');
    const flattenedStyle = StyleSheet.flatten(content.props.style);

    // 呼び出し側が指定したstyle(padding: 16等)は、セーフエリアのpaddingTopと
    // 別階層に分かれているためそのまま維持される(上書きされない)
    expect(flattenedStyle.flex).toBe(1);
    expect(flattenedStyle.padding).toBe(16);
  });
});
