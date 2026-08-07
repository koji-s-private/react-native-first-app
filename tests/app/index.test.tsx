import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { randomUUID } from 'expo-crypto';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/(tabs)/index';

// `expo-router`'s `Link` (with its `Trigger`/`Preview`/`Menu` compound API) requires a
// navigation/router context that isn't set up when rendering the screen in isolation.
// We stub it out with simple pass-through components so the screen's own content can be
// asserted without pulling in the whole router.
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

// `jest-expo` が自動生成する expo-crypto のモック(node_modules/expo-crypto/mocks/ExpoCrypto.ts)は
// `randomUUID()` が常に `undefined` を返す実装になっているため、ID一意性を検証するテストのために
// 呼び出しごとに異なる値を返す独自のモックに差し替える。
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(),
}));

// 実機では `expo-router` の `ExpoRoot` が自動的に `SafeAreaProvider` で全体をラップするが、
// このテストでは `HomeScreen` を単体でレンダリングするため、そのラップが存在しない。
// `useSafeAreaInsets` は `SafeAreaProvider` 配下でないとエラーを投げるため、
// ライブラリ公式のjestモック(常にゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

// The native `AsyncStorage` module isn't available in the Jest environment
// (`NativeModule: AsyncStorage is null`), so we swap in the official in-memory mock
// shipped with the package. This lets the screen's persistence logic (`getItem`/`setItem`)
// run against a real (fake) storage backend instead of crashing.
jest.mock('@react-native-async-storage/async-storage', () =>
  // 上記と同様、`jest.mock`の巻き上げの都合によりファクトリ内で`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `KeyboardAvoidingView` は `behavior` prop を内部でしか消費せず、レンダリング結果の
// ホストView(のstyle)には直接反映されないため、実装が意図した `behavior` を渡しているかを
// レンダリング結果だけから検証するのは難しい。そこで、実際の見た目・挙動には関与しない
// 薄いモックに差し替え、渡された `behavior` prop を `testID` 付きのViewでそのまま可視化する。
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  // `jest.mock`の巻き上げの都合によりファクトリ内で`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactForMock = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RN = require('react-native');

  function MockKeyboardAvoidingView({
    children,
    behavior,
    style,
  }: PropsWithChildren<{ behavior?: string; style?: unknown }>) {
    return ReactForMock.createElement(
      RN.View,
      { testID: 'keyboard-avoiding-view', accessibilityValue: { text: behavior }, style },
      children,
    );
  }

  return { __esModule: true, default: MockKeyboardAvoidingView };
});

const mockRandomUUID = randomUUID as jest.Mock;

const STORAGE_KEY = 'diary-entries';
const INPUT_PLACEHOLDER = '今日の出来事や気持ちを書いてみましょう';
const CLOSE_BUTTON_TEXT = '閉じる';
const KEYBOARD_AVOIDING_VIEW_TEST_ID = 'keyboard-avoiding-view';

// `react-native-calendars` の `Calendar` はデフォルトで実行時点の「今日」を含む月を表示する
// (このコンポーネントは `current`/`initialDate` を指定していないため)。そのため、テストで参照する
// 日付は常に「テスト実行日と同じ月」に収める必要がある。
//
// カレンダーは表示する週を7の倍数に揃えるため、月初/月末には前後の月の日付が「はみ出し」として
// 描画される(最大でも前後6日程度)。10〜20日の範囲であればどの月・どの実行日でも
// このはみ出しと重複しない(前月のはみ出しは常に月末に近い大きな数字、翌月のはみ出しは
// 常に月初に近い小さな数字になるため)。
// さらに、`dayWithEntry`(10〜15日)と `dayWithoutEntry`(16〜20日)の範囲を分けることで、
// テスト実行日そのものに関わらず必ず異なる日付になることを保証する。
function pickTestDays(now: Date): { dayWithEntry: number; dayWithoutEntry: number } {
  return {
    dayWithEntry: 10 + (now.getDate() % 6), // 10〜15
    dayWithoutEntry: 16 + (now.getDate() % 5), // 16〜20
  };
}

// 実行時点の年月と、指定した日付・時刻から端末ローカル時刻ベースのISO文字列を作る
// (UTC表記のリテラルを直接組み立てるとテスト実行環境のタイムゾーンによって
// 日付がずれる恐れがあるため、必ずDateのローカルコンストラクタ経由で作成する)。
function isoAt(now: Date, day: number, hour = 9, minute = 0): string {
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0).toISOString();
}

// レンダリング結果(`screen.toJSON()`)から、画面に出現するテキストを出現順に一次元配列へ展開する。
// FlatListの描画順(=配列順)を検証するために使う。
function flattenTexts(node: unknown, acc: string[] = []): string[] {
  if (node === null || node === undefined) {
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => flattenTexts(child, acc));
    return acc;
  }
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  const maybeChildren = (node as { children?: unknown }).children;
  if (maybeChildren) {
    flattenTexts(maybeChildren, acc);
  }
  return acc;
}

describe('HomeScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();

    // 各テストで一意なUUID風の値を返すデフォルト実装をセットしておく
    // (個別のテストで一意性を厳密に検証したい場合は mockReturnValueOnce 等で上書きする)。
    let uuidCounter = 0;
    mockRandomUUID.mockImplementation(() => `mock-uuid-${uuidCounter++}`);
  });

  it('renders the diary title', async () => {
    render(<HomeScreen />);

    expect(screen.getByText('日記')).toBeTruthy();

    // Let the initial `AsyncStorage.getItem` effect settle so it doesn't leak into
    // the next test.
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  });

  it('falls back to the base top margin (no extra inset) when the safe area top inset is zero (e.g. Android without a notch)', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    const title = screen.getByText('日記');
    const flattenedStyle = StyleSheet.flatten(title.props.style);

    // insets.top が 0 の場合は、ベースの余白(8)のみが適用される
    expect(flattenedStyle.marginTop).toBe(8);
  });

  it('adds the safe area top inset to the title marginTop so it does not overlap the status bar/notch/Dynamic Island', async () => {
    // iPhone 14 Pro (Dynamic Island) 相当のトップインセットを想定
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, left: 0, right: 0, bottom: 34 },
        }}
      >
        <HomeScreen />
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    const title = screen.getByText('日記');
    const flattenedStyle = StyleSheet.flatten(title.props.style);

    // marginTop はベースの余白(8) + セーフエリアの上端インセット(59) になる
    expect(flattenedStyle.marginTop).toBe(59 + 8);
  });

  describe('KeyboardAvoidingView のプラットフォーム別挙動', () => {
    // `Platform.OS` はテスト間で状態を共有するモジュールレベルの値のため、
    // 変更したテストの後は必ず元の値(デフォルトの 'ios')へ戻す。
    const originalPlatformOS = Platform.OS;

    afterEach(() => {
      Platform.OS = originalPlatformOS;
    });

    it('uses behavior="height" on Android so the input and save button are not hidden by the keyboard', async () => {
      Platform.OS = 'android';

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const keyboardAvoidingView = screen.getByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
      expect(keyboardAvoidingView.props.accessibilityValue.text).toBe('height');
    });

    it('keeps behavior="padding" on iOS (regression check)', async () => {
      Platform.OS = 'ios';

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const keyboardAvoidingView = screen.getByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
      expect(keyboardAvoidingView.props.accessibilityValue.text).toBe('padding');
    });
  });

  describe('日記の保存', () => {
    it('does not save and does not call AsyncStorage.setItem when the input is empty', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      // カレンダー上に日記のタイトル(=タップ可能なセル)が一つも表示されないことで
      // 「何も保存されていない」ことを確認する
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('does not save an entry consisting only of whitespace', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');
      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('clears the text input after saving', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '入力内容');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
      expect(input.props.value).toBe('');
    });

    it('shows a character counter that updates as the user types and limits input via maxLength', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      expect(input.props.maxLength).toBe(1000);
      expect(screen.getByText('0/1000')).toBeTruthy();

      fireEvent.changeText(input, '何か書く');
      expect(screen.getByText('4/1000')).toBeTruthy();
    });

    it('does not save when the text exceeds the max length (defense in depth against TextInput maxLength)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      // TextInputのmaxLengthを迂回して直接onChangeTextを呼び出すケースを想定し、
      // handleSave側の防御チェックが機能することを確認する
      fireEvent.changeText(input, 'あ'.repeat(1001));
      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('allows saving when the text length is exactly at the max length (boundary)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      const exactlyMaxLength = 'あ'.repeat(1000);
      fireEvent.changeText(input, exactlyMaxLength);
      expect(screen.getByText('1000/1000')).toBeTruthy();

      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = JSON.parse(value);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].text).toBe(exactlyMaxLength);
    });

    it('renders the character counter in red once the max length is reached, and in the normal color just below it (boundary)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);

      // 上限の1文字手前(999文字)では強調色にならない
      fireEvent.changeText(input, 'あ'.repeat(999));
      const counterBelowLimit = screen.getByText('999/1000');
      expect(StyleSheet.flatten(counterBelowLimit.props.style).color).not.toBe('#d32f2f');

      // 上限ちょうど(1000文字)では赤字で強調される
      fireEvent.changeText(input, 'あ'.repeat(1000));
      const counterAtLimit = screen.getByText('1000/1000');
      expect(StyleSheet.flatten(counterAtLimit.props.style).color).toBe('#d32f2f');
    });

    it('disables the save button while the input is empty and enables it once text is entered', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // `getByText('保存')` resolves the innermost `Text` node; the rendered `Pressable`
      // (which carries the `disabled` prop as `accessibilityState.disabled`) is three
      // levels up in the tree (Text -> Text -> ThemedText -> Pressable's host View).
      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      expect(saveButton?.props.accessibilityState?.disabled).toBe(true);

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '何か書く');

      expect(saveButton?.props.accessibilityState?.disabled).toBe(false);
    });

    it('restores previously saved entries from AsyncStorage and shows them when the day is tapped', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '2件目の日記', createdAt: isoAt(now, dayWithEntry, 20, 0) },
        { id: '2', text: '1件目の日記', createdAt: isoAt(now, dayWithEntry, 8, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);

      // その日最初(=最も時刻が早い)の日記のタイトルがカレンダーセルに表示される
      expect(await screen.findByText('1件目の日記')).toBeTruthy();
      expect(screen.queryByText('2件目の日記')).toBeNull();

      // セルをタップするとその日の全件がモーダルに表示される
      // (モーダル表示中も背後のカレンダーセルは残るため、先頭の日記のタイトルは
      // カレンダーセルとモーダル内の一覧の2箇所に表示されることになる)
      fireEvent.press(screen.getAllByText('1件目の日記')[0]);
      expect(await screen.findByText('2件目の日記')).toBeTruthy();
      expect(screen.getAllByText('1件目の日記').length).toBeGreaterThanOrEqual(1);

      // 時刻の昇順(先に書かれたものが先)に並んでいる
      const texts = flattenTexts(screen.toJSON());
      expect(texts.indexOf('1件目の日記')).toBeLessThan(texts.indexOf('2件目の日記'));
    });

    it('saves a new entry, persists it to AsyncStorage, and shows it together with an existing entry for the same day', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      // 保存前は既存の1件目のタイトルがその日のセルに表示されている
      await screen.findByText('過去の日記');

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [key, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(key).toBe(STORAGE_KEY);

      const persisted = JSON.parse(value);
      expect(persisted).toHaveLength(2);
      expect(persisted.some((entry: { text: string }) => entry.text === '今日の日記')).toBe(true);
      expect(persisted.some((entry: { text: string }) => entry.text === '過去の日記')).toBe(true);

      // セルのタイトルは変わらず一番早い時刻の「過去の日記」のまま
      expect(screen.getByText('過去の日記')).toBeTruthy();
      expect(screen.queryByText('今日の日記')).toBeNull();

      // タップするとその日の一覧に新しい日記も含めて表示される
      fireEvent.press(screen.getAllByText('過去の日記')[0]);
      expect(await screen.findByText('今日の日記')).toBeTruthy();
      expect(screen.getAllByText('過去の日記').length).toBeGreaterThanOrEqual(1);
    });

    it('shows the empty state when stored data is corrupted (invalid JSON)', async () => {
      jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not valid json');

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 壊れたデータは読み捨てられ、空の状態から始まるためカレンダーに操作可能なセルは無い
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('rolls back entries and draft and shows an error message when AsyncStorage.setItem fails', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('過去の日記');

      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();

      // 保存前の状態にロールバックされているため、新しい日記のタイトルはどこにも表示されない
      expect(screen.queryByText('今日の日記')).toBeNull();
      expect(input.props.value).toBe('今日の日記');
      expect(screen.getByText('過去の日記')).toBeTruthy();

      // モーダルを開いても新しい日記は含まれず、既存の1件のみが表示される
      fireEvent.press(screen.getByText('過去の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      expect(screen.queryByText('今日の日記')).toBeNull();
    });

    it('assigns a unique id (via expo-crypto randomUUID) to each entry saved consecutively', async () => {
      // `randomUUID` を呼び出しごとに異なる値を返すようスタブし、
      // 同一ミリ秒での `Date.now().toString()` による衝突が起きないことを検証する。
      mockRandomUUID
        .mockReturnValueOnce('uuid-1')
        .mockReturnValueOnce('uuid-2')
        .mockReturnValueOnce('uuid-3');

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      const saveButton = screen.getByText('保存');

      fireEvent.changeText(input, '1件目');
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      fireEvent.changeText(input, '2件目');
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2));

      fireEvent.changeText(input, '3件目');
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(3));

      expect(mockRandomUUID).toHaveBeenCalledTimes(3);

      const lastCall = (AsyncStorage.setItem as jest.Mock).mock.calls[2];
      const persisted = JSON.parse(lastCall[1]);

      expect(persisted).toHaveLength(3);
      const ids = persisted.map((entry: { id: string }) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);

      // 同じ日に書かれた3件すべてが、セルをタップした一覧に表示される
      // (セルには最初に書かれた「1件目」のタイトルのみが表示される)
      expect(screen.getByText('1件目')).toBeTruthy();
      fireEvent.press(screen.getByText('1件目'));
      expect(await screen.findByText('2件目')).toBeTruthy();
      expect(screen.getByText('3件目')).toBeTruthy();
    });
  });

  describe('カレンダー表示とモーダル', () => {
    it('shows the current year and month heading in the calendar header', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 「2026年8月」のように年→月の順で見出しが表示される(矢印の間に埋もれず視認できること)。
      // react-native-calendarsのヘッダーは`importantForAccessibility="no-hide-descendants"`で
      // 内部テキストをアクセシビリティツリーから隠しているため、`includeHiddenElements`を指定して検索する
      // (画面上には通常どおり表示されており、アクセシビリティツリーからのみ隠れている)。
      expect(
        await screen.findByText(`${now.getFullYear()}年${now.getMonth() + 1}月`, {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
    });

    it('shows a weekday header row (日 月 火 水 木 金 土)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      for (const dayName of ['日', '月', '火', '水', '木', '金', '土']) {
        expect(screen.getByText(dayName, { includeHiddenElements: true })).toBeTruthy();
      }
    });

    it("shows the first entry's title of the day in the corresponding calendar cell", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記\n本文がここに続く', createdAt: isoAt(now, dayWithEntry, 9, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);

      // タイトルは本文の最初の行のみが使われる(改行以降は表示されない)
      expect(await screen.findByText('朝の日記')).toBeTruthy();
      expect(screen.queryByText('朝の日記\n本文がここに続く')).toBeNull();
      expect(screen.queryByText('本文がここに続く')).toBeNull();
    });

    it('does not truncate a title whose first line is exactly 20 characters (boundary)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const exactlyTwentyChars = 'あ'.repeat(20);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: exactlyTwentyChars, createdAt: isoAt(now, dayWithEntry) },
        ]),
      );

      render(<HomeScreen />);

      expect(await screen.findByText(exactlyTwentyChars)).toBeTruthy();
    });

    it('truncates a title whose first line is 21 characters with an ellipsis (boundary)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const twentyOneChars = 'い'.repeat(21);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: twentyOneChars, createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      const truncated = `${'い'.repeat(20)}…`;
      expect(await screen.findByText(truncated)).toBeTruthy();
      expect(screen.queryByText(twentyOneChars)).toBeNull();
    });

    it('shows nothing in a day cell that has no diary entries', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('日記あり');

      // 日記が無い日のセルはタップ可能な要素(accessibilityRole="button")として描画されない
      // (=タイトルは何も表示されておらず、押せない)
      expect(screen.queryAllByRole('button')).toHaveLength(1);

      // 日記が無い日の日付セル自体は表示されているが、タップしても何も起きない
      const emptyDayCell = screen.getByText(String(dayWithoutEntry));
      fireEvent.press(emptyDayCell);
      expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull();
    });

    it('does nothing (does not open the modal) when tapping a day without any diary entries', async () => {
      const now = new Date();
      const { dayWithoutEntry } = pickTestDays(now);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(screen.getByText(String(dayWithoutEntry)));

      expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull();
    });

    it('opens a modal listing all diary entries for a tapped date, in chronological order', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の出来事', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の出来事', createdAt: isoAt(now, dayWithEntry, 12, 0) },
        { id: '3', text: '夜の出来事', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の出来事');

      // カレンダーセルには先頭の日記のタイトルのみが表示されているため、ここでは一意に取得できる
      fireEvent.press(screen.getByText('朝の出来事'));

      expect(await screen.findByText('昼の出来事')).toBeTruthy();
      expect(screen.getByText('夜の出来事')).toBeTruthy();
      // モーダル表示中は背後のカレンダーセルにも同じタイトルが残るため2箇所に表示される
      expect(screen.getAllByText('朝の出来事').length).toBeGreaterThanOrEqual(1);

      // 見出しに日付('YYYY年M月D日')が表示される
      expect(
        screen.getByText(`${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日`),
      ).toBeTruthy();

      // 時刻の昇順に並んでいる
      const texts = flattenTexts(screen.toJSON());
      expect(texts.indexOf('朝の出来事')).toBeLessThan(texts.indexOf('昼の出来事'));
      expect(texts.indexOf('昼の出来事')).toBeLessThan(texts.indexOf('夜の出来事'));
    });

    it("shows each entry's date/time in a locale-independent 'YYYY/MM/DD HH:mm' format regardless of the test environment's locale", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記本文', createdAt: isoAt(now, dayWithEntry, 9, 5) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('日記本文');

      fireEvent.press(screen.getByText('日記本文'));

      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(dayWithEntry).padStart(2, '0');
      expect(await screen.findByText(`${year}/${month}/${day} 09:05`)).toBeTruthy();
    });

    it('closes the modal when the close button is pressed', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記本文', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('日記本文');

      fireEvent.press(screen.getByText('日記本文'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));

      await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());
    });
  });

  describe('formatEntryDateTime のゼロパディング(境界値)', () => {
    // `Calendar` は current/initialDate を指定していないため、実行時点の実際の月を表示する。
    // `jest.useFakeTimers`でシステム時刻を差し替えても、`react-native-calendars`が内部で使う
    // `xdate`ライブラリはモジュール読み込み時にネイティブの`Date`をIIFEのクロージャに
    // 固定的に保持する実装になっており、後からのフェイクタイマーが反映されない
    // (実際に検証済み)。そのため「表示月そのもの」を差し替える必要があるうるう年・
    // 年またぎのようなケースは、この方式では決定的にテストできない。
    // 一方、日・時・分は実行時点の実際の月の範囲内であれば自由に選べるため、
    // それぞれ1桁の値でゼロパディングされることを検証する。
    // (期待値はformatEntryDateTime実装のpadStartをそのまま模倣せず、
    // 別ロジックのpadTwoで計算することで、実装と同じ勘違いをテスト側で
    // 見逃してしまうリスクを減らす)
    function padTwo(n: number): string {
      return n < 10 ? `0${n}` : `${n}`;
    }

    it('zero-pads a single-digit day of month (e.g. day 3 -> "03")', async () => {
      const now = new Date();
      const singleDigitDay = 3; // 実行月に関わらず必ず存在する日を選ぶ
      const storedEntries = [
        { id: '1', text: '日付一桁テスト', createdAt: isoAt(now, singleDigitDay, 9, 5) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('日付一桁テスト');

      fireEvent.press(screen.getByText('日付一桁テスト'));

      const expected = `${now.getFullYear()}/${padTwo(now.getMonth() + 1)}/${padTwo(singleDigitDay)} 09:05`;
      expect(await screen.findByText(expected)).toBeTruthy();
    });

    it('zero-pads midnight (00:00) for both the hour and the minute', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '真夜中テスト', createdAt: isoAt(now, dayWithEntry, 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('真夜中テスト');

      fireEvent.press(screen.getByText('真夜中テスト'));

      const expected = `${now.getFullYear()}/${padTwo(now.getMonth() + 1)}/${padTwo(dayWithEntry)} 00:00`;
      expect(await screen.findByText(expected)).toBeTruthy();
    });

    it("zero-pads the hour when it is a single digit but the minute is not (e.g. '09:30')", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '時刻一桁テスト', createdAt: isoAt(now, dayWithEntry, 9, 30) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('時刻一桁テスト');

      fireEvent.press(screen.getByText('時刻一桁テスト'));

      const expected = `${now.getFullYear()}/${padTwo(now.getMonth() + 1)}/${padTwo(dayWithEntry)} 09:30`;
      expect(await screen.findByText(expected)).toBeTruthy();
    });
  });
});
