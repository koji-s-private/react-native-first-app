import { act, render, screen } from '@testing-library/react-native';
import React from 'react';

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
