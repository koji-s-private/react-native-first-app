import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import type { PropsWithChildren } from 'react';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/(tabs)/index';
import { TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID } from '@/components/tab-screen-container';
import { Colors } from '@/constants/theme';
import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';

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

  // `jest.mock`の巻き上げの都合によりファクトリ内で`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactForMock = require('react');

  // 本物の`useFocusEffect`(expo-router内部で`useNavigation()`を要求する)は、
  // このテストのようにNavigationContainer/expo-routerのコンテキスト無しで画面を
  // 単体レンダリングする環境では利用できないため、マウント時に一度だけ発火する
  // 簡易モックに差し替える。「タブに再フォーカスして読み込み直す」挙動を検証したい
  // テストでは、下の`persists diary entries...`と同様にunmount/再mountすることで、
  // このモックからも再度effectを発火させて模倣する。
  //
  // ただし、画面をアンマウントせずに保持したまま(=Reactのstateを保ったまま)
  // 再フォーカスだけを模したいテスト(Issue #39: isLoadingがfalseになった後は
  // 再フォーカスしてもtrueへ戻らないことの検証)向けに、現在マウント中の全effectを
  // 保持しておき、`__triggerRefocus()`で明示的に再発火できるようにしておく
  // (実際のexpo-routerには存在しないテスト専用のヘルパー)。
  const activeFocusEffects = new Set<() => void>();

  function useFocusEffect(effect: () => void) {
    ReactForMock.useEffect(() => {
      activeFocusEffects.add(effect);
      effect();
      return () => {
        activeFocusEffects.delete(effect);
      };
    }, [effect]);
  }

  function __triggerRefocus() {
    for (const effect of activeFocusEffects) {
      effect();
    }
  }

  return { Link, useFocusEffect, __triggerRefocus };
});

// `jest-expo` が自動生成する expo-crypto のモック(node_modules/expo-crypto/mocks/ExpoCrypto.ts)は
// `randomUUID()` が常に `undefined` を返す実装になっているため、ID一意性を検証するテストのために
// 呼び出しごとに異なる値を返す独自のモックに差し替える。
// また、日記の暗号化(utils/diary-encryption.ts)が鍵・nonceの生成に使う `getRandomBytes` も
// オートモックには存在しない(`TypeError: getRandomBytes is not a function`になる)ため、
// Node標準の`crypto`モジュールによる実際の乱数生成で代替する。
jest.mock('expo-crypto', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    randomUUID: jest.fn(),
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
  };
});

// `expo-secure-store`はjest-expoのオートモックだと`getItemAsync`が常に`undefined`を返し、
// 状態を永続化しない。そのままだと`getOrCreateEncryptionKey`が呼び出すたびに異なる鍵を
// 新規生成してしまい、保存→再読み込みの暗号化ラウンドトリップを検証できないため、
// インメモリでキーと値を保持する独自モックに差し替える。
// 保存成功時のハプティックフィードバック(Issue #55)を検証しやすくするため、
// jest-expoのオートモック(実際のネイティブモジュール呼び出しを模した薄いjest.fn())ではなく、
// 呼び出し引数を明示的にアサートしやすい独自モックに差し替える
// (他のexpo系モジュールと同様、`jest.mock`の巻き上げの都合によりファクトリ内は自己完結させる)。
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: 'success' },
}));

jest.mock('expo-secure-store', () => {
  let store: Record<string, string> = {};
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
    // テスト間で鍵の永続化状態を分離するためのヘルパー(実際のexpo-secure-storeには存在しない)
    __reset: () => {
      store = {};
    },
  };
});

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
const mockNotificationAsync = Haptics.notificationAsync as jest.Mock;
// 上で定義した`__reset`にアクセスするための型付け直し
const secureStoreMock = SecureStore as unknown as { __reset: () => void };
// 上で定義した`expo-router`モックの`__triggerRefocus`にアクセスするための型付け直し
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __triggerRefocus: triggerRefocus } = require('expo-router') as {
  __triggerRefocus: () => void;
};

const STORAGE_KEY = 'diary-entries';
const ENCRYPTED_PREFIX = 'encrypted:v1:';
const INPUT_PLACEHOLDER = '今日の出来事や気持ちを書いてみましょう';
const CLOSE_BUTTON_TEXT = '閉じる';
// 日記が0件のときにカレンダーの上に表示される案内メッセージ
const EMPTY_STATE_TEXT = 'まだ日記がありません。最初の日記を書いてみましょう。';
const KEYBOARD_AVOIDING_VIEW_TEST_ID = 'keyboard-avoiding-view';

// AsyncStorageに実際に永続化された値(暗号化済み文字列)を、テストで検証しやすいよう
// 復号してJSONとしてパースするヘルパー。`getOrCreateEncryptionKey`は
// SecureStoreモックに永続化された鍵をそのまま返すため、画面側が使った鍵と同じ鍵が得られる。
async function decryptPersistedEntries(encryptedValue: string): Promise<unknown> {
  const key = await getOrCreateEncryptionKey();
  return JSON.parse(decryptText(encryptedValue, key));
}

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

// pickTestDays と同じ10〜20日の「はみ出しと重複しない」範囲の中から、実行時点の「今日」とは
// 異なる日を1つ選ぶ。「今日」バッジのセル(todayBadgeスタイル)と通常のセルを区別して検証したいため、
// 意図せず両者が同じ日になってしまうことを避ける。
// 10〜20日の11通りのうち「今日」と一致するのは高々1通りなので、必ず1つは見つかる。
function pickNonTodayDayInRange(now: Date): number {
  const today = now.getDate();
  for (let day = 10; day <= 20; day += 1) {
    if (day !== today) {
      return day;
    }
  }
  // 10〜20日は11通りあるため、ここには到達しない
  return 10;
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
    secureStoreMock.__reset();
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

  // Issue #125: セーフエリア対応は共通コンポーネント`TabScreenContainer`に一本化されたため、
  // タイトル自身の`marginTop`は常にベース余白(8)固定になり、インセットの加算は
  // `TabScreenContainer`の外側ラッパーの`paddingTop`側で行われる。
  it('keeps the title margin at the fixed base value regardless of the safe area top inset (spacing is handled by TabScreenContainer)', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    const title = screen.getByText('日記');
    const flattenedStyle = StyleSheet.flatten(title.props.style);

    expect(flattenedStyle.marginTop).toBe(8);
  });

  it('does not add extra top padding via TabScreenContainer when the safe area top inset is zero (e.g. Android without a notch)', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

    const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
    const flattenedStyle = StyleSheet.flatten(safeAreaWrapper.props.style);

    expect(flattenedStyle.paddingTop).toBe(0);
  });

  it('adds the safe area top inset as paddingTop on TabScreenContainer so content does not overlap the status bar/notch/Dynamic Island', async () => {
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

    const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
    const flattenedStyle = StyleSheet.flatten(safeAreaWrapper.props.style);

    // paddingTopがセーフエリアの上端インセット(59)そのものになる。タイトル自体の
    // marginTop(8)と合わせて、リファクタ前と同じ合計の上端余白(59 + 8)を維持する
    expect(flattenedStyle.paddingTop).toBe(59);

    const title = screen.getByText('日記');
    expect(StyleSheet.flatten(title.props.style).marginTop).toBe(8);
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

    it('allows saving when the text length is exactly at the max length (boundary), and persists it encrypted (not as plain JSON)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      const exactlyMaxLength = 'あ'.repeat(1000);
      fireEvent.changeText(input, exactlyMaxLength);
      expect(screen.getByText('1000/1000')).toBeTruthy();

      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];

      // AsyncStorageには平文JSONではなく、暗号化済みの文字列が保存される
      expect(typeof value).toBe('string');
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);
      expect(() => JSON.parse(value)).toThrow();

      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
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
      expect(StyleSheet.flatten(counterBelowLimit.props.style).color).not.toBe(Colors.light.error);

      // 上限ちょうど(1000文字)では、テーマ定数化されたエラー色(Colors.light.error)で強調される
      fireEvent.changeText(input, 'あ'.repeat(1000));
      const counterAtLimit = screen.getByText('1000/1000');
      expect(StyleSheet.flatten(counterAtLimit.props.style).color).toBe(Colors.light.error);
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

    it('renders the save button at reduced opacity (0.5) while the input is empty, and at full opacity (1) once text is entered, so the disabled state is also visible (正常系/境界値, Issue #42)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '何か書く');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(1);

      // 入力欄を再び空に戻すと、半透明表示にも戻る
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);
    });

    it('keeps the save button at reduced opacity (0.5) when the input contains only whitespace, matching the disabled condition (異常系, Issue #42)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');

      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);
    });

    it('keeps the save button at reduced opacity (0.5) while a save is in flight (isSaving), even once the user has typed a new non-empty draft, and restores full opacity once the save completes (境界値: isSaving overrides draft content in the opacity condition, Issue #42)', async () => {
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      const saveButton = screen.getByText('保存').parent?.parent?.parent;

      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // pending中(isSaving=true)にユーザーが新しい非空の下書きを入力しても、
      // isSavingがtrueである限りボタンは半透明のまま(disabled={!draft.trim() || isSaving}と対応)
      fireEvent.changeText(input, '書きかけの新しい下書き');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);

      resolveSetItem();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // isSavingがfalseに戻ると、非空の下書きが残っているため通常の不透明度に戻る
      await waitFor(() => expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(1));
    });

    it('restores previously saved plaintext entries (from before encryption was introduced) from AsyncStorage and shows them when the day is tapped', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '2件目の日記', createdAt: isoAt(now, dayWithEntry, 20, 0) },
        { id: '2', text: '1件目の日記', createdAt: isoAt(now, dayWithEntry, 8, 0) },
      ];
      // 暗号化対応前に保存された想定の平文JSONをそのままAsyncStorageに書き込む
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

    it('migrates plaintext entries to encrypted storage the next time an entry is saved', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      // 暗号化対応前に保存された想定の平文JSON
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('過去の日記');

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [key, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(key).toBe(STORAGE_KEY);

      // 保存後は平文だったデータも含めて暗号化形式で書き戻される(後方互換マイグレーション)
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
      expect(persisted).toHaveLength(2);
      expect(persisted.some((entry) => entry.text === '今日の日記')).toBe(true);
      expect(persisted.some((entry) => entry.text === '過去の日記')).toBe(true);

      // セルのタイトルは変わらず一番早い時刻の「過去の日記」のまま
      expect(screen.getByText('過去の日記')).toBeTruthy();
      expect(screen.queryByText('今日の日記')).toBeNull();

      // タップするとその日の一覧に新しい日記も含めて表示される
      fireEvent.press(screen.getAllByText('過去の日記')[0]);
      expect(await screen.findByText('今日の日記')).toBeTruthy();
      expect(screen.getAllByText('過去の日記').length).toBeGreaterThanOrEqual(1);
    });

    it('persists diary entries encrypted and correctly reloads/decrypts them after remounting (simulating an app restart)', async () => {
      const { unmount } = render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '再起動後も読める日記');
      fireEvent.press(screen.getByText('保存'));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      const [, storedValue] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect((storedValue as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      // アプリの再起動を模して画面をアンマウントし、新しいインスタンスとして再度マウントする。
      // SecureStoreモックの鍵は永続化されたままなので、暗号化データを正しく復号できるはず。
      unmount();

      render(<HomeScreen />);
      expect(await screen.findByText('再起動後も読める日記')).toBeTruthy();
    });

    it('reloads from AsyncStorage when the screen regains focus, so data deleted elsewhere (e.g. from the settings tab) is not resurrected by a later save (regression for Issue #103 tab state bug)', async () => {
      const now = new Date();
      const key = await getOrCreateEncryptionKey();
      const storedEntries = [
        { id: 'old', text: '削除されるはずの日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(storedEntries), key));

      // 日記タブを開いて表示する(expo-routerのTabsは実機ではこの画面をアンマウントしないが、
      // このテストのモックではフォーカス再取得を模すために一度unmountし、下で再度renderする)
      const { unmount } = render(<HomeScreen />);
      await screen.findByText('削除されるはずの日記');
      unmount();

      // 設定タブでの「日記データを全件削除」操作を模して、AsyncStorageを直接空にする
      await AsyncStorage.removeItem(STORAGE_KEY);

      // 日記タブに戻ってくる(再フォーカス)と、保持していたstateではなくAsyncStorageを読み直す
      render(<HomeScreen />);
      await waitFor(() => expect(screen.queryByText('削除されるはずの日記')).toBeNull());
      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();

      // 新しい日記を保存しても、stateに残っていた削除済みの古いエントリが復活しない
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '新しい日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const [, value] = setItemMock.mock.calls[setItemMock.mock.calls.length - 1];
      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].text).toBe('新しい日記');
    });

    it('saves a new entry, persists it to AsyncStorage encrypted, and shows it together with an existing entry for the same day', async () => {
      const now = new Date();
      const key = await getOrCreateEncryptionKey();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      // すでに暗号化されている状態を想定してAsyncStorageに直接書き込む
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(storedEntries), key));
      jest.clearAllMocks();

      render(<HomeScreen />);
      // 保存前は既存の1件目のタイトルがその日のセルに表示されている
      await screen.findByText('過去の日記');

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [savedKey, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(savedKey).toBe(STORAGE_KEY);

      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
      expect(persisted).toHaveLength(2);
      expect(persisted.some((entry) => entry.text === '今日の日記')).toBe(true);
      expect(persisted.some((entry) => entry.text === '過去の日記')).toBe(true);

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

    it('shows the empty state when stored data has the encrypted-payload marker but fails to decrypt (corrupted ciphertext)', async () => {
      jest
        .spyOn(AsyncStorage, 'getItem')
        .mockResolvedValueOnce(`${ENCRYPTED_PREFIX}not-a-real-ciphertext`);

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 復号に失敗したデータは読み捨てられ、空の状態から始まるためカレンダーに操作可能なセルは無い
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

      const errorMessage = await screen.findByText('保存に失敗しました。もう一度お試しください。');
      expect(errorMessage).toBeTruthy();
      // エラーメッセージの文字色は、ハードコードではなくテーマ定数化されたColors.light.errorを使う(Issue #58)
      expect(StyleSheet.flatten(errorMessage.props.style).color).toBe(Colors.light.error);

      // 保存前の状態にロールバックされているため、新しい日記のタイトルはどこにも表示されない
      expect(screen.queryByText('今日の日記')).toBeNull();
      expect(input.props.value).toBe('今日の日記');
      expect(screen.getByText('過去の日記')).toBeTruthy();

      // モーダルを開いても新しい日記は含まれず、既存の1件のみが表示される
      fireEvent.press(screen.getByText('過去の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      expect(screen.queryByText('今日の日記')).toBeNull();
    });

    it('does not overwrite draft text the user typed while a save was still in flight, when that save later fails', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      // AsyncStorage.setItemの解決/拒否を保存処理の呼び出し側から任意のタイミングで
      // 制御できるようにするため、resolve/reject関数を外側に取り出しておく
      let rejectSetItem: (reason: unknown) => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSetItem = reject;
          }),
      );

      render(<HomeScreen />);
      await screen.findByText('過去の日記');

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      // 保存(AsyncStorage.setItem)がまだpendingの間に、入力欄は一旦空になる
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始める
      fireEvent.changeText(input, '書きかけの新しい下書き');

      // ここで保存が失敗する
      rejectSetItem(new Error('write failed'));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();

      // ロールバックによって「保存前のdraft(保存中の日記)」で上書きされず、
      // ユーザーが新しく入力した内容がそのまま保持される
      expect(input.props.value).toBe('書きかけの新しい下書き');
      expect(screen.queryByText('保存中の日記')).toBeNull();
    });

    it('keeps the draft empty (does not roll back) when the user typed something while a save was in flight and then deleted it all themselves, and that save later fails (regression for Issue #110)', async () => {
      // pending中に一度何か入力したあと、ユーザー自身がそれを全部消して空文字列に戻した場合は
      // 「何も入力していない」ケースと区別し、ロールバックでpreviousDraftを復活させてはいけない
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      let rejectSetItem: (reason: unknown) => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSetItem = reject;
          }),
      );

      render(<HomeScreen />);
      await screen.findByText('過去の日記');

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始めるが、自分で全部消して空文字列に戻す
      fireEvent.changeText(input, '書きかけの新しい下書き');
      fireEvent.changeText(input, '');

      // ここで保存が失敗する
      rejectSetItem(new Error('write failed'));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();

      // ユーザーが意図的に空にした結果なので、previousDraft(保存中の日記)へロールバックされず
      // 空文字列のまま維持される
      expect(input.props.value).toBe('');
      expect(screen.queryByText('保存中の日記')).toBeNull();
    });

    it('does not clear draft text the user typed while a save was still in flight, when that save later succeeds (boundary)', async () => {
      // 失敗時だけでなく成功時も、保存処理中(pending中)に入力された下書きが
      // 意図せず消されないことを確認する(catch節以外の経路でdraftが上書きされないことの確認)
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await screen.findByText('過去の日記');

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始める
      fireEvent.changeText(input, '書きかけの新しい下書き');

      // ここで保存が成功する
      resolveSetItem();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 送信した「保存中の日記」自体は正しく永続化される(ただし過去の日記の方が時刻が早いため、
      // カレンダーセルのタイトルは引き続き「過去の日記」のまま)
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
      expect(persisted.some((entry) => entry.text === '保存中の日記')).toBe(true);

      // 成功パスはcatch節を通らずdraftに触れないため、ユーザーが新しく入力した内容が
      // そのまま保持され、エラーメッセージも表示されない
      expect(input.props.value).toBe('書きかけの新しい下書き');
      expect(screen.queryByText('保存に失敗しました。もう一度お試しください。')).toBeNull();
    });

    it('ignores a second press of the save button while a save is still in flight, preventing a duplicate entry (Issue #70)', async () => {
      // 保存ボタンの連打(タップと同時に発生する複数のonPressイベントを含む)によって
      // 同一内容の日記が重複保存されないことを確認する。AsyncStorage.setItemの解決を
      // 意図的に遅延させ、その完了前に2回目のpressを発火させる
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      const saveButton = screen.getByText('保存');

      fireEvent.changeText(input, '連打される日記');
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 1回目の保存(AsyncStorage.setItem)がまだpendingの間に、続けて保存ボタンを連打する
      fireEvent.press(saveButton);
      fireEvent.press(saveButton);

      // pending中の連打はガードされ、AsyncStorage.setItemは追加で呼ばれない
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect(mockRandomUUID).toHaveBeenCalledTimes(1);

      resolveSetItem();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 永続化された内容にも1件のみ含まれ、重複していない
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntries(value)) as { text: string }[];
      expect(persisted).toHaveLength(1);

      // pending解消後は再度保存できる(実行中フラグが正しく戻っている)
      fireEvent.changeText(input, '次の日記');
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2));
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
      const persisted = (await decryptPersistedEntries(lastCall[1])) as { id: string }[];

      expect(persisted).toHaveLength(3);
      const ids = persisted.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);

      // 同じ日に書かれた3件すべてが、セルをタップした一覧に表示される
      // (セルには最初に書かれた「1件目」のタイトルのみが表示される)
      expect(screen.getByText('1件目')).toBeTruthy();
      fireEvent.press(screen.getByText('1件目'));
      expect(await screen.findByText('2件目')).toBeTruthy();
      expect(screen.getByText('3件目')).toBeTruthy();
    });
  });

  describe('保存成功時のフィードバック(Issue #55)', () => {
    // 実装(`app/(tabs)/index.tsx`)はハプティックを`process.env.EXPO_OS === 'ios'`の条件下でのみ
    // 発火させるが、`process.env.EXPO_OS`はbabel-preset-expo(jest-expoのデフォルト設定では
    // `platform: 'ios'`固定)によってビルド時にリテラル値へインライン化されるため、
    // テスト実行中に`process.env.EXPO_OS`を書き換えても実装側の分岐には反映されない
    // (jest-expo/jest-preset.jsのbabelOpts参照)。そのため、iOS向けにインライン化された
    // 状態(=常にiOS相当として振る舞う)でのハプティック発火のみを検証する。
    it('shows a toast with a success message, exposed via accessibilityLiveRegion="polite", after a successful save', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(screen.queryByText('保存しました')).toBeNull();

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '通知確認用の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());

      const toastMessage = await screen.findByText('保存しました');
      expect(toastMessage).toBeTruthy();
      const toast = screen.getByTestId('save-toast');
      expect(toast.props.accessibilityLiveRegion).toBe('polite');
    });

    it('automatically hides the success toast after a few seconds', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '自動的に消える日記');
        fireEvent.press(screen.getByText('保存'));

        await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
        expect(await screen.findByText('保存しました')).toBeTruthy();

        act(() => {
          jest.advanceTimersByTime(3000);
        });

        await waitFor(() => expect(screen.queryByText('保存しました')).toBeNull());
      } finally {
        jest.useRealTimers();
      }
    });

    it('still hides the toast after ~2.5s even if the user keeps editing the input while it is shown (regression: onHide must be a stable callback, not recreated on every render)', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        fireEvent.changeText(input, '自動的に消えるはずの日記');
        fireEvent.press(screen.getByText('保存'));

        await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
        expect(await screen.findByText('保存しました')).toBeTruthy();

        // トースト表示中に、ユーザーが次の日記の入力を続ける(=onChangeTextのたびにHomeScreenが
        // 再レンダーされる)。onHideが毎レンダーで再生成される実装だと、SaveToast側の
        // useEffect(依存配列に[message, onHide])が再実行され続け、自動非表示タイマーが
        // 都度張り直されてしまう(最初の表示から2.5秒経っても消えない)。
        act(() => {
          jest.advanceTimersByTime(1000);
        });
        fireEvent.changeText(input, '続');
        act(() => {
          jest.advanceTimersByTime(1000);
        });
        fireEvent.changeText(input, '続けて入力中');

        // 最初にトーストが表示されてから合計2.5秒経過した時点(トースト表示中の編集を挟んでも)
        // で自動的に消えることを確認する
        act(() => {
          jest.advanceTimersByTime(600);
        });

        await waitFor(() => expect(screen.queryByText('保存しました')).toBeNull());
      } finally {
        jest.useRealTimers();
      }
    });

    it('hides the toast ~2.5s after it was first shown, even if the user saves another entry (without dismissing it first) while it is still visible', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);

        // 1件目を保存し、トーストを表示させる
        fireEvent.changeText(input, '1件目の日記');
        fireEvent.press(screen.getByText('保存'));
        await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
        expect(await screen.findByText('保存しました')).toBeTruthy();

        // トーストがまだ消えていない(2.5秒経過前の)タイミングで、消さずに続けて2件目を保存する
        // (このアプリの保存成功メッセージは常に固定文言のため、setSaveToastMessageに渡す値自体は
        // 変わらないが、保存に伴うHomeScreenの再レンダー自体は発生する)
        act(() => {
          jest.advanceTimersByTime(1000);
        });
        fireEvent.changeText(input, '2件目の日記');
        fireEvent.press(screen.getByText('保存'));
        await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2));
        expect(screen.getByText('保存しました')).toBeTruthy();

        // 最初にトーストが表示されてから合計2.5秒経過した時点で、2件目の保存を挟んでいても
        // 意図通り自動的に消える(onHideが安定した参照であるため、保存に伴う再レンダーで
        // タイマーが余計に張り直されない)
        act(() => {
          jest.advanceTimersByTime(1600);
        });
        await waitFor(() => expect(screen.queryByText('保存しました')).toBeNull());
      } finally {
        jest.useRealTimers();
      }
    });

    it('triggers a success haptic notification (Haptics.notificationAsync) after a successful save', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), 'ハプティック確認用');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockNotificationAsync).toHaveBeenCalledWith(
          Haptics.NotificationFeedbackType.Success,
        ),
      );
    });

    it('does not show the success toast or trigger a haptic notification when the save fails', async () => {
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '失敗するはずの日記');
      fireEvent.press(screen.getByText('保存'));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();
      expect(screen.queryByText('保存しました')).toBeNull();
      expect(mockNotificationAsync).not.toHaveBeenCalled();
    });
  });

  describe('空状態(日記が0件)の案内メッセージ', () => {
    // Issue #39: 初回読み込み中(AsyncStorage.getItemがまだ解決していない間)は、
    // entriesの初期値が空配列であることに起因して空状態メッセージが一瞬誤って
    // 表示されてしまわないよう、代わりにローディング表示(ActivityIndicator)を出す。
    it('shows a loading indicator instead of the empty state message before the async AsyncStorage load resolves (regression for Issue #39: prevents the empty state from flashing)', async () => {
      // AsyncStorage.getItemの解決タイミングを呼び出し側から制御できるようにし、
      // 読み込みが完了する前の状態を確実に検証できるようにする
      let resolveGetItem: (value: string | null) => void = () => {};
      jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 読み込みが完了するまでの間は、空状態メッセージの代わりにローディング表示が出る
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);

      // カレンダー自体は読み込み中でも常に表示され続ける(曜日ヘッダーの存在で確認する)
      expect(screen.getByText('日', { includeHiddenElements: true })).toBeTruthy();

      // 読み込みを完了させ、テスト終了後にact()の外側でstate更新が起きないようにする(Issue #128)
      await act(async () => {
        resolveGetItem(null);
      });
    });

    it('hides the loading indicator and shows the empty state message once the async load resolves with no stored entries', async () => {
      let resolveGetItem: (value: string | null) => void = () => {};
      jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);

      await act(async () => {
        resolveGetItem(null);
      });

      // 読み込み完了後はローディング表示が消え、代わりに空状態メッセージが表示される
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();
    });

    it('shows neither the loading indicator nor the empty state message once the async load resolves with existing entries', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      expect(await screen.findByText('既存の日記')).toBeTruthy();
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    });

    // Issue #39: isLoadingは初回読み込み完了時にfalseへ遷移した後は二度とtrueへ戻らない仕様。
    // useFocusEffectによりタブへ再フォーカスするたびにloadEntriesは再実行されるが、
    // その都度ローディング表示がちらつかないことを確認する
    // (expo-routerのuseFocusEffectモックはマウント時に一度だけ発火するため、
    // 再フォーカスはunmount/再mountすることで模す。既存の同種のテストと同じ手法)。
    it('does not show the loading indicator again on a subsequent focus refetch (regression for Issue #39: isLoading only ever transitions true -> false, never back to true)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      // 1回目のフォーカス(初回マウント)。ここで画面はアンマウントせず、そのまま
      // Reactのstate(isLoading)を保持し続ける(実機のexpo-router Tabsが
      // タブ画面をアンマウントしないのと同じ状況を再現する)
      render(<HomeScreen />);
      expect(await screen.findByText('既存の日記')).toBeTruthy();
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);

      // 2回目の読み込み(再フォーカス時)がまだpending中の間の表示を検証できるようにする
      let resolveGetItem: (value: string | null) => void = () => {};
      jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGetItem = resolve;
          }),
      );

      // 画面をアンマウントせずに、タブへの再フォーカス(useFocusEffectの再実行)のみを模す
      act(() => {
        (triggerRefocus as () => void)();
      });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledTimes(2));

      // isLoadingは既にfalseのまま維持されるため、読み込みがまだpending中でも
      // ローディング表示は再度出ない(空状態メッセージも、既存のentriesがまだ残っているため出ない)
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
      expect(screen.getByText('既存の日記')).toBeTruthy();

      await act(async () => {
        resolveGetItem(JSON.stringify([]));
      });
    });

    it('keeps showing the empty state message after the async load resolves with no stored entries', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();
    });

    it('hides the empty state message once at least one diary entry is loaded from storage (regression check)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      expect(await screen.findByText('既存の日記')).toBeTruthy();
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    });

    it('hides the empty state message as soon as the first diary entry is saved', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '最初の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    });

    it('shows the empty state message again when stored data is corrupted (invalid JSON) and falls back to an empty list (boundary)', async () => {
      jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not valid json');

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 壊れたデータは読み捨てられ空の状態に戻るため、案内メッセージが表示される
      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();
    });

    it('shows the empty state message when the encrypted payload fails to decrypt (corrupted ciphertext, boundary)', async () => {
      jest
        .spyOn(AsyncStorage, 'getItem')
        .mockResolvedValueOnce(`${ENCRYPTED_PREFIX}not-a-real-ciphertext`);

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 復号に失敗したデータも読み捨てられ空の状態に戻るため、案内メッセージが表示される
      expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();
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

    it('does not split a surrogate-pair emoji in the middle when truncating (regression: Issue #71)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      // '😀'はサロゲートペア(UTF-16で2コードユニット)で表現される絵文字。
      // 19文字の通常文字 + 絵文字1つ(見た目上20文字)+ 文字化けを誘発しやすい末尾の文字、
      // という構成で、単純なUTF-16コードユニット単位のslice(0, 20)だと絵文字の
      // 途中(サロゲートの片割れ)で切れてしまう境界を狙う
      const text = `${'あ'.repeat(19)}😀切れたら文字化け`;
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text, createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      // 絵文字がサロゲートペアの片割れで壊れず、丸ごと1文字として20文字目に含まれる
      const truncated = `${'あ'.repeat(19)}😀…`;
      expect(await screen.findByText(truncated)).toBeTruthy();
    });

    it('does not split a ZWJ-joined family emoji in the middle when truncating (regression: Issue #71)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      // '👨\u200d👩\u200d👧\u200d👦'(家族)はZWJ(Zero Width Joiner)で複数の絵文字コードポイントを
      // 結合した単一の書記素クラスタ。サロゲートペアのみを考慮するArray.from()による
      // コードポイント単位の分割だと、ZWJや個別の絵文字コードポイントの境目で
      // 途中が分断されてしまう(Intl.Segmenterのgrapheme単位分割でのみ正しく1文字として扱える)
      const family = '👨\u200d👩\u200d👧\u200d👦';
      const text = `${'う'.repeat(19)}${family}途中で切れたら文字化け`;
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text, createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      // ZWJ結合絵文字が途中で壊れず、丸ごと1文字(書記素クラスタ)として20文字目に含まれる
      const truncated = `${'う'.repeat(19)}${family}…`;
      expect(await screen.findByText(truncated)).toBeTruthy();
    });

    it('shows a very short (1 character) diary entry as its title as-is, without truncation or an ellipsis (boundary)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: 'あ', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);

      expect(await screen.findByText('あ')).toBeTruthy();
      expect(screen.queryByText('あ…')).toBeNull();
    });

    it('renders no title (and disables the cell) for an entry whose text is an empty string after the first line is trimmed (defensive boundary for directly-corrupted/legacy storage data, since the composer itself never saves an empty/whitespace-only entry)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '   ', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // タイトルが空文字列になるため、そのセルはタップ可能な要素として描画されない
      expect(screen.queryAllByRole('button')).toHaveLength(0);
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

    it('sets statusBarTranslucent and navigationBarTranslucent on both the entry-list modal and the edit modal, so they match the edge-to-edge display of the screen behind them (Issue #94)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 日付タップ時の一覧モーダルと編集モーダルの2つが常にツリーに存在する
      // (visibleプロパティで表示/非表示を切り替えているだけで、条件付きレンダリングではないため)
      const modals = screen.UNSAFE_getAllByType(Modal);
      expect(modals).toHaveLength(2);
      for (const modal of modals) {
        expect(modal.props.statusBarTranslucent).toBe(true);
        expect(modal.props.navigationBarTranslucent).toBe(true);
      }
    });

    it('keeps statusBarTranslucent and navigationBarTranslucent set to true on each modal even while it is actually open (visible=true), not just at rest (regression for Issue #94)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集対象の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('編集対象の日記');

      // 日付タップ前は両モーダルとも非表示(visible=false)だが、translucent系のpropは
      // 表示状態に関わらず常に設定されている静的なpropである
      const [entryListModalBeforeOpen, editModalBeforeOpen] = screen.UNSAFE_getAllByType(Modal);
      expect(entryListModalBeforeOpen.props.visible).toBe(false);
      expect(editModalBeforeOpen.props.visible).toBe(false);

      // 一覧モーダルを開いた状態(visible=true)でも維持されていることを確認する
      fireEvent.press(screen.getByText('編集対象の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      const [entryListModalOpen, editModalStillClosed] = screen.UNSAFE_getAllByType(Modal);
      expect(entryListModalOpen.props.visible).toBe(true);
      expect(entryListModalOpen.props.statusBarTranslucent).toBe(true);
      expect(entryListModalOpen.props.navigationBarTranslucent).toBe(true);
      expect(editModalStillClosed.props.visible).toBe(false);
      expect(editModalStillClosed.props.statusBarTranslucent).toBe(true);
      expect(editModalStillClosed.props.navigationBarTranslucent).toBe(true);

      // 続けて編集モーダルを開いた状態(visible=true)でも維持されていることを確認する
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const [entryListModalStillOpen, editModalOpen] = screen.UNSAFE_getAllByType(Modal);
      expect(entryListModalStillOpen.props.visible).toBe(true);
      expect(editModalOpen.props.visible).toBe(true);
      expect(editModalOpen.props.statusBarTranslucent).toBe(true);
      expect(editModalOpen.props.navigationBarTranslucent).toBe(true);
    });
  });

  describe('日付セルのフォント拡大率の上限(maxFontSizeMultiplier)', () => {
    // OSの文字サイズ設定(アクセシビリティのフォント拡大・Dynamic Type)を拡大しても、
    // 日付セル内のテキスト(日付番号・日記タイトル)が際限なく拡大されて最下段の週が
    // 見切れてしまわないよう、`maxFontSizeMultiplier`で拡大率の上限が指定されていることを検証する。
    // react-native-calendars自体の月見出し・曜日行はライブラリ内部で常に
    // `allowFontScaling={false}`が指定されており対象外のため、ここでは検証しない。
    const EXPECTED_MAX_FONT_SCALE = 1.5;

    it('caps the font scale multiplier at a value greater than 1 but not unbounded (sanity check on the constant itself)', () => {
      // 実装側の定数はモジュール外にexportされていないため、直接importはできないが、
      // 「等倍(1)ではなく拡大を許容しつつも、無制限ではない妥当な値」であることは
      // 以下の各テストで実際にレンダリングされるpropsの値として確認できる。
      // ここではその期待値自体が1(拡大を許さない)や極端に大きい値(実質無制限)ではないことを明記する。
      expect(EXPECTED_MAX_FONT_SCALE).toBeGreaterThan(1);
      expect(EXPECTED_MAX_FONT_SCALE).toBeLessThanOrEqual(2);
    });

    it("sets maxFontSizeMultiplier on a regular (non-today) day cell's day number", async () => {
      const now = new Date();
      const day = pickNonTodayDayInRange(now);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const dayNumber = screen.getByText(String(day));
      expect(dayNumber.props.maxFontSizeMultiplier).toBe(EXPECTED_MAX_FONT_SCALE);
    });

    it("sets maxFontSizeMultiplier on today's badge day number", async () => {
      const now = new Date();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 月初/月末の「はみ出し」表示で前後の月にも同じ日付番号が重複することがあるため、
      // 今日バッジ特有のスタイル(丸背景に合わせた太字)を持つものだけを絞り込む
      const candidates = screen.getAllByText(String(now.getDate()));
      const todayNumber = candidates.find((node) => {
        const flattenedStyle = StyleSheet.flatten(node.props.style);
        return flattenedStyle.fontWeight === '700';
      });

      expect(todayNumber).toBeTruthy();
      expect(todayNumber?.props.maxFontSizeMultiplier).toBe(EXPECTED_MAX_FONT_SCALE);
    });

    it('sets maxFontSizeMultiplier on the diary title shown inside a day cell', async () => {
      const now = new Date();
      const day = pickNonTodayDayInRange(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: 'フォント拡大確認用の日記', createdAt: isoAt(now, day) }]),
      );

      render(<HomeScreen />);

      const title = await screen.findByText('フォント拡大確認用の日記');
      expect(title.props.maxFontSizeMultiplier).toBe(EXPECTED_MAX_FONT_SCALE);
    });

    it('still shows the day number and diary title as before (regression check: adding maxFontSizeMultiplier does not change rendered content)', async () => {
      const now = new Date();
      const day = pickNonTodayDayInRange(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '回帰確認用の日記', createdAt: isoAt(now, day) }]),
      );

      render(<HomeScreen />);

      expect(await screen.findByText('回帰確認用の日記')).toBeTruthy();
      expect(screen.getByText(String(day))).toBeTruthy();
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

  describe('日記エントリの編集(Issue #33)', () => {
    // 編集モーダルの保存ボタンは、メインの入力欄(composer)の保存ボタンと同じ文言「保存」を使うため、
    // `getByText('保存')`だと2件ヒットしてしまう。JSXの描画順(composerの保存ボタンが先、
    // 編集モーダルの保存ボタンが後)に依存して2件目を編集モーダル側として取得する。
    function getEditSaveButton() {
      const saveButtons = screen.getAllByText('保存');
      expect(saveButtons).toHaveLength(2);
      return saveButtons[1];
    }

    it('opens the edit modal with the existing text prefilled when the edit button is pressed (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('編集'));

      expect(await screen.findByText('日記を編集')).toBeTruthy();
      // 既存の本文が編集用の入力欄にそのまま表示されている
      expect(screen.getByDisplayValue('編集前の日記')).toBeTruthy();
    });

    it('closes the edit modal without saving when its close button is pressed', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '編集キャンセル対象', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('編集キャンセル対象');
      fireEvent.press(screen.getByText('編集キャンセル対象'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      // 編集モーダル自身の「閉じる」ボタンを押す(日付一覧モーダルとは別の閉じるボタン)
      const closeButtons = screen.getAllByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(closeButtons[closeButtons.length - 1]);

      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull());
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      // 変更されずに元のテキストのまま残っている
      expect(screen.getAllByText('編集キャンセル対象').length).toBeGreaterThanOrEqual(1);
    });

    it('updates the entry text (keeping createdAt unchanged), refreshes the list, and persists it encrypted when the edit is saved (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const createdAt = isoAt(now, dayWithEntry, 9, 0);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt }]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '編集後の日記');
      fireEvent.press(getEditSaveButton());

      // 保存(AsyncStorageへの暗号化書き込み)が呼ばれる
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [savedKey, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(savedKey).toBe(STORAGE_KEY);
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      // 保存が成功すると編集モーダルは閉じ、一覧・カレンダーセルの表示が更新される
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull());
      expect(screen.queryByText('編集前の日記')).toBeNull();
      expect(screen.getAllByText('編集後の日記').length).toBeGreaterThanOrEqual(1);

      // 永続化された内容もtextのみ更新され、createdAtは変わらない
      const persisted = (await decryptPersistedEntries(value)) as {
        id: string;
        text: string;
        createdAt: string;
      }[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe('1');
      expect(persisted[0].text).toBe('編集後の日記');
      expect(persisted[0].createdAt).toBe(createdAt);
    });

    it('does not save and disables the save button when the edited text is emptied out (defense in depth)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '空にされる日記', createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('空にされる日記');
      fireEvent.press(screen.getByText('空にされる日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('空にされる日記');
      fireEvent.changeText(editInput, '   ');
      fireEvent.press(getEditSaveButton());

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('renders the edit save button at full opacity (1) when opened with prefilled text (正常系), and reduces it to 0.5 once the text is cleared to whitespace only (異常系), matching disabled={!editDraft.trim()} (Issue #42)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editSaveButton = getEditSaveButton().parent?.parent?.parent;
      // 編集モーダルは既存の本文が入った状態で開くため、初期表示から通常の不透明度になる
      expect(StyleSheet.flatten(editSaveButton?.props.style).opacity).toBe(1);

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '   ');
      expect(StyleSheet.flatten(editSaveButton?.props.style).opacity).toBe(0.5);

      // 再度文字を入力すると通常の不透明度に戻る(境界値: 空⇔非空の切り替わり)
      fireEvent.changeText(editInput, '編集後の日記');
      expect(StyleSheet.flatten(editSaveButton?.props.style).opacity).toBe(1);
    });

    it('limits the edit input via maxLength to BODY_MAX_LENGTH (1000 characters, boundary)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '文字数上限確認用', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );

      render(<HomeScreen />);
      await screen.findByText('文字数上限確認用');
      fireEvent.press(screen.getByText('文字数上限確認用'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('文字数上限確認用');
      expect(editInput.props.maxLength).toBe(1000);
    });

    it('rolls back to the previous text and shows an error message when saving the edit fails (異常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '失敗するはずの編集');
      fireEvent.press(getEditSaveButton());

      const editErrorMessage =
        await screen.findByText('更新に失敗しました。もう一度お試しください。');
      expect(editErrorMessage).toBeTruthy();
      // 編集モーダルのエラーメッセージも、テーマ定数化されたColors.light.errorを使う(Issue #58)
      expect(StyleSheet.flatten(editErrorMessage.props.style).color).toBe(Colors.light.error);

      // ロールバックにより、一覧・カレンダーセルとも編集前のテキストのまま残る
      // (編集モーダルは開いたままで、失敗した入力内容自体は消えない)
      expect(screen.queryByText('失敗するはずの編集')).toBeNull();
      expect(screen.getAllByText('編集前の日記').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('日記を編集')).toBeTruthy();
    });
  });

  describe('日記エントリの削除(Issue #33)', () => {
    async function pressAlertButton(label: string) {
      const alertMock = Alert.alert as jest.Mock;
      const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
      const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
      const button = buttons.find((b) => b.text === label);
      expect(button).toBeDefined();
      await act(async () => {
        button?.onPress?.();
      });
    }

    it('shows a confirmation dialog (Alert.alert) with cancel/delete options when the delete button is pressed, without deleting yet (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '削除確認用の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<HomeScreen />);
      await screen.findByText('削除確認用の日記');
      fireEvent.press(screen.getByText('削除確認用の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      const deleteLink = screen.getByText('削除');
      // 削除リンクの文字色も、テーマ定数化されたColors.light.errorを使う(Issue #58)
      expect(StyleSheet.flatten(deleteLink.props.style).color).toBe(Colors.light.error);
      fireEvent.press(deleteLink);

      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      expect(title).toBe('日記を削除しますか?');
      expect(message).toBe('この操作は取り消せません。');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toMatchObject({ text: 'キャンセル', style: 'cancel' });
      expect(buttons[1]).toMatchObject({ text: '削除', style: 'destructive' });

      // ダイアログを表示しただけの段階では削除処理はまだ呼ばれていない
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(screen.getAllByText('削除確認用の日記').length).toBeGreaterThanOrEqual(1);
    });

    it('deletes only the targeted entry from the list and persists the change to AsyncStorage encrypted when "削除" is confirmed (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '残る日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '削除される日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<HomeScreen />);
      await screen.findByText('残る日記');
      fireEvent.press(screen.getByText('残る日記'));
      await screen.findByText('削除される日記');

      // 時刻昇順で描画されるため、2件目(削除される日記)の削除ボタンは配列の2番目
      const deleteButtons = screen.getAllByText('削除');
      expect(deleteButtons).toHaveLength(2);
      fireEvent.press(deleteButtons[1]);
      await pressAlertButton('削除');

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [savedKey, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(savedKey).toBe(STORAGE_KEY);
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      // 削除された方は一覧から消え、残る方はそのまま表示される
      expect(screen.queryByText('削除される日記')).toBeNull();
      expect(screen.getAllByText('残る日記').length).toBeGreaterThanOrEqual(1);

      const persisted = (await decryptPersistedEntries(value)) as { id: string; text: string }[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe('1');
      expect(persisted[0].text).toBe('残る日記');
    });

    it('does not delete the entry when "キャンセル" is chosen in the confirmation dialog (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: 'キャンセル対象の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<HomeScreen />);
      await screen.findByText('キャンセル対象の日記');
      fireEvent.press(screen.getByText('キャンセル対象の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('削除'));
      await pressAlertButton('キャンセル');

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(screen.getAllByText('キャンセル対象の日記').length).toBeGreaterThanOrEqual(1);
    });

    it('rolls back the deletion (keeps the entry visible) and does not crash when AsyncStorage.setItem fails during delete (異常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '削除失敗する日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await screen.findByText('削除失敗する日記');
      fireEvent.press(screen.getByText('削除失敗する日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('削除'));
      await pressAlertButton('削除');

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenLastCalledWith(
          '削除に失敗しました',
          'もう一度お試しください。',
        ),
      );

      // ロールバックにより、一覧・カレンダーセルとも元のエントリが残っている
      expect(screen.getAllByText('削除失敗する日記').length).toBeGreaterThanOrEqual(1);
    });

    it("removes the day's cell title from the calendar (entriesByDate) when the last remaining entry for that day is deleted (boundary)", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: 'その日最後の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<HomeScreen />);
      await screen.findByText('その日最後の日記');
      // 削除前は、タップ可能な(タイトル付きの)カレンダーセルが1つ存在する
      expect(screen.queryAllByRole('button')).toHaveLength(1);

      fireEvent.press(screen.getByText('その日最後の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('削除'));
      await pressAlertButton('削除');

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      // 一覧モーダルはまだ開いたままだが、日記自体はもう表示されない(entriesByDateから消えた)
      expect(screen.queryByText('その日最後の日記')).toBeNull();

      // モーダルを閉じると、カレンダー上にもタップ可能なセル(タイトル付き)が無くなっている
      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));
      await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('保存/編集/削除の書き込み直列化によるレースコンディション対策(Issue #130)', () => {
    // 日記エントリの削除(Issue #33)のdescribe内にある同名ヘルパーと同じ実装。
    // このdescribe単体でも複数の非同期操作を絡めたシナリオを組み立てやすくするため、
    // ここでも同じ内容のヘルパーをローカルに用意する。
    async function pressAlertButton(label: string) {
      const alertMock = Alert.alert as jest.Mock;
      const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
      const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
      const button = buttons.find((b) => b.text === label);
      expect(button).toBeDefined();
      await act(async () => {
        button?.onPress?.();
      });
    }

    it("persists both a delete of entry A and a concurrent edit of entry B, even though A's persistence write is still pending when B's edit save is requested (regression for Issue #130: without the write queue, A's later-completing write would overwrite B's edit with a stale snapshot)", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: 'a', text: 'Aの日記(削除される)', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: 'b', text: 'Bの日記(編集前)', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      // 1回目(Aの削除の永続化)と2回目(Bの編集の永続化)のsetItemの解決タイミングを
      // それぞれ個別に制御できるようにしておく。実際のストレージへの書き込み自体は
      // 呼び出し直前に捕まえておいた元の実装(spyOnで差し替える前のsetItem)経由で行い、
      // 「完了タイミングだけを遅延させる」ようにする(単に解決を遅らせるだけだと、
      // 実際のAsyncStorageへは書き込まれないまま次のタスクが読み直してしまい、
      // 直列化の検証にならないため)
      const originalSetItem = AsyncStorage.setItem;
      let resolveDeleteWrite: () => void = () => {};
      let resolveEditWrite: () => void = () => {};
      jest
        .spyOn(AsyncStorage, 'setItem')
        .mockImplementationOnce(
          (key: string, value: string) =>
            new Promise<void>((resolve) => {
              resolveDeleteWrite = () => {
                originalSetItem(key, value).then(resolve);
              };
            }),
        )
        .mockImplementationOnce(
          (key: string, value: string) =>
            new Promise<void>((resolve) => {
              resolveEditWrite = () => {
                originalSetItem(key, value).then(resolve);
              };
            }),
        );

      render(<HomeScreen />);
      await screen.findByText('Aの日記(削除される)');

      fireEvent.press(screen.getByText('Aの日記(削除される)'));
      await screen.findByText('Bの日記(編集前)');

      // Aの削除を確定する。楽観的UI更新は同期的に反映されるが、AsyncStorageへの
      // 実際の書き込み(enqueueDiaryWrite内)は1回目のsetItemがpendingのまま止まる
      const deleteButtons = screen.getAllByText('削除');
      expect(deleteButtons).toHaveLength(2);
      fireEvent.press(deleteButtons[0]);
      await pressAlertButton('削除');

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      // 楽観的UI更新により、Aは一覧からすでに消えている
      expect(screen.queryByText('Aの日記(削除される)')).toBeNull();

      // Aの書き込みがまだpendingのうちに、Bの編集保存を開始する
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');
      const editInput = screen.getByDisplayValue('Bの日記(編集前)');
      fireEvent.changeText(editInput, 'Bの日記(編集後)');
      const saveButtons = screen.getAllByText('保存');
      expect(saveButtons).toHaveLength(2);
      fireEvent.press(saveButtons[1]);

      // 書き込みキューによって直列化されているため、Aの書き込みが完了する前に
      // Bの書き込み(2回目のsetItem呼び出し)が発生することはない
      // (このアサーションは、直列化前の実装では2回目のsetItemが即座に発生してしまい失敗する)
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

      // Aの書き込みを完了させると、キューの次のタスク(Bの編集)がAsyncStorageから
      // 最新データ(Aがすでに削除された状態)を読み直してから書き込みを開始する
      resolveDeleteWrite();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2), {
        timeout: 5000,
      });

      // Bの書き込みも完了させる
      resolveEditWrite();
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull(), {
        timeout: 5000,
      });

      // 最終的にAsyncStorageへ永続化された内容には、Aの削除とBの編集の両方が反映されている
      // (完了順序が入れ替わっても、どちらか一方が古いスナップショットで上書きされて消えない)
      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const [, lastValue] = setItemMock.mock.calls[setItemMock.mock.calls.length - 1];
      const persisted = (await decryptPersistedEntries(lastValue)) as {
        id: string;
        text: string;
      }[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe('b');
      expect(persisted[0].text).toBe('Bの日記(編集後)');

      // 画面上の表示にも両方の変更が反映されている
      expect(screen.queryByText('Aの日記(削除される)')).toBeNull();
      expect(screen.getAllByText('Bの日記(編集後)').length).toBeGreaterThanOrEqual(1);
    });

    it('persists a newly saved entry together with a concurrent deletion of a different entry, even though the deletion write is still pending when the new save is requested (regression for Issue #130, covering handleSave alongside handleDeleteEntry)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: 'keep', text: '残る日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: 'todelete', text: '削除される日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      // 同上の理由により、実際の書き込みは元の実装経由で行い完了タイミングのみを遅延させる
      const originalSetItem = AsyncStorage.setItem;
      let resolveDeleteWrite: () => void = () => {};
      let resolveSaveWrite: () => void = () => {};
      jest
        .spyOn(AsyncStorage, 'setItem')
        .mockImplementationOnce(
          (key: string, value: string) =>
            new Promise<void>((resolve) => {
              resolveDeleteWrite = () => {
                originalSetItem(key, value).then(resolve);
              };
            }),
        )
        .mockImplementationOnce(
          (key: string, value: string) =>
            new Promise<void>((resolve) => {
              resolveSaveWrite = () => {
                originalSetItem(key, value).then(resolve);
              };
            }),
        );

      render(<HomeScreen />);
      await screen.findByText('残る日記');

      fireEvent.press(screen.getByText('残る日記'));
      await screen.findByText('削除される日記');

      const deleteButtons = screen.getAllByText('削除');
      expect(deleteButtons).toHaveLength(2);
      fireEvent.press(deleteButtons[1]);
      await pressAlertButton('削除');

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      // 削除の書き込みがまだpendingのうちに、新規エントリの保存を開始する
      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '新しい日記');
      fireEvent.press(screen.getByText('保存'));

      // 書き込みキューにより、削除の書き込みが完了するまで新規保存の書き込み
      // (2回目のsetItem呼び出し)は発生しない
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

      resolveDeleteWrite();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2), {
        timeout: 5000,
      });

      resolveSaveWrite();
      expect(await screen.findByText('保存しました', {}, { timeout: 5000 })).toBeTruthy();

      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const [, lastValue] = setItemMock.mock.calls[setItemMock.mock.calls.length - 1];
      const persisted = (await decryptPersistedEntries(lastValue)) as {
        id: string;
        text: string;
      }[];
      // 削除されたエントリを含まず、既存の1件+新規保存した1件の合計2件が残っている
      expect(persisted).toHaveLength(2);
      expect(persisted.some((entry) => entry.id === 'keep')).toBe(true);
      expect(persisted.some((entry) => entry.text === '新しい日記')).toBe(true);
      expect(persisted.some((entry) => entry.id === 'todelete')).toBe(false);
    });
  });

  describe('テーマに応じたエラー色(Issue #58)', () => {
    // `hooks/use-color-scheme.ts`はreact-nativeの`useColorScheme`をそのままre-exportしているため、
    // jest-expo(react-native)のオートモック(常に'light'を返すjest.fn)を直接上書きすることで
    // ダークモードをシミュレートできる
    const mockedUseColorScheme = useColorScheme as jest.Mock;

    afterEach(() => {
      // このdescribe内で上書きしたダークモードの戻り値が他のテスト(既定のライトモード想定)に
      // 波及しないよう明示的に戻す。beforeEachの`jest.clearAllMocks()`は呼び出し履歴のみをクリアし、
      // `mockReturnValue`で差し替えた実装自体はクリアされないため、ここで戻す必要がある
      mockedUseColorScheme.mockReturnValue('light');
    });

    it('sanity check: Colors.light.error and Colors.dark.error are different values', () => {
      // ライト/ダークで同じ値だと、以下のテストが誤って"たまたま"パスしてしまう
      // (ライトモードの色のままでもテストが通ってしまう)ことを防ぐための前提確認
      expect(Colors.dark.error).not.toBe(Colors.light.error);
    });

    it('renders the character counter in Colors.dark.error once the max length is reached, when in dark mode', async () => {
      mockedUseColorScheme.mockReturnValue('dark');
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, 'あ'.repeat(1000));
      const counterAtLimit = screen.getByText('1000/1000');
      expect(StyleSheet.flatten(counterAtLimit.props.style).color).toBe(Colors.dark.error);
    });

    it('shows the save-failure error message in Colors.dark.error when in dark mode', async () => {
      mockedUseColorScheme.mockReturnValue('dark');
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      const errorMessage = await screen.findByText('保存に失敗しました。もう一度お試しください。');
      expect(StyleSheet.flatten(errorMessage.props.style).color).toBe(Colors.dark.error);
    });

    it('shows the edit-failure error message in Colors.dark.error when in dark mode', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();
      mockedUseColorScheme.mockReturnValue('dark');
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '失敗するはずの編集');
      // 編集モーダルの保存ボタンは、メインの入力欄(composer)の保存ボタンと同じ文言「保存」を
      // 使うため2件ヒットする。JSXの描画順(composerが先、編集モーダルが後)に依存して2件目を使う
      const saveButtons = screen.getAllByText('保存');
      expect(saveButtons).toHaveLength(2);
      fireEvent.press(saveButtons[1]);

      const editErrorMessage =
        await screen.findByText('更新に失敗しました。もう一度お試しください。');
      expect(StyleSheet.flatten(editErrorMessage.props.style).color).toBe(Colors.dark.error);
    });

    it('shows the delete link in Colors.dark.error when in dark mode', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '削除確認用の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();
      mockedUseColorScheme.mockReturnValue('dark');

      render(<HomeScreen />);
      await screen.findByText('削除確認用の日記');
      fireEvent.press(screen.getByText('削除確認用の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      const deleteLink = screen.getByText('削除');
      expect(StyleSheet.flatten(deleteLink.props.style).color).toBe(Colors.dark.error);
    });
  });
});
