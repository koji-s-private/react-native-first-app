import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { AppState } from 'react-native';

import RootLayout from '@/app/_layout';
import { APP_LOCK_ENABLED_STORAGE_KEY } from '@/contexts/app-lock-context';
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

// 「アプリロック」画面(#155)が使う`utils/app-lock-authentication.ts`
// (expo-local-authenticationの薄いラッパー)を、実際のネイティブ生体認証APIを呼ばずに検証できるよう
// モック化する(個別の挙動はtests/utils/app-lock-authentication.test.ts等で検証済み。ここでは結線確認のみ)。
jest.mock('@/utils/app-lock-authentication', () => ({
  isAppLockSupportedAsync: jest.fn(() => Promise.resolve(true)),
  authenticateForAppLockAsync: jest.fn(() => Promise.resolve(true)),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedAppLockAuthentication = require('@/utils/app-lock-authentication') as {
  isAppLockSupportedAsync: jest.Mock;
  authenticateForAppLockAsync: jest.Mock;
};

// `AppState.addEventListener`から'change'イベント用に登録されたリスナー関数を取り出し、
// テスト側から直接呼び出すことでバックグラウンド遷移をシミュレートする
// (tests/contexts/app-lock-context.test.tsxと同様)。
function getAppStateChangeListener(): (nextAppState: string) => void {
  const addEventListenerMock = AppState.addEventListener as jest.Mock;
  const call = addEventListenerMock.mock.calls.find(([eventName]) => eventName === 'change');
  if (!call) {
    throw new Error('AppState.addEventListener("change", ...) が呼び出されていません');
  }
  return call[1];
}

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

describe('RootLayoutのアプリロック画面表示制御(Issue #155)', () => {
  const LOCK_SCREEN_TITLE = 'ロック中';
  const AUTHENTICATE_BUTTON_TEXT = '認証する';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedAppLockAuthentication.isAppLockSupportedAsync.mockResolvedValue(true);
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockResolvedValue(true);
    // オンボーディングのオーバーレイが重なって邪魔にならないよう、完了済み扱いにしておく
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'true');
  });

  it('does not show the lock screen when the app-lock setting is OFF (既定値)', async () => {
    render(<RootLayout />);

    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(screen.queryByText(LOCK_SCREEN_TITLE)).toBeNull();
  });

  it('does not show the lock screen immediately after moving to the background while OFF (境界値: OFF時はbackground遷移してもロックしない)', async () => {
    render(<RootLayout />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    const handleAppStateChange = getAppStateChangeListener();

    act(() => {
      handleAppStateChange('background');
    });

    expect(screen.queryByText(LOCK_SCREEN_TITLE)).toBeNull();
  });

  it('shows the lock screen and automatically triggers authentication when returning from the background while ON (正常系: ON時のbackground遷移でロック画面表示・自動認証)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'true');
    // 認証が自動で成功してロック画面が閉じてしまわないよう、手動での検証区間だけ保留にする
    let resolveAuthenticate: (success: boolean) => void = () => {};
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveAuthenticate = resolve;
      }),
    );
    render(<RootLayout />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    const handleAppStateChange = getAppStateChangeListener();

    act(() => {
      handleAppStateChange('background');
    });

    expect(screen.getByText(LOCK_SCREEN_TITLE)).toBeTruthy();
    // ロック画面が表示された直後、ユーザー操作を待たず自動で認証プロンプトが起動する
    await waitFor(() =>
      expect(mockedAppLockAuthentication.authenticateForAppLockAsync).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      resolveAuthenticate(true);
      await Promise.resolve();
    });
  });

  it('hides the lock screen once authentication succeeds via the manual retry button (正常系: 手動再試行での認証成功)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'true');
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockResolvedValue(false);
    render(<RootLayout />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    const handleAppStateChange = getAppStateChangeListener();
    act(() => {
      handleAppStateChange('background');
    });
    await waitFor(() =>
      expect(mockedAppLockAuthentication.authenticateForAppLockAsync).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText(LOCK_SCREEN_TITLE)).toBeTruthy();
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockResolvedValue(true);

    await act(async () => {
      fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
    });

    await waitFor(() => expect(screen.queryByText(LOCK_SCREEN_TITLE)).toBeNull());
  });

  it('keeps the lock screen visible when authentication fails (異常系: 認証失敗時はロック画面を維持)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'true');
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockResolvedValue(false);
    render(<RootLayout />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    const handleAppStateChange = getAppStateChangeListener();

    act(() => {
      handleAppStateChange('background');
    });

    await waitFor(() =>
      expect(mockedAppLockAuthentication.authenticateForAppLockAsync).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText(LOCK_SCREEN_TITLE)).toBeTruthy();
  });
});
