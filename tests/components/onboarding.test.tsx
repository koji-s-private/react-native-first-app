import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Onboarding } from '@/components/onboarding';
import { ONBOARDING_SLIDES } from '@/constants/onboarding-slides';

// `useSafeAreaInsets`は`SafeAreaProvider`配下でないと投げるため、ライブラリ公式のjestモック
// (プロバイダ無しでもゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

const INSETS = { top: 44, left: 0, right: 0, bottom: 34 };

function renderWithInsets(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: INSETS }}
    >
      {ui}
    </SafeAreaProvider>,
  );
}

describe('Onboarding', () => {
  it('renders nothing (no slide content) when visible is false (正常系: 起動直後の判定待ち状態)', () => {
    render(<Onboarding visible={false} onFinish={jest.fn()} />);

    // `Modal`自体は`visible=false`だとネイティブ上は非表示になるが、React Nativeの`Modal`は
    // `visible`に関わらず子要素をレンダーツリーには含める仕様のため、ここではモーダルの
    // `visible` propが正しくfalseで渡っていることを確認する。
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(false);
  });

  it('sets statusBarTranslucent and navigationBarTranslucent on the Modal so it matches the edge-to-edge display of the screen behind it', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
  });

  it("shows the first slide's title and description when visible becomes true (正常系: 初回起動時の表示)", () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    expect(screen.getByText(ONBOARDING_SLIDES[0].title)).toBeTruthy();
    expect(screen.getByText(ONBOARDING_SLIDES[0].description)).toBeTruthy();
    expect(screen.getByText('スキップ')).toBeTruthy();
    expect(screen.getByText('次へ')).toBeTruthy();
    expect(screen.queryByLabelText('前のスライドに戻る')).toBeNull();
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

  it('shows a back action after the first slide and returns to the previous slide (正常系: 戻る導線)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    fireEvent.press(screen.getByText('次へ'));
    expect(screen.getByText(ONBOARDING_SLIDES[1].title)).toBeTruthy();

    fireEvent.press(screen.getByLabelText('前のスライドに戻る'));

    expect(screen.getByText(ONBOARDING_SLIDES[0].title)).toBeTruthy();
    expect(screen.queryByLabelText('前のスライドに戻る')).toBeNull();
  });

  it('keeps the header actions above the slide body so the back action remains clickable (回帰防止: ヒットテスト)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    fireEvent.press(screen.getByText('次へ'));

    const headerStyle = StyleSheet.flatten(screen.getByTestId('onboarding-header').props.style);
    expect(headerStyle.zIndex).toBeGreaterThan(0);
    expect(headerStyle.elevation).toBeGreaterThan(0);
  });

  it('offsets the header (skip/back) below the status bar by the safe area top inset (正常系: インセット加算)', () => {
    renderWithInsets(<Onboarding visible={true} onFinish={jest.fn()} />);

    const headerStyle = StyleSheet.flatten(screen.getByTestId('onboarding-header').props.style);
    expect(headerStyle.top).toBe(16 + INSETS.top);
  });

  it('adds the safe area top/bottom insets to the container padding so the next button stays clear of the navigation bar (正常系: インセット加算)', () => {
    renderWithInsets(<Onboarding visible={true} onFinish={jest.fn()} />);

    const containerStyle = StyleSheet.flatten(
      screen.getByTestId('onboarding-container').props.style,
    );
    expect(containerStyle.paddingTop).toBe(24 + INSETS.top);
    expect(containerStyle.paddingBottom).toBe(24 + INSETS.bottom);
  });

  it('keeps the base spacing when the safe area insets are zero (境界値: インセット0)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    const headerStyle = StyleSheet.flatten(screen.getByTestId('onboarding-header').props.style);
    const containerStyle = StyleSheet.flatten(
      screen.getByTestId('onboarding-container').props.style,
    );
    expect(headerStyle.top).toBe(16);
    expect(containerStyle.paddingTop).toBe(24);
    expect(containerStyle.paddingBottom).toBe(24);
  });

  it('moves to the selected slide when a pagination dot is pressed (正常系: ドットから直接移動)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    fireEvent.press(screen.getByLabelText('3枚目のスライドへ移動'));

    expect(screen.getByText(ONBOARDING_SLIDES[2].title)).toBeTruthy();
    expect(screen.getByLabelText('3枚目のスライドへ移動').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('shows a calendar description that matches the actual calendar UI (dot/count badges, not a title) (正常系: カレンダー説明文の内容確認)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    const calendarSlideIndex = ONBOARDING_SLIDES.findIndex(
      (slide) => slide.key === 'view-calendar',
    );
    for (let i = 0; i < calendarSlideIndex; i += 1) {
      fireEvent.press(screen.getByText('次へ'));
    }

    const description = ONBOARDING_SLIDES[calendarSlideIndex].description;
    expect(screen.getByText(description)).toBeTruthy();
    // カレンダーのセルは日記のタイトルではなくドット/件数バッジで件数を示すため、
    // 実装と食い違う「タイトル」という表現を含まないことを回帰確認する
    expect(description).not.toContain('タイトル');
    expect(description).toContain('ドット');
    expect(description).toContain('件数');
  });

  it('introduces search with the actual search field label on the home tab (正常系: 検索スライドの内容確認)', () => {
    const slide = ONBOARDING_SLIDES.find((item) => item.key === 'search-diary');

    expect(slide).toBeDefined();
    expect(slide?.description).toContain('日記を検索');
    expect(slide?.description).toContain('日記」タブ');
  });

  it('introduces reminders, app lock, and export/import on the settings slide (正常系: 設定スライドの内容確認)', () => {
    const slide = ONBOARDING_SLIDES.find((item) => item.key === 'settings');

    expect(slide).toBeDefined();
    expect(slide?.description).toContain('リマインダー');
    expect(slide?.description).toContain('アプリロック');
    expect(slide?.description).toContain('エクスポート');
    expect(slide?.description).toContain('インポート');
  });

  it('keeps slide keys unique so pagination dots render with stable keys (境界値: キーの一意性)', () => {
    const keys = ONBOARDING_SLIDES.map((slide) => slide.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows the search slide content when its pagination dot is pressed (正常系: 検索スライドへの移動)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    const searchIndex = ONBOARDING_SLIDES.findIndex((slide) => slide.key === 'search-diary');
    fireEvent.press(screen.getByLabelText(`${searchIndex + 1}枚目のスライドへ移動`));

    expect(screen.getByText(ONBOARDING_SLIDES[searchIndex].title)).toBeTruthy();
    expect(screen.getByText(ONBOARDING_SLIDES[searchIndex].description)).toBeTruthy();
  });

  it('renders one pagination dot per slide (境界値: ドット数とスライド数の一致)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    for (let i = 0; i < ONBOARDING_SLIDES.length; i += 1) {
      expect(screen.getByLabelText(`${i + 1}枚目のスライドへ移動`)).toBeTruthy();
    }
    expect(
      screen.queryByLabelText(`${ONBOARDING_SLIDES.length + 1}枚目のスライドへ移動`),
    ).toBeNull();
  });

  it('switches the button to "はじめる" when jumping straight to the last slide via its dot, and returns to "次へ" after going back (境界値: 最終ドットへの直接移動と戻り)', () => {
    render(<Onboarding visible={true} onFinish={jest.fn()} />);

    fireEvent.press(screen.getByLabelText(`${ONBOARDING_SLIDES.length}枚目のスライドへ移動`));

    const lastSlide = ONBOARDING_SLIDES[ONBOARDING_SLIDES.length - 1];
    expect(screen.getByText(lastSlide.title)).toBeTruthy();
    expect(screen.getByText(lastSlide.description)).toBeTruthy();
    expect(screen.getByText('はじめる')).toBeTruthy();
    expect(screen.queryByText('次へ')).toBeNull();

    fireEvent.press(screen.getByLabelText('前のスライドに戻る'));

    expect(screen.getByText(ONBOARDING_SLIDES[ONBOARDING_SLIDES.length - 2].title)).toBeTruthy();
    expect(screen.getByText('次へ')).toBeTruthy();
    expect(screen.queryByText('はじめる')).toBeNull();
  });

  it('calls onFinish when "スキップ" is pressed on the last slide too (境界値: 最終スライドでのスキップ)', () => {
    const onFinish = jest.fn();
    render(<Onboarding visible={true} onFinish={onFinish} />);

    fireEvent.press(screen.getByLabelText(`${ONBOARDING_SLIDES.length}枚目のスライドへ移動`));
    fireEvent.press(screen.getByText('スキップ'));

    expect(onFinish).toHaveBeenCalledTimes(1);
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
