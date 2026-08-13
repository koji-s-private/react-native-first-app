import { render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

import TabLayout from '@/app/(tabs)/_layout';

// `app/(tabs)/_layout.tsx`が使う`Tabs`/`Tabs.Screen`は、実機では`ExpoRoot`が構築する
// ルーター/ナビゲーションコンテキストを前提にしており、この画面を単体でレンダリングする
// このテストではそのコンテキストが存在しない。`tests/app/_layout.test.tsx`(ルートレイアウト)
// と同じ方針で、実際のタブナビゲーションを構築しない薄いモックに差し替える。
// 各`Tabs.Screen`に渡された`name`/`options.title`を検証できるよう、テキストとして
// 可視化するモックにしている(`tabBarIcon`はここでは呼び出さない=検証対象外)。
jest.mock('expo-router', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactForMock = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');

  function TabsScreen({ name, options }: { name: string; options?: { title?: string } }) {
    return ReactForMock.createElement(Text, { testID: `tab-screen-${name}` }, options?.title ?? '');
  }

  function Tabs({ children }: PropsWithChildren) {
    return children ?? null;
  }
  Tabs.Screen = TabsScreen;

  return { Tabs };
});

describe('TabLayout のタブタイトル(Issue #10)', () => {
  it('shows "日記"(日本語)as the title for the home ("index") tab, not the old "Home"', () => {
    render(<TabLayout />);

    expect(screen.getByTestId('tab-screen-index')).toHaveTextContent('日記');
    expect(screen.queryByText('Home')).toBeNull();
  });

  it('keeps the "設定" title for the settings tab unchanged (regression)', () => {
    render(<TabLayout />);

    expect(screen.getByTestId('tab-screen-settings')).toHaveTextContent('設定');
  });
});
