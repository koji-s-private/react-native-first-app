import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo } from 'react-native';

import { SaveToast } from '@/components/save-toast';

describe('SaveToast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the given message', () => {
    render(<SaveToast message="保存しました" onHide={jest.fn()} />);

    expect(screen.getByText('保存しました')).toBeTruthy();
  });

  it('exposes accessibilityLiveRegion="polite" so screen readers announce the state change', () => {
    render(<SaveToast message="保存しました" onHide={jest.fn()} />);

    const toast = screen.getByTestId('save-toast');
    expect(toast.props.accessibilityLiveRegion).toBe('polite');
  });

  // `accessibilityLiveRegion="polite"`はAndroid専用のpropでiOS(VoiceOver)には効果がないため、
  // iOSでも読み上げられるよう`AccessibilityInfo.announceForAccessibility`を呼び出すことを検証する。
  // 実装は`process.env.EXPO_OS === 'ios'`の場合のみ呼び出すが、この値はbabel-preset-expo
  // (jest-expoのデフォルト設定では`platform: 'ios'`固定)によってビルド時にリテラル値へ
  // インライン化されるため、テスト実行中の書き換えは実装側の分岐に反映されない
  // (jest-expo/jest-preset.jsのbabelOpts参照)。そのため、iOS向けにインライン化された状態
  // (=常にiOS相当として振る舞う)でのアナウンス呼び出しのみを検証する。
  describe('iOSでのVoiceOverアナウンス(Issue #134)', () => {
    it('calls AccessibilityInfo.announceForAccessibility with the message when the toast is shown', () => {
      const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');

      render(<SaveToast message="保存しました" onHide={jest.fn()} />);

      expect(announceSpy).toHaveBeenCalledWith('保存しました');

      announceSpy.mockRestore();
    });

    it('announces again when the message changes while still mounted', () => {
      const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');

      const { rerender } = render(<SaveToast message="1件目のメッセージ" onHide={jest.fn()} />);
      expect(announceSpy).toHaveBeenCalledWith('1件目のメッセージ');

      rerender(<SaveToast message="2件目のメッセージ" onHide={jest.fn()} />);
      expect(announceSpy).toHaveBeenCalledWith('2件目のメッセージ');
      expect(announceSpy).toHaveBeenCalledTimes(2);

      announceSpy.mockRestore();
    });
  });

  it('calls onHide automatically after the auto-dismiss delay', () => {
    const onHide = jest.fn();
    render(<SaveToast message="保存しました" onHide={onHide} />);

    expect(onHide).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2500);
    });

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('does not call onHide before the auto-dismiss delay has elapsed (boundary)', () => {
    const onHide = jest.fn();
    render(<SaveToast message="保存しました" onHide={onHide} />);

    act(() => {
      jest.advanceTimersByTime(2499);
    });

    expect(onHide).not.toHaveBeenCalled();
  });

  it('resets the auto-dismiss timer when the message changes while still mounted', () => {
    const onHide = jest.fn();
    const { rerender } = render(<SaveToast message="1件目のメッセージ" onHide={onHide} />);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // まだ1件目のタイマーが完了する前に、新しいメッセージへ切り替わったことを想定する
    rerender(<SaveToast message="2件目のメッセージ" onHide={onHide} />);

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // 2件目のタイマーはまだ2000ms分しか経過していないため呼ばれない
    expect(onHide).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
