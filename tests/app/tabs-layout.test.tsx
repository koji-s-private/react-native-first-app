import { render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { useColorScheme } from 'react-native';

import TabLayout from '@/app/(tabs)/_layout';
import { Colors } from '@/constants/theme';
import { ThemePreferenceProvider, useThemePreference } from '@/contexts/theme-preference-context';

// `app/(tabs)/_layout.tsx`が使う`Tabs`/`Tabs.Screen`は、実機では`ExpoRoot`が構築する
// ルーター/ナビゲーションコンテキストを前提にしており、この画面を単体でレンダリングする
// このテストではそのコンテキストが存在しない。`tests/app/_layout.test.tsx`(ルートレイアウト)
// と同じ方針で、実際のタブナビゲーションを構築しない薄いモックに差し替える。
// 各`Tabs.Screen`に渡された`name`/`options.title`を検証できるよう、テキストとして
// 可視化するモックにしている(`tabBarIcon`はここでは呼び出さない=検証対象外)。
// `screenOptions`(`tabBarActiveTintColor`を含む)はテキストとして可視化できないため、
// テストから参照できるよう外側の変数に記録しておく(Issue #91のレビュー指摘対応)。
// `jest.mock`のファクトリからは`mock`で始まる変数名しか参照できない制約があるため、
// この名前にしている。
let mockLastScreenOptions: { tabBarActiveTintColor?: string } | undefined;

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

  function Tabs({
    children,
    screenOptions,
  }: PropsWithChildren<{ screenOptions?: { tabBarActiveTintColor?: string } }>) {
    mockLastScreenOptions = screenOptions;
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

describe('TabLayout のタブ構成(Issue #38: Exploreタブ削除)', () => {
  it('does not render an "explore" tab screen anymore', () => {
    render(<TabLayout />);

    expect(screen.queryByTestId('tab-screen-explore')).toBeNull();
  });

  it('renders exactly two tab screens ("index" and "settings")', () => {
    render(<TabLayout />);

    expect(screen.getAllByTestId(/^tab-screen-/)).toHaveLength(2);
    expect(screen.getByTestId('tab-screen-index')).toBeTruthy();
    expect(screen.getByTestId('tab-screen-settings')).toBeTruthy();
  });
});

// Issue #91のレビュー指摘: タブバーの選択色(`tabBarActiveTintColor`)が、OSの生の値
// (`useColorScheme`)ではなく、アプリ内で選択したテーマ設定(`useThemePreference`)を
// 正しく反映していることを確認する。ここを見落とすと、OSと逆のテーマをアプリ内で選択した際に
// 画面本体とタブバーの配色が食い違い、選択中タブの色がほぼ見えなくなる不具合が再発する。
describe('TabLayout のタブバー配色(Issue #91: アプリ内テーマ選択の反映漏れの回帰テスト)', () => {
  const mockedUseColorScheme = useColorScheme as jest.Mock;

  beforeEach(() => {
    mockLastScreenOptions = undefined;
    mockedUseColorScheme.mockReturnValue('light');
  });

  afterEach(() => {
    mockedUseColorScheme.mockReturnValue('light');
  });

  it('uses Colors.light.tint when the OS scheme is light and no in-app preference is set', () => {
    mockedUseColorScheme.mockReturnValue('light');

    render(<TabLayout />);

    expect(mockLastScreenOptions?.tabBarActiveTintColor).toBe(Colors.light.tint);
  });

  it('uses Colors.dark.tint when the OS scheme is dark and no in-app preference is set', () => {
    mockedUseColorScheme.mockReturnValue('dark');

    render(<TabLayout />);

    expect(mockLastScreenOptions?.tabBarActiveTintColor).toBe(Colors.dark.tint);
  });

  it('uses Colors.light.tint when "light" is explicitly selected in-app even though the OS scheme is dark (回帰テスト: OSと逆のテーマを選択したケース)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');

    function TabLayoutWithLightPreference() {
      const { setPreference } = useThemePreference();
      React.useEffect(() => {
        setPreference('light');
      }, [setPreference]);
      return <TabLayout />;
    }

    render(
      <ThemePreferenceProvider>
        <TabLayoutWithLightPreference />
      </ThemePreferenceProvider>,
    );

    await waitFor(() =>
      expect(mockLastScreenOptions?.tabBarActiveTintColor).toBe(Colors.light.tint),
    );
  });

  it('uses Colors.dark.tint when "dark" is explicitly selected in-app even though the OS scheme is light (回帰テスト: OSと逆のテーマを選択したケース)', async () => {
    mockedUseColorScheme.mockReturnValue('light');

    function TabLayoutWithDarkPreference() {
      const { setPreference } = useThemePreference();
      React.useEffect(() => {
        setPreference('dark');
      }, [setPreference]);
      return <TabLayout />;
    }

    render(
      <ThemePreferenceProvider>
        <TabLayoutWithDarkPreference />
      </ThemePreferenceProvider>,
    );

    await waitFor(() =>
      expect(mockLastScreenOptions?.tabBarActiveTintColor).toBe(Colors.dark.tint),
    );
  });
});
