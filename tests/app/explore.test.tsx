import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

import appConfig from '@/app.json';
import ExploreScreen from '@/app/(tabs)/explore';

// `ExploreScreen` は `ParallaxScrollView` でラップされており、`react-native-reanimated` の
// `useAnimatedRef`/`useScrollOffset` を使ってヘッダーのスクロール連動パララックスアニメーションを
// 制御している。`useScrollOffset` はこのanimated refを監視し、マウント後にスクロール対象コンポーネントが
// ネイティブのview tagを報告することを期待する。`react-test-renderer` は実際のネイティブview解決を
// 行わないため、view tagが取得できず、`useScrollOffset` が毎回のレンダリングで
// "[Reanimated] animatedRef is not initialized in useScrollOffset ..." という警告を出力してしまう。
// このテストではスクロール連動アニメーション自体ではなく画面の静的コンテンツのみを検証しているため、
// (決して解決されない)animated refを監視する代わりに `useScrollOffset` が単純なshared valueを
// 返すようにモックし、モジュールの他の部分に手を加えずに警告を回避している。
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');

  return {
    ...actual,
    // `ParallaxScrollView` が使用している `import Animated from 'react-native-reanimated'`
    // (デフォルトインポート)を正しく解決するには `__esModule` の付与が必要。これが無いと
    // Babelのinterop解決によって `Animated` がこのモックオブジェクト全体に解決されてしまう。
    __esModule: true,
    useScrollOffset: () => actual.useSharedValue(0),
  };
});

// `ExternalLink` (used inside some of the Collapsible sections on this screen) wraps
// `expo-router`'s `Link`, which requires a navigation/router context that isn't set up
// when rendering the screen in isolation. We stub it out the same way
// `tests/app/index.test.tsx` does, so the screen's own content can be asserted without
// pulling in the whole router.
jest.mock('expo-router', () => {
  const PassThrough = ({ children }: PropsWithChildren) => children;

  const Link = PassThrough as unknown as typeof PassThrough & {
    Trigger: typeof PassThrough;
    Preview: () => null;
    Menu: typeof PassThrough;
    MenuAction: () => null;
  };
  function LinkPreview() {
    return null;
  }

  function LinkMenuAction() {
    return null;
  }

  Link.Trigger = PassThrough;
  Link.Preview = LinkPreview;
  Link.Menu = PassThrough;
  Link.MenuAction = LinkMenuAction;

  return { Link };
});

// In the real app, Expo's tooling populates `Constants.expoConfig` from `app.json` at
// build/runtime. The `jest-expo` test environment has no bundler-injected manifest though,
// so `Constants.expoConfig` is `undefined` by default and there is nothing for the screen
// to render. We mock `expo-constants` here so `expoConfig` is sourced directly from
// `app.json` (the same file the test asserts against below), faithfully reproducing the
// real relationship between `app.json` and `Constants.expoConfig` without hardcoding a
// version string anywhere in this test file.
jest.mock('expo-constants', () => {
  const config = require('../../app.json');

  return {
    __esModule: true,
    default: {
      expoConfig: { version: config.expo.version },
    },
  };
});

describe('ExploreScreen', () => {
  it('renders the Explore title', () => {
    render(<ExploreScreen />);

    expect(screen.getByText('Explore')).toBeTruthy();
  });

  it('renders an "App version" section', () => {
    render(<ExploreScreen />);

    expect(screen.getByText('App version')).toBeTruthy();
  });

  it("reveals the app.json expo.version value when the 'App version' section is expanded", () => {
    render(<ExploreScreen />);

    // The section's body text isn't rendered until the Collapsible is toggled open.
    fireEvent.press(screen.getByText('App version'));

    // Assert against the value read from app.json rather than a hardcoded string, so this
    // test keeps passing (and failing appropriately) as the app is versioned over time.
    const expectedVersion = appConfig.expo.version;
    expect(typeof expectedVersion).toBe('string');
    expect(expectedVersion.length).toBeGreaterThan(0);

    expect(screen.getByText(expectedVersion)).toBeTruthy();
    expect(screen.getByText('expo.version')).toBeTruthy();
    expect(screen.getByText('app.json')).toBeTruthy();
  });
});
