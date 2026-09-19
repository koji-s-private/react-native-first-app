import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppLockScreen } from '@/components/app-lock-screen';

// `useSafeAreaInsets`は`SafeAreaProvider`配下でないと投げるため、ライブラリ公式のjestモック
// (プロバイダ無しでもゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

const AUTHENTICATE_BUTTON_TEXT = '認証する';
const DISABLE_BUTTON_TEXT = 'アプリロックを解除';
const FAILURE_GUIDANCE_TEXT =
  '認証に失敗し続ける場合は、端末の設定でパスコード等を再設定してください。';
const UNSUPPORTED_GUIDANCE_TEXT =
  'この端末に登録されている生体認証・パスコードが見つかりません。端末の設定でパスコード等を再設定するか、下のボタンでアプリロックを解除してください。';
const TITLE_TEXT = 'ロック中';
const DESCRIPTION_TEXT = '生体認証、または端末のパスコードでロックを解除してください。';

// スタイルは配列で渡されるため、opacityを指定しているエントリだけを取り出す
function getButtonOpacity(button: ReturnType<typeof screen.getByRole>): number | undefined {
  const styleEntries = Array.isArray(button.props.style)
    ? button.props.style
    : [button.props.style];
  const opacityEntry = styleEntries.find(
    (entry: unknown) => entry && typeof entry === 'object' && 'opacity' in entry,
  ) as { opacity?: number } | undefined;
  return opacityEntry?.opacity;
}

// 取得済みの要素は再レンダー後も同じインスタンスを指すとは限らないため、
// 状態を確認するたびに都度クエリし直す
function getAuthenticateButton() {
  return screen.getByRole('button', { name: AUTHENTICATE_BUTTON_TEXT });
}

describe('AppLockScreen', () => {
  it('renders the Modal with visible=true when the visible prop is true (正常系: 表示制御)', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(true);
  });

  it('sets statusBarTranslucent and navigationBarTranslucent on the Modal so it matches the edge-to-edge display of the screen behind it', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
  });

  it('adds the safe area top/bottom insets to the container padding so the content stays clear of the system bars (正常系: インセット加算)', () => {
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={jest.fn().mockResolvedValue('success')}
          onDisableAppLock={jest.fn()}
        />
      </SafeAreaProvider>,
    );

    const containerStyle = StyleSheet.flatten(screen.getByTestId('app-lock-container').props.style);
    expect(containerStyle.paddingTop).toBe(24 + 44);
    expect(containerStyle.paddingBottom).toBe(24 + 34);
  });

  it('keeps the base padding when the safe area insets are zero (境界値: インセット0)', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    const containerStyle = StyleSheet.flatten(screen.getByTestId('app-lock-container').props.style);
    expect(containerStyle.paddingTop).toBe(24);
    expect(containerStyle.paddingBottom).toBe(24);
  });

  it('renders the Modal with visible=false when the visible prop is false (正常系: 非表示制御)', () => {
    render(
      <AppLockScreen
        visible={false}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(false);
  });

  it('shows the title and description (正常系: タイトル・説明文の表示内容)', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    expect(screen.getByText(TITLE_TEXT)).toBeTruthy();
    expect(screen.getByText(DESCRIPTION_TEXT)).toBeTruthy();
  });

  it('shows the "認証する" retry button when the device still supports authentication (正常系: 対応端末)', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue('success')}
        onDisableAppLock={jest.fn()}
      />,
    );

    expect(screen.getByText(AUTHENTICATE_BUTTON_TEXT)).toBeTruthy();
    expect(screen.queryByText(DISABLE_BUTTON_TEXT)).toBeNull();
  });

  it('calls onAuthenticate when the retry button is pressed (正常系: 手動再試行)', async () => {
    const onAuthenticate = jest.fn().mockResolvedValue('success');
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={onAuthenticate}
        onDisableAppLock={jest.fn()}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
    });

    expect(onAuthenticate).toHaveBeenCalledTimes(1);
  });

  describe('連打防止', () => {
    it('disables the retry button while onAuthenticate is in flight and ignores additional presses (境界値: 実行中の連打)', async () => {
      let resolveAuthenticate: (result: 'success') => void = () => {};
      const onAuthenticate = jest.fn(
        () =>
          new Promise<'success'>((resolve) => {
            resolveAuthenticate = resolve;
          }),
      );
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      act(() => {
        fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
      });
      // 1回目の呼び出しがまだ完了していない間はボタンがdisabledになり、連打しても無視される
      fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
      fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));

      expect(onAuthenticate).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveAuthenticate('success');
        await Promise.resolve();
      });
    });

    it('reflects the in-flight state via disabled/accessibilityState/opacity, and re-enables the button once onAuthenticate settles (境界値: 実行中→完了後のボタン状態遷移)', async () => {
      let resolveAuthenticate: (result: 'success') => void = () => {};
      const onAuthenticate = jest.fn(
        () =>
          new Promise<'success'>((resolve) => {
            resolveAuthenticate = resolve;
          }),
      );
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      // Pressableは`disabled` propをそのままホスト要素へ転送せず、
      // `accessibilityState.disabled`として公開する(RNの標準的な無効状態の表現)
      expect(getAuthenticateButton().props.accessibilityState?.disabled).toBe(false);
      expect(getButtonOpacity(getAuthenticateButton())).toBe(1);

      act(() => {
        fireEvent.press(getAuthenticateButton());
      });

      expect(getAuthenticateButton().props.accessibilityState?.disabled).toBe(true);
      expect(getButtonOpacity(getAuthenticateButton())).toBe(0.5);

      await act(async () => {
        resolveAuthenticate('success');
        await Promise.resolve();
      });

      expect(getAuthenticateButton().props.accessibilityState?.disabled).toBe(false);
      expect(getButtonOpacity(getAuthenticateButton())).toBe(1);

      // 完了後は連打防止の対象外で、再度押下すれば新たな呼び出しになる
      await act(async () => {
        fireEvent.press(getAuthenticateButton());
      });
      expect(onAuthenticate).toHaveBeenCalledTimes(2);
    });

    it('does not increment the consecutive failure count when onAuthenticate resolves to "skipped" (境界値: 多重呼び出しガードによるskippedは失敗扱いしない)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue('skipped');
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
        });
      }

      expect(screen.queryByText(FAILURE_GUIDANCE_TEXT)).toBeNull();
    });
  });

  // 端末側の生体認証・パスコード設定が全て削除されると、
  // isSupportedがfalseになり、ロック画面からアプリロックをOFFにできる脱出導線が必要になる
  describe('端末側の認証手段が失われた場合の脱出導線', () => {
    it('shows the "アプリロックを解除" escape button instead of the retry button when isSupported is false (異常系: 非対応端末)', () => {
      render(
        <AppLockScreen
          visible={true}
          isSupported={false}
          onAuthenticate={jest.fn().mockResolvedValue('failure')}
          onDisableAppLock={jest.fn()}
        />,
      );

      expect(screen.getByText(DISABLE_BUTTON_TEXT)).toBeTruthy();
      expect(screen.queryByText(AUTHENTICATE_BUTTON_TEXT)).toBeNull();
      expect(screen.getByText(UNSUPPORTED_GUIDANCE_TEXT)).toBeTruthy();
    });

    it('calls onDisableAppLock when the escape button is pressed (異常系: 脱出導線の押下)', () => {
      const onDisableAppLock = jest.fn();
      render(
        <AppLockScreen
          visible={true}
          isSupported={false}
          onAuthenticate={jest.fn().mockResolvedValue('failure')}
          onDisableAppLock={onDisableAppLock}
        />,
      );

      fireEvent.press(screen.getByText(DISABLE_BUTTON_TEXT));

      expect(onDisableAppLock).toHaveBeenCalledTimes(1);
    });
  });

  describe('連続認証失敗時のフォールバック案内', () => {
    it('does not show the guidance text before repeated failures accumulate (境界値: 失敗回数がしきい値未満)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue('failure');
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      await act(async () => {
        fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
      });
      await act(async () => {
        fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
      });

      expect(screen.queryByText(FAILURE_GUIDANCE_TEXT)).toBeNull();
    });

    it('shows the guidance text after authentication fails repeatedly (正常系: 連続失敗でフォールバック案内を表示)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue('failure');
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
        });
      }

      await waitFor(() => expect(screen.getByText(FAILURE_GUIDANCE_TEXT)).toBeTruthy());
    });

    it('increments the consecutive failure count only for actual failures, not for skipped calls (境界値: skippedと実際の失敗が混在する場合はfailureのみ加算)', async () => {
      const onAuthenticate = jest
        .fn()
        .mockResolvedValueOnce('skipped')
        .mockResolvedValueOnce('failure')
        .mockResolvedValueOnce('skipped')
        .mockResolvedValueOnce('failure')
        .mockResolvedValueOnce('skipped')
        .mockResolvedValueOnce('failure');
      render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      // skipped/failureが交互に3回ずつ発生しても、加算されるのは実際の失敗3回分のみで
      // しきい値(3)に達しガイダンスが表示される
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
        });
      }

      await waitFor(() => expect(screen.getByText(FAILURE_GUIDANCE_TEXT)).toBeTruthy());
    });

    it('resets the failure count once the screen becomes visible again (境界値: 再表示で失敗回数がリセットされる)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue('failure');
      const { rerender } = render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
        });
      }
      await waitFor(() => expect(screen.getByText(FAILURE_GUIDANCE_TEXT)).toBeTruthy());

      // 認証成功などで一旦非表示になり、次のバックグラウンド復帰で再度表示された状況を模す
      rerender(
        <AppLockScreen
          visible={false}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );
      rerender(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      expect(screen.queryByText(FAILURE_GUIDANCE_TEXT)).toBeNull();
    });

    it('shows only the unsupported guidance, not the failure guidance, when isSupported becomes false after repeated failures (境界値: 失敗ガイダンス表示中に非対応端末へ切り替わった場合の排他表示)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue('failure');
      const { rerender } = render(
        <AppLockScreen
          visible={true}
          isSupported={true}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          fireEvent.press(screen.getByText(AUTHENTICATE_BUTTON_TEXT));
        });
      }
      await waitFor(() => expect(screen.getByText(FAILURE_GUIDANCE_TEXT)).toBeTruthy());

      // 端末側の認証手段が失われてisSupportedがfalseに切り替わった状況を模す
      rerender(
        <AppLockScreen
          visible={true}
          isSupported={false}
          onAuthenticate={onAuthenticate}
          onDisableAppLock={jest.fn()}
        />,
      );

      expect(screen.getByText(UNSUPPORTED_GUIDANCE_TEXT)).toBeTruthy();
      expect(screen.queryByText(FAILURE_GUIDANCE_TEXT)).toBeNull();
    });
  });
});
