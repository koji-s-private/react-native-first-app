import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

import RootLayout from '@/app/_layout';
import { ONBOARDING_SLIDES } from '@/constants/onboarding-slides';
import { ONBOARDING_COMPLETED_STORAGE_KEY } from '@/utils/onboarding-storage';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `tests/app/index.test.tsx`と同じ方式。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `app/_layout.tsx`が使う`Stack`/`Stack.Screen`は、実機では`ExpoRoot`が構築する
// ルーター/ナビゲーションコンテキストを前提にしており(`useLinkPreviewContext must be used
// within a LinkPreviewContextProvider`のようなエラーになる)、この画面を単体でレンダリング
// するこのテストではそのコンテキストが存在しない。他のテスト(`tests/app/settings.test.tsx`等)と
// 同じ方針で、実際の画面遷移を検証しない薄いパススルーのモックに差し替える。
jest.mock('expo-router', () => {
  const PassThrough = ({ children }: PropsWithChildren) => children ?? null;
  function StackScreen() {
    return null;
  }
  const Stack = PassThrough as unknown as typeof PassThrough & { Screen: typeof StackScreen };
  Stack.Screen = StackScreen;
  return { Stack };
});

const SKIP_BUTTON_TEXT = 'スキップ';
const START_BUTTON_TEXT = 'はじめる';

describe('RootLayout のオンボーディング表示制御(Issue #104)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('shows the onboarding overlay on first launch, when nothing has been stored yet (受け入れ条件: 初回起動時に表示される)', async () => {
    render(<RootLayout />);

    expect(await screen.findByText(ONBOARDING_SLIDES[0].title)).toBeTruthy();
    expect(screen.getByText(SKIP_BUTTON_TEXT)).toBeTruthy();
  });

  it('does not show the onboarding overlay before the async AsyncStorage check resolves (正常系: 判定完了までは表示しない)', async () => {
    render(<RootLayout />);

    // `hasCompletedOnboarding`の解決を待つ前の同期的な最初のレンダリングでは、
    // 誤って一瞬表示されてしまわないよう`showOnboarding`の初期値がfalseになっている
    expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull();

    // 次のテストへ`act`警告が漏れないよう、この後起こる非同期の状態更新が
    // 完了するのを待ってからテストを終える
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  });

  it('does not show the onboarding overlay on a later launch, once it has already been completed (受け入れ条件: 一度閉じると次回以降表示されない)', async () => {
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'true');

    render(<RootLayout />);

    // 完了フラグが立っている場合、判定が終わってもオンボーディングの内容は表示されないままである
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull();
    expect(screen.queryByText(SKIP_BUTTON_TEXT)).toBeNull();
  });

  it('hides the overlay and persists the completed flag when "スキップ" is pressed (受け入れ条件: スキップして閉じると記録される)', async () => {
    render(<RootLayout />);

    fireEvent.press(await screen.findByText(SKIP_BUTTON_TEXT));

    await waitFor(() => expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull());
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_STORAGE_KEY, 'true'),
    );
  });

  it('hides the overlay and persists the completed flag when "はじめる" is pressed on the last slide (受け入れ条件: 最後まで見て閉じると記録される)', async () => {
    render(<RootLayout />);
    await screen.findByText(ONBOARDING_SLIDES[0].title);

    for (let i = 0; i < ONBOARDING_SLIDES.length - 1; i += 1) {
      fireEvent.press(screen.getByText('次へ'));
    }
    fireEvent.press(screen.getByText(START_BUTTON_TEXT));

    await waitFor(() => expect(screen.queryByText(START_BUTTON_TEXT)).toBeNull());
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_STORAGE_KEY, 'true'),
    );
  });

  it('does not show the onboarding overlay again after finishing it once and restarting the app (受け入れ条件: 一度閉じると次回以降表示されない・再起動を模した検証)', async () => {
    const { unmount } = render(<RootLayout />);
    fireEvent.press(await screen.findByText(SKIP_BUTTON_TEXT));
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_STORAGE_KEY, 'true'),
    );

    // アプリの再起動を模して画面をアンマウントし、新しいインスタンスとして再度マウントする
    unmount();
    render(<RootLayout />);

    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull();
  });

  it('still shows the onboarding overlay when AsyncStorage.getItem fails (異常系: 読み込み失敗時は未表示扱いのため表示される)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    render(<RootLayout />);

    expect(await screen.findByText(ONBOARDING_SLIDES[0].title)).toBeTruthy();
  });

  it('still hides the overlay (does not crash) even when persisting the completed flag fails (異常系: 保存失敗はエラーを握りつぶし画面遷移は妨げない)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));

    render(<RootLayout />);
    fireEvent.press(await screen.findByText(SKIP_BUTTON_TEXT));

    // 保存(AsyncStorage.setItem)が失敗しても、目の前の画面遷移(オーバーレイを閉じる)は
    // 妨げられない。次回起動時に再度表示されるだけで、アプリがクラッシュしないことを確認する。
    await waitFor(() => expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull());
  });
});
