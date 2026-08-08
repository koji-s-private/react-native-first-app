import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Modal } from 'react-native';

import { Onboarding } from '@/components/onboarding';
import { ONBOARDING_SLIDES } from '@/constants/onboarding-slides';

describe('Onboarding', () => {
  it('renders nothing (no slide content) when visible is false (正常系: 起動直後の判定待ち状態)', () => {
    render(<Onboarding visible={false} onFinish={jest.fn()} />);

    // `Modal`自体は`visible=false`だとネイティブ上は非表示になるが、React Nativeの`Modal`は
    // `visible`に関わらず子要素をレンダーツリーには含める仕様のため、ここではモーダルの
    // `visible` propが正しくfalseで渡っていることを確認する。
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(false);
  });

  it("shows the first slide's title and description when visible becomes true (正常系: 初回起動時の表示)", () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    expect(screen.getByText(ONBOARDING_SLIDES[0].title)).toBeTruthy();
    expect(screen.getByText(ONBOARDING_SLIDES[0].description)).toBeTruthy();
    expect(screen.getByText('スキップ')).toBeTruthy();
    expect(screen.getByText('次へ')).toBeTruthy();
  });

  it('has at least 1 slide to show (境界値: スライド定義が空でないこと)', () => {
    // スライドが1件も無いと`ONBOARDING_SLIDES[stepIndex]`が`undefined`になり画面が壊れるため、
    // 定義自体が空でないことを回帰確認しておく
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    expect(ONBOARDING_SLIDES.length).toBeGreaterThan(0);
  });

  it('calls onFinish immediately when "スキップ" is pressed, without needing to go through all slides (正常系: スキップ)', () => {
    const onFinish = jest.fn();
    render(<Onboarding visible={true} onFinish={onFinish} />);

    fireEvent.press(screen.getByText('スキップ'));

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('advances to the next slide (without calling onFinish) when "次へ" is pressed on a non-last slide (正常系: 次へで進む)', () => {
    const onFinish = jest.fn();
    render(<Onboarding visible={true} onFinish={onFinish} />);

    fireEvent.press(screen.getByText('次へ'));

    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.getByText(ONBOARDING_SLIDES[1].title)).toBeTruthy();
    expect(screen.queryByText(ONBOARDING_SLIDES[0].title)).toBeNull();
  });

  it('walks through every slide in order as "次へ" is pressed repeatedly, and switches the button label to "はじめる" on the last slide (正常系: 全スライド遷移・境界値: 最終ページのボタン切り替え)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    for (let i = 0; i < ONBOARDING_SLIDES.length - 1; i += 1) {
      expect(screen.getByText(ONBOARDING_SLIDES[i].title)).toBeTruthy();
      fireEvent.press(screen.getByText('次へ'));
    }

    // 最後のスライドまで到達すると、ボタンのラベルが「はじめる」に変わる
    expect(screen.getByText(ONBOARDING_SLIDES[ONBOARDING_SLIDES.length - 1].title)).toBeTruthy();
    expect(screen.getByText('はじめる')).toBeTruthy();
    expect(screen.queryByText('次へ')).toBeNull();
  });

  it('calls onFinish exactly once when "はじめる" is pressed on the last slide (正常系: 最後まで進めて完了)', () => {
    const onFinish = jest.fn();
    render(<Onboarding visible={true} onFinish={onFinish} />);

    for (let i = 0; i < ONBOARDING_SLIDES.length - 1; i += 1) {
      fireEvent.press(screen.getByText('次へ'));
    }
    fireEvent.press(screen.getByText('はじめる'));

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('calls onFinish when the modal requests to close (e.g. Android hardware back button) (境界値: OS操作による閉じる)', () => {
    const onFinish = jest.fn();
    render(<Onboarding visible={true} onFinish={onFinish} />);

    const modal = screen.UNSAFE_getByType(Modal);
    modal.props.onRequestClose();

    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
