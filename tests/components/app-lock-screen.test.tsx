import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Modal } from 'react-native';

import { AppLockScreen } from '@/components/app-lock-screen';

const AUTHENTICATE_BUTTON_TEXT = '認証する';
const DISABLE_BUTTON_TEXT = 'アプリロックを解除';
const FAILURE_GUIDANCE_TEXT =
  '認証に失敗し続ける場合は、端末の設定でパスコード等を再設定してください。';
const UNSUPPORTED_GUIDANCE_TEXT =
  'この端末に登録されている生体認証・パスコードが見つかりません。端末の設定でパスコード等を再設定するか、下のボタンでアプリロックを解除してください。';
const TITLE_TEXT = 'ロック中';
const DESCRIPTION_TEXT = '生体認証、または端末のパスコードでロックを解除してください。';

describe('AppLockScreen', () => {
  it('renders the Modal with visible=true when the visible prop is true (正常系: 表示制御)', () => {
    render(
      <AppLockScreen
        visible={true}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue(true)}
        onDisableAppLock={jest.fn()}
      />,
    );

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(true);
  });

  it('renders the Modal with visible=false when the visible prop is false (正常系: 非表示制御)', () => {
    render(
      <AppLockScreen
        visible={false}
        isSupported={true}
        onAuthenticate={jest.fn().mockResolvedValue(true)}
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
        onAuthenticate={jest.fn().mockResolvedValue(true)}
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
        onAuthenticate={jest.fn().mockResolvedValue(true)}
        onDisableAppLock={jest.fn()}
      />,
    );

    expect(screen.getByText(AUTHENTICATE_BUTTON_TEXT)).toBeTruthy();
    expect(screen.queryByText(DISABLE_BUTTON_TEXT)).toBeNull();
  });

  it('calls onAuthenticate when the retry button is pressed (正常系: 手動再試行)', async () => {
    const onAuthenticate = jest.fn().mockResolvedValue(true);
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

  // 端末側の生体認証・パスコード設定が全て削除されると、
  // isSupportedがfalseになり、ロック画面からアプリロックをOFFにできる脱出導線が必要になる
  describe('端末側の認証手段が失われた場合の脱出導線', () => {
    it('shows the "アプリロックを解除" escape button instead of the retry button when isSupported is false (異常系: 非対応端末)', () => {
      render(
        <AppLockScreen
          visible={true}
          isSupported={false}
          onAuthenticate={jest.fn().mockResolvedValue(false)}
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
          onAuthenticate={jest.fn().mockResolvedValue(false)}
          onDisableAppLock={onDisableAppLock}
        />,
      );

      fireEvent.press(screen.getByText(DISABLE_BUTTON_TEXT));

      expect(onDisableAppLock).toHaveBeenCalledTimes(1);
    });
  });

  describe('連続認証失敗時のフォールバック案内', () => {
    it('does not show the guidance text before repeated failures accumulate (境界値: 失敗回数がしきい値未満)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue(false);
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
      const onAuthenticate = jest.fn().mockResolvedValue(false);
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

    it('resets the failure count once the screen becomes visible again (境界値: 再表示で失敗回数がリセットされる)', async () => {
      const onAuthenticate = jest.fn().mockResolvedValue(false);
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
  });
});
