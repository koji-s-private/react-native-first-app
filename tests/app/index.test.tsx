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
  FlatList,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { Calendar } from 'react-native-calendars';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/(tabs)/index';
import { TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID } from '@/components/tab-screen-container';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import { buildDiaryEntryKey, type DiaryEntry } from '@/utils/diary-storage';

// `expo-router`の`Link`(Trigger/Preview/Menuを伴う複合API)はナビゲーション/routerコンテキストを
// 要求するため、単体レンダリングでも動くよう単純なパススルーコンポーネントに差し替える。
// `useRouter`も同様にナビゲーションコンテキストを要求するため、`push`呼び出しをテストから
// 検証できるjest.fnに差し替える(Issue #221: 日付タップ/検索結果タップでの画面遷移の検証に使う)。
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

  // 本物の`useFocusEffect`は単体レンダリング環境では動かないため、マウント時に一度だけ
  // 発火する簡易モックに差し替える。再フォーカスを模す場合はunmount/再mountするテストが
  // 多いが、stateを保ったまま再フォーカスだけ模したいテスト向けに、現在マウント中の
  // 全effectを保持し`__triggerRefocus()`で明示的に再発火できるようにしておく
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

  const mockPush = jest.fn();
  function useRouter() {
    return { push: mockPush };
  }

  return { Link, useFocusEffect, useRouter, __triggerRefocus, __mockPush: mockPush };
});

// jest-expoのオートモックは`randomUUID()`が常に`undefined`を返すため、ID一意性検証のために
// 呼び出しごとに異なる値を返すモックに差し替える。`getRandomBytes`もオートモックには存在しない
// ため、Node標準の`crypto`モジュールによる実際の乱数生成で代替する。
jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    randomUUID: jest.fn(),
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
  };
});

// expo-secure-storeはjest-expoのオートモックだと`getItemAsync`が常に`undefined`を返し状態を
// 永続化しないため、保存→再読み込みの暗号化ラウンドトリップを検証できるようインメモリで
// キーと値を保持する独自モックに差し替える。
// expo-hapticsも、保存成功時のハプティックフィードバックを呼び出し引数まで
// 明示的にアサートできるよう、jest-expoのオートモックではなく独自モックに差し替える。
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

// 実機では`expo-router`の`ExpoRoot`が自動的に`SafeAreaProvider`で全体をラップするが、
// 単体レンダリングではそのラップが無く`useSafeAreaInsets`がエラーを投げるため、
// ライブラリ公式のjestモック(常にゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

// Jest環境ではネイティブの`AsyncStorage`が使えない(`NativeModule: AsyncStorage is null`)ため、
// パッケージ同梱の公式インメモリモックに差し替える。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `KeyboardAvoidingView`は`behavior` propをレンダリング結果のstyleに反映しないため、渡された
// propを検証できるよう`testID`付きのViewでそのまま可視化する薄いモックに差し替える。
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
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
const secureStoreMock = SecureStore as unknown as { __reset: () => void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __triggerRefocus: triggerRefocus, __mockPush: mockPush } = require('expo-router') as {
  __triggerRefocus: () => void;
  __mockPush: jest.Mock;
};

const STORAGE_KEY = 'diary-entries';
const ENCRYPTED_PREFIX = 'encrypted:v1:';
const INPUT_PLACEHOLDER = '今日の出来事や気持ちを書いてみましょう';
// 日記本文のキーワード検索用の入力欄
const SEARCH_INPUT_PLACEHOLDER = '日記を検索';
const CLOSE_BUTTON_TEXT = '閉じる';
// 日記が0件のときにカレンダーの上に表示される案内メッセージ
const EMPTY_STATE_TEXT = 'まだ日記がありません。最初の日記を書いてみましょう。';
const KEYBOARD_AVOIDING_VIEW_TEST_ID = 'keyboard-avoiding-view';

// `queryAllByRole('button')`は常に保存ボタンを含む。
// カレンダーの日付セルの個数だけを数えたいテストでは、保存ボタンを除外したこのヘルパーを使う。
function queryCalendarDayButtons() {
  return screen
    .queryAllByRole('button')
    .filter((button) => button.props.accessibilityLabel !== '保存');
}

// queryCalendarDayButtonsのうち、実際に日記が存在する日(accessibilityLabelに「日記あり」を
// 含むセル。件数付きの「日記あり(N件)」も含めて拾うため終端一致ではなく部分一致で判定する)
// だけに絞り込むヘルパー。日記の無い日も新規作成用にタップ可能になったことで、
// 旧来「タップ可能=日記あり」だった前提が崩れたテストで、この用途に置き換えて使う。
function queryCalendarDayButtonsWithEntry() {
  return queryCalendarDayButtons().filter((button) =>
    (button.props.accessibilityLabel as string | undefined)?.includes('日記あり'),
  );
}

// AsyncStorageに実際に永続化された値(暗号化済み文字列)を、テストで検証しやすいよう
// 復号してJSONとしてパースするヘルパー。エントリ単位のキー方式では
// 1つの暗号化文字列は常に1エントリ分のオブジェクトを表す。`getOrCreateEncryptionKey`は
// SecureStoreモックに永続化された鍵をそのまま返すため、画面側が使った鍵と同じ鍵が得られる。
async function decryptPersistedEntry(encryptedValue: string): Promise<unknown> {
  const key = await getOrCreateEncryptionKey();
  return JSON.parse(decryptText(encryptedValue, key));
}

// 個別キー方式で保存されているエントリを1件、AsyncStorageから直接読み取って復号するヘルパー
async function readPersistedEntry(id: string): Promise<DiaryEntry | null> {
  const stored = await AsyncStorage.getItem(buildDiaryEntryKey(id));
  if (!stored) {
    return null;
  }
  return (await decryptPersistedEntry(stored)) as DiaryEntry;
}

// `Calendar`はcurrent/initialDate未指定のため実行時点の「今日」を含む月を表示する。
// 月初/月末の前後月「はみ出し」セル(最大前後6日程度)と重複しない10〜20日の範囲を使い、
// さらに`dayWithEntry`(10〜15日)と`dayWithoutEntry`(16〜20日)の範囲を分けて必ず異なる日付にする。
function pickTestDays(now: Date): { dayWithEntry: number; dayWithoutEntry: number } {
  return {
    dayWithEntry: 10 + (now.getDate() % 6), // 10〜15
    dayWithoutEntry: 16 + (now.getDate() % 5), // 16〜20
  };
}

// pickTestDaysと同じ10〜20日の範囲から、「今日」バッジのセルと区別できるよう
// 実行時点の「今日」とは異なる日を1つ選ぶ。
function pickNonTodayDayInRange(now: Date): number {
  const today = now.getDate();
  for (let day = 10; day <= 20; day += 1) {
    if (day !== today) {
      return day;
    }
  }
  // 10〜20日の11通りのうち「今日」と一致するのは高々1通りなので、実際には到達しない
  return 10;
}

// 実行時点の年月と、指定した日付・時刻から端末ローカル時刻ベースのISO文字列を作る
// (UTC表記のリテラルを直接組み立てるとテスト実行環境のタイムゾーンによって
// 日付がずれる恐れがあるため、必ずDateのローカルコンストラクタ経由で作成する)。
function isoAt(now: Date, day: number, hour = 9, minute = 0): string {
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0).toISOString();
}

// 実装側の`toDateKey`と同じ'YYYY-MM-DD'形式のキーを組み立てるテスト用ヘルパー。
// 日付タップ/検索結果タップ時に`router.push`へ渡される遷移先パスを検証するために使う
// (Issue #221: 日付一覧モーダルを day-entries/[date] 画面への遷移に置き換えたことに伴う)
function toDateKeyForTest(now: Date, day: number): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const paddedDay = `${day}`.padStart(2, '0');
  return `${year}-${month}-${paddedDay}`;
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

// `@types/react-test-renderer`が無く`screen.UNSAFE_getAllByType`等の戻り値は事実上`any`になるため、
// コールバック引数にも同じ`any`を明示注釈し`noImplicitAny`を回避する(実行時の挙動には影響しない)。
type TestNode = any;

// 各モーダルの背景オーバーレイPressableを特定するヘルパー。実装側は
// `testID="modal-overlay-pressable"`を目印として付けている。
function getModalOverlayPressable(modal: TestNode): TestNode {
  const overlay = modal.findAll(
    (node: TestNode) => node.props.testID === 'modal-overlay-pressable',
  )[0];
  if (!overlay) {
    throw new Error('modal overlay (Pressable) not found');
  }
  return overlay;
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

  // FlatList(VirtualizedList)は初回マウント・更新のたびに、表示するセルの範囲を再計算する
  // `updateCellsBatchingPeriod`(既定50ms)のsetTimeoutを内部で予約する。`@testing-library/react-native`の
  // 自動アンマウント(モジュール読み込み時に最上位で登録される`afterEach`)はマイクロタスク1回分しか
  // 待たずにunmountするため、CPU負荷が高い環境ではこのタイマーがunmount前後どちらで発火するか
  // タイミング競合し、act()外でのstate更新警告(`An update to VirtualizedList ... was not wrapped in
  // act(...)`)を引き起こすことがある。Jestはネストした`describe`内の`afterEach`を
  // 外側(モジュールレベル)より先に実行するため、ここで実際のマウント状態のまま50msより長く待つことで、
  // 予約されていたタイマーをunmountされる前に確実にact()内で発火させ、警告の発生を防ぐ。
  afterEach(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });

  it('renders the diary title', async () => {
    render(<HomeScreen />);

    expect(screen.getByText('日記')).toBeTruthy();

    // 初回読み込みのeffectを完了させ、次のテストに漏れ出さないようにする
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  });

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

  describe('背景タップでキーボードを閉じる', () => {
    // `Pressable`はReact.memoでラップされているため、react-test-rendererの内部実装上
    // メモ化された`type`が内側のアンラップ済み関数になり`screen.UNSAFE_getAllByType(Pressable)`
    // では一致しない。そのため型ではなく`accessible={false}` + `onPress`のprops組み合わせを
    // 手がかりに`screen.root.findAll`で探す(`getModalOverlayPressable`も同じ理由)。
    function getBackgroundDismissPressable() {
      const candidates = screen.root.findAll(
        (node: TestNode) =>
          node.props.accessible === false && typeof node.props.onPress === 'function',
      );
      if (candidates.length !== 1) {
        throw new Error(
          `expected exactly one background dismiss Pressable, found ${candidates.length}`,
        );
      }
      return candidates[0];
    }

    it('calls Keyboard.dismiss when the background wrapper is tapped (正常系)', async () => {
      const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(getBackgroundDismissPressable());

      expect(dismissSpy).toHaveBeenCalledTimes(1);
    });

    it('sets accessible={false} on the background wrapper so the individual accessibility info of the title/composer/buttons inside is not merged into a single element (境界値: アクセシビリティ設定の確認)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(getBackgroundDismissPressable().props.accessible).toBe(false);
    });

    it('does not call Keyboard.dismiss when pressing the save button; the save button handles its own tap independently of the background wrapper (回帰: 既存のタップ操作がラッパーに邪魔されない)', async () => {
      const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '入力内容');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
      expect(dismissSpy).not.toHaveBeenCalled();
    });

    it('does not call Keyboard.dismiss when typing into the composer TextInput; the input handles its own event independently of the background wrapper (回帰)', async () => {
      const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '入力内容');

      expect(input.props.value).toBe('入力内容');
      expect(dismissSpy).not.toHaveBeenCalled();
    });

    // FlatListはメモ化されていない素のクラスコンポーネントのため`screen.UNSAFE_queryAllByType(FlatList)`
    // で直接特定できる。日付一覧はIssue #221で専用画面(day-entries/[date].tsx)へ遷移する方式に
    // 変わったため、この画面(HomeScreen)に残るFlatListは検索結果一覧のみになった。
    function queryAllFlatLists() {
      return screen.UNSAFE_queryAllByType(FlatList);
    }

    it('does not mount any FlatList until a search keyword is entered (前提条件の確認)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(queryAllFlatLists()).toHaveLength(0);
    });

    it('sets keyboardDismissMode="on-drag" on the search results FlatList once a keyword is entered (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      await screen.findByText(/公園/);

      // 日付一覧モーダルは未オープンのため、検索結果一覧用のFlatListのみが該当する
      const flatLists = queryAllFlatLists();
      expect(flatLists).toHaveLength(1);
      expect(flatLists[0].props.keyboardDismissMode).toBe('on-drag');
    });

    it('sets keyboardShouldPersistTaps="handled" on the search results FlatList once a keyword is entered, so a search result can be selected with a single tap even while the keyboard is shown (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      await screen.findByText(/公園/);

      // HomeScreenに残るFlatListは検索結果一覧のみなので、これが該当する
      const flatLists = queryAllFlatLists();
      expect(flatLists).toHaveLength(1);
      expect(flatLists[0].props.keyboardShouldPersistTaps).toBe('handled');
    });
  });

  describe('日記の保存', () => {
    it('does not save and does not call AsyncStorage.setItem when the input is empty', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(0);
    });

    it('does not save an entry consisting only of whitespace', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');
      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(0);
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

    it('shows a character counter that updates as the user types', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      expect(screen.getByText('0/1000')).toBeTruthy();

      fireEvent.changeText(input, '何か書く');
      expect(screen.getByText('4/1000')).toBeTruthy();
    });

    it('truncates input exceeding the max length via onChangeText (TextInput no longer has a maxLength prop, since it only limits UTF-16 code units, not grapheme clusters)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      // maxLength propは指定していないため、handleChangeDraft内のgrapheme単位の切り詰めを直接確認する
      fireEvent.changeText(input, 'あ'.repeat(1001));

      expect(input.props.value).toBe('あ'.repeat(1000));
      expect(screen.getByText('1000/1000')).toBeTruthy();
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

      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe(exactlyMaxLength);
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

    describe('絵文字(サロゲートペア・ZWJ結合絵文字)を含む本文の文字数カウント・切り詰め', () => {
      // ZWJ(Zero Width Joiner)で複数の絵文字コードポイントを結合した家族の絵文字。
      // 見た目上は1文字(1書記素クラスタ)だが、'👨'+ZWJ+'👩'+ZWJ+'👧'+ZWJ+'👦'を構成する
      // サロゲートペア4つ(各2ユニット)とZWJ3つ(各1ユニット)で、UTF-16コードユニットは11個ある
      const familyEmoji = '👨‍👩‍👧‍👦';
      // シンプルなサロゲートペア絵文字(UTF-16コードユニット2個で1書記素クラスタ)
      const simpleEmoji = '😀';
      // 地域指示記号(Regional Indicator)のサロゲートペア2つを組み合わせた旗の絵文字
      // (UTF-16コードユニット4個で1書記素クラスタ)
      const flagEmoji = '🇯🇵';

      it('counts each surrogate-pair/ZWJ emoji as a single grapheme in the character counter, not by UTF-16 code units', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        const text = `${familyEmoji}${simpleEmoji}${flagEmoji}`;
        // UTF-16コードユニット単位では11+2+4=17だが、書記素クラスタ単位では3文字
        expect(text.length).toBe(17);

        fireEvent.changeText(input, text);

        // grapheme単位でカウントされ、カウンター表示は実際の見た目通り3文字になる
        expect(screen.getByText('3/1000')).toBeTruthy();
        expect(screen.queryByText('17/1000')).toBeNull();
      });

      it('does not split a ZWJ-joined family emoji in the middle when truncating overlong input via onChangeText (boundary: exactly at the limit)', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        // 999文字の'あ' + 家族の絵文字(1000文字目) + さらに超過する10文字、という構成。
        // grapheme単位で正しく切り詰めれば、家族の絵文字は途中で壊れず1000文字目として残り、
        // それ以降の10文字だけが切り捨てられるはず
        const overLimitText = `${'あ'.repeat(999)}${familyEmoji}${'あ'.repeat(10)}`;
        fireEvent.changeText(input, overLimitText);

        const expectedTruncated = `${'あ'.repeat(999)}${familyEmoji}`;
        expect(input.props.value).toBe(expectedTruncated);
        expect(screen.getByText('1000/1000')).toBeTruthy();
      });

      it('does not split a surrogate-pair emoji in the middle when truncating overlong input via onChangeText (boundary: exactly at the limit)', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        // 999文字の'い' + サロゲートペア絵文字(1000文字目) + さらに超過する5文字。
        // UTF-16コードユニット単位でslice(0, 1000)してしまうと、絵文字の
        // サロゲートの片割れだけが残って文字化けするはずの境界を狙う
        const overLimitText = `${'い'.repeat(999)}${simpleEmoji}${'い'.repeat(5)}`;
        fireEvent.changeText(input, overLimitText);

        const expectedTruncated = `${'い'.repeat(999)}${simpleEmoji}`;
        expect(input.props.value).toBe(expectedTruncated);
        expect(screen.getByText('1000/1000')).toBeTruthy();
      });

      it('keeps an emoji-ending body of exactly BODY_MAX_LENGTH graphemes intact (boundary: exactly at the limit, no truncation)', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        // ちょうど1000文字(999文字の'う' + 絵文字1文字)で、超過していない境界値
        const exactlyMaxLength = `${'う'.repeat(999)}${familyEmoji}`;
        fireEvent.changeText(input, exactlyMaxLength);

        expect(input.props.value).toBe(exactlyMaxLength);
        expect(screen.getByText('1000/1000')).toBeTruthy();
      });
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

    // スクリーンリーダー利用者にも入力欄・保存ボタンの役割が伝わるよう、
    // accessibilityLabel/accessibilityRole/accessibilityStateを検証する
    it('sets accessibilityLabel="日記本文" on the composer TextInput, and accessibilityRole="button"/accessibilityLabel="保存" on the save button so screen readers can identify each control', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // placeholderはフォーカス後に読み上げられない環境があるため、accessibilityLabelで
      // 入力欄を直接特定できることを確認する
      const input = screen.getByLabelText('日記本文');
      expect(input.props.placeholder).toBe(INPUT_PLACEHOLDER);

      // accessibilityRole/accessibilityLabelにより、保存ボタンがロール・名前の両方で
      // 一意に特定できる(disabled中でもroleは'button'のまま変わらない)
      const saveButton = screen.getByRole('button', { name: '保存' });
      expect(saveButton.props.accessibilityLabel).toBe('保存');
      expect(saveButton.props.accessibilityState?.disabled).toBe(true);

      fireEvent.changeText(input, '何か書く');
      expect(saveButton.props.accessibilityState?.disabled).toBe(false);
    });

    it('renders the save button at reduced opacity (0.5) while the input is empty, and at full opacity (1) once text is entered, so the disabled state is also visible', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '何か書く');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(1);

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);
    });

    it('keeps the save button at reduced opacity (0.5) when the input contains only whitespace, matching the disabled condition', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');

      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);
    });

    it('keeps the save button at reduced opacity (0.5) while a save is in flight (isSaving), even once the user has typed a new non-empty draft, and restores full opacity once the save completes (境界値: isSaving overrides draft content in the opacity condition)', async () => {
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

    it('restores previously saved plaintext entries (from before encryption was introduced) from AsyncStorage, showing a count badge, and navigates to the day-entries screen for that date when tapped', async () => {
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 2件あるため、セルには件数バッジ「2」が表示され、タップするとその日の一覧画面へ遷移する
      // (一覧の内容自体・時刻の昇順表示はtests/app/day-entries/[date].test.tsxで検証する)
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
      fireEvent.press(screen.getByText(String(dayWithEntry)));

      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);
    });

    it('migrates a legacy plaintext entry into its own encrypted per-entry key on load, and persists newly saved entries independently', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      // 暗号化対応前に保存された想定の平文JSON(レガシーの単一キー形式)
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // マウント時の読み込みで、レガシーの単一キーは個別キー方式(暗号化済み)へ移行済みになっている
      expect(await readPersistedEntry('old')).toEqual(storedEntries[0]);
      expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [key, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      // 新規保存は自分専用の個別キーにのみ書き込まれ、移行済みの過去の日記のキーには触れない
      expect(key).not.toBe(STORAGE_KEY);
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('今日の日記');
      // 移行済みの過去の日記はそのまま残っている
      expect(await readPersistedEntry('old')).toEqual(storedEntries[0]);

      // 同じ日に2件になったため、セルには件数バッジ「2」が表示される
      const cellsWithEntry = queryCalendarDayButtonsWithEntry();
      expect(cellsWithEntry).toHaveLength(1);

      // タップするとその日の一覧画面へ遷移する
      // (一覧の内容自体はtests/app/day-entries/[date].test.tsxで検証する)
      fireEvent.press(cellsWithEntry[0]);
      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, now.getDate())}`);
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
    });

    it('reloads from AsyncStorage when the screen regains focus, so data deleted elsewhere (e.g. from the settings tab) is not resurrected by a later save', async () => {
      const now = new Date();
      const key = await getOrCreateEncryptionKey();
      const storedEntries = [
        { id: 'old', text: '削除されるはずの日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(storedEntries), key));

      // 日記タブを開いて表示する(expo-routerのTabsは実機ではこの画面をアンマウントしないが、
      // このテストのモックではフォーカス再取得を模すために一度unmountし、下で再度renderする)
      const { unmount } = render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      unmount();

      // 設定タブでの「日記データを全件削除」操作を模して、移行済みの個別キーを直接削除する
      // (マウント時の読み込みでレガシーの単一キーは既に個別キー方式へ移行済みになっている)
      await AsyncStorage.removeItem(buildDiaryEntryKey('old'));

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
      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('新しい日記');
      // 削除済みだった過去のエントリは復活していない
      expect(await readPersistedEntry('old')).toBeNull();
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [savedKey, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      // 新規保存は自分専用の個別キー(diary-entry:<uuid>)に書き込まれる
      expect(savedKey).not.toBe(STORAGE_KEY);

      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('今日の日記');
      // 既存(移行済み)の過去の日記もそのまま残っている
      expect(await readPersistedEntry('old')).toEqual(storedEntries[0]);

      // 同じ日に2件になったため、セルには件数バッジ「2」が表示される
      const cellsWithEntry = queryCalendarDayButtonsWithEntry();
      expect(cellsWithEntry).toHaveLength(1);

      // タップするとその日の一覧画面へ遷移する
      // (一覧の内容自体はtests/app/day-entries/[date].test.tsxで検証する)
      fireEvent.press(cellsWithEntry[0]);
      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, now.getDate())}`);
    });

    it('shows the empty state when stored data is corrupted (invalid JSON)', async () => {
      jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not valid json');

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 壊れたデータは読み捨てられ、空の状態から始まるため、日記が実際に存在するセルは無い
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(0);
    });

    it('shows the empty state when stored data has the encrypted-payload marker but fails to decrypt (corrupted ciphertext)', async () => {
      jest
        .spyOn(AsyncStorage, 'getItem')
        .mockResolvedValueOnce(`${ENCRYPTED_PREFIX}not-a-real-ciphertext`);

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 復号に失敗したデータは読み捨てられ、空の状態から始まるため、日記が実際に存在するセルは無い
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(0);
    });

    it('rolls back entries and draft and shows an error message when AsyncStorage.setItem fails', async () => {
      const now = new Date();
      const storedEntries = [
        { id: 'old', text: '過去の日記', createdAt: isoAt(now, now.getDate(), 0, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '今日の日記');
      fireEvent.press(screen.getByText('保存'));

      const errorMessage = await screen.findByText('保存に失敗しました。もう一度お試しください。');
      expect(errorMessage).toBeTruthy();
      // エラーメッセージの文字色は、ハードコードではなくテーマ定数化されたColors.light.errorを使う
      expect(StyleSheet.flatten(errorMessage.props.style).color).toBe(Colors.light.error);

      // 保存前の状態にロールバックされているため、日記は1件(既存の「過去の日記」)のみのまま
      expect(input.props.value).toBe('今日の日記');
      const cellsWithEntry = queryCalendarDayButtonsWithEntry();
      expect(cellsWithEntry).toHaveLength(1);

      // タップするとその日の一覧画面へ遷移する
      // (一覧の内容自体はtests/app/day-entries/[date].test.tsxで検証する)
      fireEvent.press(cellsWithEntry[0]);
      expect(mockPush).toHaveBeenCalled();
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      // 保存(AsyncStorage.setItem)がまだpendingの間に、入力欄は一旦空になる
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始める
      fireEvent.changeText(input, '書きかけの新しい下書き');

      rejectSetItem(new Error('write failed'));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();

      // ロールバックによって「保存前のdraft(保存中の日記)」で上書きされず、
      // ユーザーが新しく入力した内容がそのまま保持される
      expect(input.props.value).toBe('書きかけの新しい下書き');
      expect(screen.queryByText('保存中の日記')).toBeNull();
    });

    it('keeps the draft empty (does not roll back) when the user typed something while a save was in flight and then deleted it all themselves, and that save later fails', async () => {
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始めるが、自分で全部消して空文字列に戻す
      fireEvent.changeText(input, '書きかけの新しい下書き');
      fireEvent.changeText(input, '');

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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '保存中の日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      expect(input.props.value).toBe('');

      // pendingの間にユーザーが新しい下書きを書き始める
      fireEvent.changeText(input, '書きかけの新しい下書き');

      resolveSetItem();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 送信した「保存中の日記」自体は正しく永続化される(ただし過去の日記の方が時刻が早いため、
      // カレンダーセルのタイトルは引き続き「過去の日記」のまま)
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('保存中の日記');

      // 成功パスはcatch節を通らずdraftに触れないため、ユーザーが新しく入力した内容が
      // そのまま保持され、エラーメッセージも表示されない
      expect(input.props.value).toBe('書きかけの新しい下書き');
      expect(screen.queryByText('保存に失敗しました。もう一度お試しください。')).toBeNull();
    });

    it('ignores a second press of the save button while a save is still in flight, preventing a duplicate entry', async () => {
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
      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('連打される日記');

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

      // 各保存は自分専用の個別キーに書き込まれるため、3回のsetItem呼び出しそれぞれから
      // 1件ずつ復号し、idの一意性を確認する
      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const persistedEntries = (await Promise.all(
        setItemMock.mock.calls.map(([, value]) => decryptPersistedEntry(value)),
      )) as { id: string }[];

      expect(persistedEntries).toHaveLength(3);
      const ids = persistedEntries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);

      // 同じ日に書かれた3件すべてが保存され、セルには件数バッジ「3」が表示される
      // (一覧の内容自体はtests/app/day-entries/[date].test.tsxで検証する)
      const cellsWithEntry = queryCalendarDayButtonsWithEntry();
      expect(cellsWithEntry).toHaveLength(1);
      fireEvent.press(cellsWithEntry[0]);
      expect(mockPush).toHaveBeenCalled();
    });
  });

  describe('下書きの自動保存', () => {
    // 実装(`app/(tabs)/index.tsx`)の`diary-draft`キー・デバウンス間隔(1000ms)と対応させる
    const DRAFT_STORAGE_KEY = 'diary-draft';
    const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

    it('does not immediately persist the draft key when the user types (debounced)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '書きかけの下書き');

      // デバウンス時間が経過するまでは、下書きキーへの書き込みはまだ発生しない
      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String));
    });

    it('auto-saves the draft under a separate AsyncStorage key once the debounce interval elapses', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '書きかけの下書き');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, '書きかけの下書き'),
        );
        // 日記本文の保存キー(diary-entries)とは別キーで保存されている
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(STORAGE_KEY, expect.any(String));
      } finally {
        jest.useRealTimers();
      }
    });

    it('coalesces rapid successive edits into a single debounced write of the latest content', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        fireEvent.changeText(input, '書');
        act(() => {
          jest.advanceTimersByTime(500);
        });
        fireEvent.changeText(input, '書き');
        act(() => {
          jest.advanceTimersByTime(500);
        });
        fireEvent.changeText(input, '書きか');

        // 連続した編集の間隔がデバウンス時間(1000ms)未満のため、まだ書き込まれていない
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          DRAFT_STORAGE_KEY,
          expect.any(String),
        );

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        const draftWrites = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
          ([key]) => key === DRAFT_STORAGE_KEY,
        );
        expect(draftWrites).toHaveLength(1);
        expect(draftWrites[0][1]).toBe('書きか');
      } finally {
        jest.useRealTimers();
      }
    });

    it('restores a previously auto-saved draft into the text input on mount', async () => {
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '前回の続きから書きかけの下書き');

      render(<HomeScreen />);

      const input = await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
      await waitFor(() => expect(input.props.value).toBe('前回の続きから書きかけの下書き'));
    });

    it('clears the auto-saved draft key once the entry is successfully saved', async () => {
      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        fireEvent.changeText(input, '保存される日記');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });
        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, '保存される日記'),
        );

        fireEvent.press(screen.getByText('保存'));

        await waitFor(() =>
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('removes the draft key once the input is cleared back to empty and the debounce interval elapses', async () => {
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '消される下書き');

      jest.useFakeTimers();
      try {
        render(<HomeScreen />);
        const input = await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
        await waitFor(() => expect(input.props.value).toBe('消される下書き'));

        fireEvent.changeText(input, '');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        await waitFor(() =>
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not persist the debounced draft write once the screen unmounts before the debounce interval elapses', async () => {
      jest.useFakeTimers();
      try {
        const { unmount } = render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(
          screen.getByPlaceholderText(INPUT_PLACEHOLDER),
          'アンマウント直前まで入力していた下書き',
        );

        // デバウンスのタイマーが発火する前に画面がアンマウントされる
        // (例: タブを離れて別のタブへ遷移する等)
        unmount();

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        // クリーンアップ(clearTimeout)により、アンマウント後にタイマーが発火して
        // 書き込みが発生することはない
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          DRAFT_STORAGE_KEY,
          expect.any(String),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not warn about updating state after unmount when the initial draft restore resolves after the screen has already been unmounted', async () => {
      let resolveDraftRead: (value: string | null) => void = () => {};
      // `@react-native-async-storage/async-storage/jest/async-storage-mock`の各メソッドは
      // 元々jest.fn()として定義されているため、`jest.spyOn`はそれを新規にラップし直さず
      // 既存のmock関数をそのまま返す。その状態で`mockRestore()`を呼んでも「スパイ前の
      // 実装」には戻らず、常に`undefined`を返す空のmockにリセットされてしまう
      // (`jest.spyOn`は非mock関数に対して使う場合のみ本来の意味で機能する既知の挙動)。
      // そのため、他のテストへ実装を安全に戻すには、上書き前の実装を明示的に保存しておき、
      // finallyで`mockImplementation(元の実装)`により復元する
      const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
      const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
        if (key === DRAFT_STORAGE_KEY) {
          return new Promise<string | null>((resolve) => {
            resolveDraftRead = resolve;
          });
        }
        return Promise.resolve(null);
      });

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { unmount } = render(<HomeScreen />);
        unmount();

        await act(async () => {
          resolveDraftRead('マウント解除後に届いた下書き');
          await Promise.resolve();
          await Promise.resolve();
        });

        // isCancelledフラグにより、アンマウント後に届いた読み込み結果でsetState(setDraft/
        // setIsDraftRestored)を呼び出さないため、Reactの「アンマウント済みコンポーネントへの
        // state更新」警告は発生しない
        const unmountWarning = consoleErrorSpy.mock.calls.some(
          ([message]) =>
            typeof message === 'string' &&
            message.includes("Can't perform a React state update on an unmounted component"),
        );
        expect(unmountWarning).toBe(false);
      } finally {
        if (originalGetItemImpl) {
          getItemSpy.mockImplementation(originalGetItemImpl);
        }
        consoleErrorSpy.mockRestore();
      }
    });

    it('does not clear the auto-saved draft key when saving the diary entry fails, so it remains recoverable on next launch', async () => {
      // 下書きキーのクリア(removeItem)はhandleSave成功時のみ実行される。
      // 保存失敗時に下書きまで消えると、次回起動時の復元対象も失われてしまうため、この境界を検証する
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '保存に失敗する日記');
      jest.clearAllMocks();

      render(<HomeScreen />);
      const input = await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
      await waitFor(() => expect(input.props.value).toBe('保存に失敗する日記'));

      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));
      fireEvent.press(screen.getByText('保存'));

      await screen.findByText('保存に失敗しました。もう一度お試しください。');

      expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(DRAFT_STORAGE_KEY);
    });

    it('does not leave an unhandled promise rejection when the initial draft restore getItem() call rejects, and still enables auto-save afterward (regression for the f63bc33 fix)', async () => {
      // async-storage-mockは元々jest.fn()のため、jest.spyOnの`mockRestore()`では元の実装に
      // 戻らない(既知の挙動)。上書き前の実装を保存しておき、finallyで明示的に復元する
      const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
      // 下書きキー(diary-draft)へのgetItemのみrejectさせ、他のキーへの呼び出しは通常通り解決させる
      const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
        if (key === DRAFT_STORAGE_KEY) {
          return Promise.reject(new Error('read failed'));
        }
        return Promise.resolve(null);
      });

      // 未処理のPromise rejectionが発生していないことを検知するため、一時的にリスナーを登録する
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      jest.useFakeTimers();
      try {
        render(<HomeScreen />);

        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY));

        // rejectしたPromiseのcatch/finally節が実行されるまでマイクロタスクキューをフラッシュする
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(unhandledRejections).toHaveLength(0);

        // 復元処理が失敗してもisDraftRestoredはtrueになり、自動保存が無効化されたままにならない
        const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
        fireEvent.changeText(input, '復元失敗後も自動保存される下書き');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(
            DRAFT_STORAGE_KEY,
            '復元失敗後も自動保存される下書き',
          ),
        );
      } finally {
        jest.useRealTimers();
        process.off('unhandledRejection', onUnhandledRejection);
        if (originalGetItemImpl) {
          getItemSpy.mockImplementation(originalGetItemImpl);
        }
      }
    });
  });

  describe('保存成功時のフィードバック', () => {
    // 実装はハプティックを`process.env.EXPO_OS === 'ios'`の条件下でのみ発火させるが、
    // `process.env.EXPO_OS`はbabel-preset-expo(jest-expoのデフォルトで'ios'固定)によって
    // ビルド時にインライン化されるため、テスト実行中に書き換えても分岐には反映されない。
    // そのため、常にiOS相当として振る舞う状態でのハプティック発火のみを検証する。
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

        // トースト表示中に入力を続けHomeScreenを再レンダーさせる。onHideが毎レンダーで
        // 再生成される実装だと、SaveToast側のuseEffectが再実行され続けタイマーが張り直されてしまう。
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
    // 初回読み込み中はentriesの初期値が空配列であることに起因して空状態メッセージが
    // 一瞬誤って表示されてしまわないよう、代わりにローディング表示(ActivityIndicator)を出す。
    it('shows a loading indicator instead of the empty state message before the async AsyncStorage load resolves (prevents the empty state from flashing)', async () => {
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

      // 読み込みを完了させ、テスト終了後にact()の外側でstate更新が起きないようにする
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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    });

    // isLoadingは初回読み込み完了時にfalseへ遷移した後は二度とtrueへ戻らない仕様。
    // タブへ再フォーカスするたびにloadEntriesは再実行されるが、その都度ローディング表示が
    // ちらつかないことを確認する。
    it('does not show the loading indicator again on a subsequent focus refetch (isLoading only ever transitions true -> false, never back to true)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      // 1回目のフォーカス(初回マウント)。画面はアンマウントせず、そのままstate(isLoading)を
      // 保持し続ける(実機のexpo-router Tabsがタブ画面をアンマウントしないのと同じ状況)
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);

      // 2回目の読み込み(再フォーカス時)がまだpending中の間の表示を検証できるようにする
      let resolveGetItem: (value: string | null) => void = () => {};
      jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGetItem = resolve;
          }),
      );

      // マウント時には日記本文(STORAGE_KEY)に加えて下書き復元用(diary-draft)のgetItemも
      // 1回呼ばれているため、再フォーカス後の合計は3回になる
      act(() => {
        (triggerRefocus as () => void)();
      });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledTimes(3));

      // isLoadingは既にfalseのまま維持されるため、読み込みがまだpending中でも
      // ローディング表示は再度出ない(空状態メッセージも、既存のentriesがまだ残っているため出ない)
      expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
      expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);

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
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
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

      // react-native-calendarsのヘッダーは`importantForAccessibility="no-hide-descendants"`で
      // 内部テキストをアクセシビリティツリーから隠している(画面上には表示されている)ため、
      // `includeHiddenElements`を指定して検索する
      expect(
        await screen.findByText(`${now.getFullYear()}年${now.getMonth() + 1}月`, {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
    });

    it('shows a chevron-down IconSymbol next to the calendar header heading, indicating it opens the month picker', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const headerChevrons = screen
        .UNSAFE_getAllByType(IconSymbol)
        .filter((node) => node.props.name === 'chevron.down');
      expect(headerChevrons).toHaveLength(1);
    });

    it('shows a weekday header row (日 月 火 水 木 金 土)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      for (const dayName of ['日', '月', '火', '水', '木', '金', '土']) {
        expect(screen.getByText(dayName, { includeHiddenElements: true })).toBeTruthy();
      }
    });

    it('navigates to the day-entries screen (not the new-entry creation modal) for an entry whose text is an empty string after the first line is trimmed, since tap behavior is based on entriesByDate, not on the trimmed title (defensive boundary for directly-corrupted/legacy storage data, since the composer itself never saves an empty/whitespace-only entry)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '   ', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // セルへの表示テキスト(タイトル)は空文字列だが、isPressable/statusLabelは
      // タイトルの有無ではなくentriesByDateの有無(handleDayPressと同じ基準)で決まるため、
      // このセルは「日記が実際に存在するセル」として1件カウントされる
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);

      fireEvent.press(screen.getByText(String(dayWithEntry)));

      // handleDayPressはentriesByDateの有無で分岐するため、タイトル表示が空でも
      // 新規作成モーダルではなく日付一覧画面への遷移が発生する
      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);
    });

    it('opens the new-entry creation modal (does not navigate) when tapping a day cell that has no diary entries at all', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 日記が実際に存在するセルは1つだけ(dayWithEntry分)である
      // (日記の無い日のセルも未来日でなければタップ可能になったため、
      // 全体のボタン数ではなく「日記が実際に存在するセル」のみで絞り込んで確認する)
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);

      const emptyDayCell = screen.getByText(String(dayWithoutEntry));
      fireEvent.press(emptyDayCell);

      // 日付一覧画面への遷移ではなく新規作成モーダルが開く
      const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
      expect(newEntryModal.props.visible).toBe(true);
      expect(mockPush).not.toHaveBeenCalled();
    });

    // スクリーンリーダー(VoiceOver/TalkBack)利用者にも、日付セルの数字だけでなく
    // 「何年何月何日か」と「その日に日記があるかどうか」が伝わるよう、accessibilityLabel/
    // accessibilityStateを検証する
    it('sets an accessibilityLabel with the full date and "日記あり(N件)" on a day cell that has a diary entry, and does not mark it as accessibility-disabled', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日、日記あり(1件)`;
      const dayCell = screen.getByLabelText(expectedLabel);
      expect(dayCell.props.accessibilityRole).toBe('button');
      expect(dayCell.props.accessibilityState?.disabled).toBe(false);
    });

    it('sets an accessibilityLabel with the full date, "日記なし" and "タップして新規作成" on a day cell without a diary entry that is today or in the past, and does not mark it as accessibility-disabled, made such cells tappable to create a new entry', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      // 「今日」自体は常に未来日ではないため、日記の無い日として確実に使える
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日、日記なし、タップして新規作成`;
      const dayCell = screen.getByLabelText(expectedLabel);
      expect(dayCell.props.accessibilityRole).toBe('button');
      expect(dayCell.props.accessibilityState?.disabled).toBe(false);
    });

    it('sets an accessibilityLabel with the full date and plain "日記なし" (without the "タップして新規作成" suffix) on a future day cell without a diary entry, and marks it as accessibility-disabled, since future dates cannot be used to create a new entry', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const expectedLabel = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日、日記なし`;
      const dayCell = screen.getByLabelText(expectedLabel);
      expect(dayCell.props.accessibilityState?.disabled).toBe(true);
    });

    // showSixWeeksにより前後月の「はみ出し」日付セルも描画される。
    // それらのセルは常に日記が無い(entriesByDateには当月のキーしか存在しない)ため、
    // 実装が`title`のみを見てdisabled判定していることを踏まえ、はみ出しセルでも
    // 正しい年月日のaccessibilityLabelとaccessibilityState.disabled=trueが付くことを確認する
    it("sets a correct accessibilityLabel (with that day's own year/month, not the currently displayed month) and marks it as accessibility-disabled on overflow day cells belonging to an adjacent month", async () => {
      const now = new Date();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const noEntryCells = screen.getAllByLabelText(/^\d{4}年\d{1,2}月\d{1,2}日、日記なし$/);
      const currentMonthPrefix = `${now.getFullYear()}年${now.getMonth() + 1}月`;
      const overflowCells = noEntryCells.filter(
        (cell) => !(cell.props.accessibilityLabel as string).startsWith(currentMonthPrefix),
      );

      // showSixWeeksで常に6週(42セル)分描画され、当月の日数は最大でも31日のため、
      // 前月または翌月のはみ出しセルが必ず1つ以上存在する
      expect(overflowCells.length).toBeGreaterThan(0);
      overflowCells.forEach((cell) => {
        expect(cell.props.accessibilityState?.disabled).toBe(true);
      });
    });

    it('does nothing (does not navigate or open any modal) when tapping a future day cell, even though it has no diary entries, since future dates are excluded from both the day-entries and the new-entry-creation flow', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const label = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日、日記なし`;
      const dayCell = screen.getByLabelText(label);

      fireEvent.press(dayCell);

      expect(mockPush).not.toHaveBeenCalled();
      const modals = screen.UNSAFE_getAllByType(Modal);
      expect(modals.every((modal) => modal.props.visible === false)).toBe(true);
    });

    it('navigates to the day-entries screen for the tapped date when it has diary entries (一覧の内容自体はtests/app/day-entries/[date].test.tsxで検証する)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の出来事', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の出来事', createdAt: isoAt(now, dayWithEntry, 12, 0) },
        { id: '3', text: '夜の出来事', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 3件になったセルには件数バッジが表示されるため、日付の数字でタップする
      fireEvent.press(screen.getByText(String(dayWithEntry)));

      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);
    });

    it('sets statusBarTranslucent and navigationBarTranslucent on the new-entry creation modal and the month picker modal, so they match the edge-to-edge display of the screen behind them', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 新規作成モーダル・年月ピッカーモーダルの2つが常にツリーに存在する
      // (visibleプロパティで表示/非表示を切り替えているだけで、条件付きレンダリングではないため。
      // 日付一覧・編集は専用画面への遷移(Issue #221)に置き換えたため対象外になった)
      const modals = screen.UNSAFE_getAllByType(Modal);
      expect(modals).toHaveLength(2);
      for (const modal of modals) {
        expect(modal.props.statusBarTranslucent).toBe(true);
        expect(modal.props.navigationBarTranslucent).toBe(true);
      }
    });
  });

  describe('カレンダーの年月ジャンプ用ピッカー', () => {
    // react-native-calendarsに設定しているロケール(実装側のJA_MONTH_NAMES)と同じ表記。
    // 実装からは直接importできないため、テスト側でも同じ配列を用意する
    const MONTH_NAMES_JA = [
      '1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月',
      '11月',
      '12月',
    ];

    // react-native-calendarsのヘッダーは`importantForAccessibility="no-hide-descendants"`で
    // 内部テキストをアクセシビリティツリーから隠している(画面上には表示されている)ため、
    // `includeHiddenElements`を指定して検索する(既存の「カレンダー表示とモーダル」テストと同様)
    function findCalendarHeaderText(year: number, month: number) {
      return screen.findByText(`${year}年${month}月`, { includeHiddenElements: true });
    }

    // モーダルは[日付一覧, 編集, 新規作成, 年月ピッカー]の順でJSXに並んでいる
    // (実装側app/(tabs)/index.tsx参照)
    function getMonthPickerModal() {
      // 日付一覧・編集は専用画面への遷移(Issue #221)に置き換えたため、この画面に残る
      // モーダルは新規作成モーダル(index 0)・年月ピッカーモーダル(index 1)の2つのみになった
      return screen.UNSAFE_getAllByType(Modal)[1];
    }

    async function openMonthPicker(now: Date) {
      const headerText = await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1);
      fireEvent.press(headerText);
      await screen.findByText('年月を選択');
    }

    it('opens the month picker modal, showing a year stepper and all 12 month buttons, when the calendar header heading is tapped (正常系)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      expect(screen.getByText(`${now.getFullYear()}年`)).toBeTruthy();
      for (const monthName of MONTH_NAMES_JA) {
        expect(screen.getByText(monthName)).toBeTruthy();
      }
    });

    it('sets accessibilityRole="button" and a descriptive accessibilityLabel on the header heading, so it is discoverable as a tappable control by screen readers (正常系)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const headerButton = screen.getByLabelText(
        `${now.getFullYear()}年${now.getMonth() + 1}月、年月を選択して移動`,
        { includeHiddenElements: true },
      );
      expect(headerButton.props.accessibilityRole).toBe('button');
    });

    it('increments/decrements the picker year within the diary-backed year range, without jumping the calendar until a month button is pressed (正常系)', async () => {
      const now = new Date();
      const storedEntries = [
        {
          id: 'old',
          text: '前年の日記',
          createdAt: new Date(now.getFullYear() - 1, 0, 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      fireEvent.press(screen.getByLabelText('前の年'));
      expect(screen.getByText(`${now.getFullYear() - 1}年`)).toBeTruthy();

      fireEvent.press(screen.getByLabelText('次の年'));
      expect(screen.getByText(`${now.getFullYear()}年`)).toBeTruthy();

      // 年ステッパーの操作だけではカレンダー本体の表示月はまだジャンプしていない
      expect(await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1)).toBeTruthy();
    });

    it('disables the next-year stepper and future month buttons at the current year/month upper bound, so the picker cannot jump to an all-future calendar (境界値)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      const nextYearButton = screen.getByLabelText('次の年');
      expect(nextYearButton.props.accessibilityState?.disabled).toBe(true);

      const nextMonth = now.getMonth() + 2;
      if (nextMonth <= 12) {
        const [futureMonthButton] = screen.UNSAFE_getAllByProps({
          accessibilityLabel: `${now.getFullYear()}年${nextMonth}月へ移動`,
        });
        expect(futureMonthButton.props.accessibilityState?.disabled).toBe(true);

        fireEvent.press(futureMonthButton);
        expect(screen.getByText('年月を選択')).toBeTruthy();
        expect(await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1)).toBeTruthy();
      }

      fireEvent.press(nextYearButton);
      expect(screen.queryByText(`${now.getFullYear() + 1}年`)).toBeNull();
      expect(await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1)).toBeTruthy();
    });

    it('renders the year stepper buttons as chevron-left/chevron-right IconSymbols, not text glyphs', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      const prevYearButton = screen.getByLabelText('前の年');
      const nextYearButton = screen.getByLabelText('次の年');
      const [prevYearIcon] = prevYearButton.findAllByType(IconSymbol);
      const [nextYearIcon] = nextYearButton.findAllByType(IconSymbol);

      expect(prevYearIcon.props.name).toBe('chevron.left');
      expect(nextYearIcon.props.name).toBe('chevron.right');
    });

    it('jumps the calendar to the selected year/month and closes the modal when a month button is tapped (正常系)', async () => {
      const now = new Date();
      const targetYear = now.getFullYear() - 1;
      const storedEntries = [
        {
          id: 'old',
          text: '前年の日記',
          createdAt: new Date(targetYear, 0, 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      fireEvent.press(screen.getByLabelText('前の年'));
      fireEvent.press(screen.getByLabelText(`${targetYear}年3月へ移動`));

      // モーダルが閉じる
      await waitFor(() => expect(screen.queryByText('年月を選択')).toBeNull());

      // ヘッダーの見出しがジャンプ先の年月に更新される
      expect(await findCalendarHeaderText(targetYear, 3)).toBeTruthy();

      // Calendar本体へもジャンプ先のinitialDateが渡され、実際にその月へジャンプする
      const [calendar] = screen.UNSAFE_getAllByType(Calendar);
      expect(calendar.props.initialDate).toBe(`${targetYear}-03-01`);
    });

    it('closes the month picker modal without jumping when the semi-transparent background overlay is tapped, discarding unselected year-stepper changes (正常系: モーダルを閉じる操作)', async () => {
      const now = new Date();
      const storedEntries = [
        {
          id: 'old',
          text: '前年の日記',
          createdAt: new Date(now.getFullYear() - 1, 0, 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('前の年'));

      const overlay = getModalOverlayPressable(getMonthPickerModal());
      fireEvent.press(overlay);

      await waitFor(() => expect(screen.queryByText('年月を選択')).toBeNull());
      // 実際の表示年月は変わっていない
      expect(await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1)).toBeTruthy();
    });

    it('closes the month picker modal via its own close button ("閉じる"), matching the pattern used by the other modals (正常系)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));

      await waitFor(() => expect(screen.queryByText('年月を選択')).toBeNull());
    });

    it('resets the picker to the currently displayed year each time it is reopened, discarding any unselected year-stepper changes from a previous open (境界値)', async () => {
      const now = new Date();
      const storedEntries = [
        {
          id: 'old',
          text: '一昨年の日記',
          createdAt: new Date(now.getFullYear() - 2, 0, 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('前の年'));
      fireEvent.press(screen.getByLabelText('前の年'));
      expect(screen.getByText(`${now.getFullYear() - 2}年`)).toBeTruthy();

      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));
      await waitFor(() => expect(screen.queryByText('年月を選択')).toBeNull());

      await openMonthPicker(now);
      expect(screen.getByText(`${now.getFullYear()}年`)).toBeTruthy();
      expect(screen.queryByText(`${now.getFullYear() - 2}年`)).toBeNull();
    });

    it("clamps the picker's initial year to the current year when the calendar reports a future year via swipe/arrow navigation (境界値: 未来年)", async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const [calendar] = screen.UNSAFE_getAllByType(Calendar);
      const nextYear = now.getFullYear() + 1;
      act(() => {
        calendar.props.onMonthChange({
          year: nextYear,
          month: 1,
          day: 1,
          timestamp: new Date(nextYear, 0, 1).getTime(),
          dateString: `${nextYear}-01-01`,
        });
      });

      expect(await findCalendarHeaderText(nextYear, 1)).toBeTruthy();

      // ピッカーを開くと、未来年ではなく現在年を上限として初期選択する
      fireEvent.press(await findCalendarHeaderText(nextYear, 1));
      expect(await screen.findByText(`${now.getFullYear()}年`)).toBeTruthy();
      expect(screen.getByLabelText('次の年').props.accessibilityState?.disabled).toBe(true);
    });

    it('syncs the header heading to the new month when the calendar reports a month change crossing a year boundary backward (境界値: 1月→前年12月)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const [calendar] = screen.UNSAFE_getAllByType(Calendar);
      const previousYear = now.getFullYear() - 1;
      act(() => {
        calendar.props.onMonthChange({
          year: previousYear,
          month: 12,
          day: 1,
          timestamp: new Date(previousYear, 11, 1).getTime(),
          dateString: `${previousYear}-12-01`,
        });
      });

      expect(await findCalendarHeaderText(previousYear, 12)).toBeTruthy();
    });

    it('marks the month button matching the currently displayed year/month as selected (accessibilityState.selected), and other months as not selected (正常系/境界値)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      const currentMonthLabel = `${now.getFullYear()}年${MONTH_NAMES_JA[now.getMonth()]}へ移動`;
      const currentMonthButton = screen.getByLabelText(currentMonthLabel);
      expect(currentMonthButton.props.accessibilityState?.selected).toBe(true);

      const otherMonthIndex = (now.getMonth() + 6) % 12;
      const otherMonthLabel = `${now.getFullYear()}年${MONTH_NAMES_JA[otherMonthIndex]}へ移動`;
      const otherMonthButton = screen.getByLabelText(otherMonthLabel);
      expect(otherMonthButton.props.accessibilityState?.selected).toBe(false);
    });

    it("does not mark any month button as selected once the picker year has been stepped away from the currently displayed year, since none of that year's months match the display (境界値/異常系)", async () => {
      const now = new Date();
      const previousYear = now.getFullYear() - 1;
      const storedEntries = [
        {
          id: 'old',
          text: '前年の日記',
          createdAt: new Date(previousYear, 0, 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('前の年'));

      for (const monthName of MONTH_NAMES_JA) {
        const button = screen.getByLabelText(`${previousYear}年${monthName}へ移動`);
        expect(button.props.accessibilityState?.selected).toBe(false);
      }
    });

    it('uses the oldest diary month as the lower bound and disables earlier years/months in the picker (境界値)', async () => {
      const now = new Date();
      const minYear = now.getFullYear() - 2;
      const minMonth = 4;
      const storedEntries = [
        {
          id: 'oldest',
          text: '最古の日記',
          createdAt: new Date(minYear, minMonth - 1, 15, 9, 0, 0).toISOString(),
        },
        {
          id: 'newer',
          text: '新しい日記',
          createdAt: new Date(now.getFullYear(), now.getMonth(), 15, 9, 0, 0).toISOString(),
        },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('前の年'));
      fireEvent.press(screen.getByLabelText('前の年'));
      expect(screen.getByText(`${minYear}年`)).toBeTruthy();

      const prevYearButton = screen.getByLabelText('前の年');
      expect(prevYearButton.props.accessibilityState?.disabled).toBe(true);

      const beforeMinMonthButton = screen.getByLabelText(`${minYear}年${minMonth - 1}月へ移動`);
      expect(beforeMinMonthButton.props.accessibilityState?.disabled).toBe(true);

      const minMonthButton = screen.getByLabelText(`${minYear}年${minMonth}月へ移動`);
      expect(minMonthButton.props.accessibilityState?.disabled).toBe(false);
    });
  });

  describe('カレンダーセルの日記件数インジケーター(ドット/バッジ)', () => {
    // 日記が0件の日は何も表示せず、1件の日はドット(styles.entryDot)、2件以上の日は
    // 合計件数を表示する丸バッジ(styles.entryCountBadge)を表示する。
    // ドットは`width: 7, height: 7`、バッジ本体は`minWidth: 16, height: 16`という
    // 一意な組み合わせのスタイルを持つため、それぞれを目印にView自体を特定するヘルパーを用意する。
    function findEntryDotViews() {
      return screen.UNSAFE_getAllByType(View).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.width === 7 && flattened.height === 7;
      });
    }

    function findEntryCountBadgeViews() {
      return screen.UNSAFE_getAllByType(View).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.minWidth === 16 && flattened.height === 16;
      });
    }

    // バッジ内の件数テキスト(styles.entryCountText)を取得するヘルパー。日付セルの数字
    // (例: 二桁未満の日付は同じ文字列になりうる)と衝突しうるため、素朴なgetByText(String(count))
    // ではなく、バッジテキストに固有のスタイル(lineHeight: 11。詳細は下の回帰テストを参照)を
    // 目印に絞り込む。
    function findEntryCountBadgeTexts() {
      return screen.UNSAFE_getAllByType(Text).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.lineHeight === 11;
      });
    }

    it('shows neither a dot nor a count badge when there are no diary entries at all (境界値: 0件)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(findEntryDotViews()).toHaveLength(0);
      expect(findEntryCountBadgeViews()).toHaveLength(0);
    });

    it('shows a dot (not a count badge, and not the entry title) when a day has exactly 1 diary entry (正常系/境界値: 単一件数)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '1件のみの日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(findEntryDotViews()).toHaveLength(1);
      expect(findEntryCountBadgeViews()).toHaveLength(0);
      // 1件目のタイトル文字列自体はセルには表示されない(モーダルを開いたときのみ表示される)
      expect(screen.queryByText('1件のみの日記')).toBeNull();
    });

    it('shows a count badge displaying the total "2" (not "+1") when a day has exactly 2 diary entries (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(findEntryDotViews()).toHaveLength(0);
      const badgeTexts = findEntryCountBadgeTexts();
      expect(badgeTexts).toHaveLength(1);
      expect(String(badgeTexts[0].props.children)).toBe('2');
      expect(screen.queryByText('+1')).toBeNull();
      expect(findEntryCountBadgeViews()).toHaveLength(1);
      // セル自体にはどちらの日記のタイトルも表示されない
      expect(screen.queryByText('朝の日記')).toBeNull();
      expect(screen.queryByText('夜の日記')).toBeNull();
    });

    it('shows a count badge displaying the total "3" (not "+2") when a day has exactly 3 diary entries (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
        { id: '3', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const badgeTexts = findEntryCountBadgeTexts();
      expect(badgeTexts).toHaveLength(1);
      expect(String(badgeTexts[0].props.children)).toBe('3');
      expect(screen.queryByText('+2')).toBeNull();
    });

    it('shows a count badge displaying the total "4" when a day has 4 diary entries (正常系: 最小の複数件数境界(2件)より先まで正しくスケールすることの確認)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [0, 1, 2, 3].map((i) => ({
        id: `${i}`,
        text: `${i}件目の日記`,
        createdAt: isoAt(now, dayWithEntry, 6 + i * 4, 0),
      }));
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const badgeTexts = findEntryCountBadgeTexts();
      expect(badgeTexts).toHaveLength(1);
      expect(String(badgeTexts[0].props.children)).toBe('4');
      expect(findEntryCountBadgeViews()).toHaveLength(1);
    });

    it('does not show a dot or badge on a day with no entries (entriesByDate has no key for it), even while another day in the same month has multiple entries (境界値: entriesByDateにキーが無い日付)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 複数件の日には1つだけバッジが表示され、日記の無い日(dayWithoutEntry)には表示されない。
      // dayWithEntryとdayWithoutEntryの範囲は重複しないため、バッジが1個のみであることの確認は
      // dayWithoutEntry側にバッジが無いことの確認を兼ねる
      expect(findEntryCountBadgeViews()).toHaveLength(1);
      expect(findEntryDotViews()).toHaveLength(0);
    });

    it('renders the dot with tintColor as its background, following the same theme-color convention as the count badge (正常系: 単一件数のテーマ色)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '1件のみの日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const [dotView] = findEntryDotViews();
      expect(StyleSheet.flatten(dotView.props.style).backgroundColor).toBe(Colors.light.tint);
    });

    it('renders the badge with tintColor as its background and backgroundColor as its text color, following the same theme-color convention as the today badge (異常系/回帰防止: テーマ色の取り違え防止)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const [badgeText] = findEntryCountBadgeTexts();
      expect(StyleSheet.flatten(badgeText.props.style).color).toBe(Colors.light.background);

      const [badgeView] = findEntryCountBadgeViews();
      expect(StyleSheet.flatten(badgeView.props.style).backgroundColor).toBe(Colors.light.tint);
    });

    it("sets an explicit lineHeight close to fontSize on the badge text, overriding ThemedText's inherited default lineHeight so the digit stays vertically centered within the circle (回帰防止)", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const [badgeText] = findEntryCountBadgeTexts();
      const flattened = StyleSheet.flatten(badgeText.props.style);
      // ThemedTextのdefaultスタイルのlineHeight(24)をそのまま引き継ぐと、高さ16pxのバッジ内で
      // 数字が下寄りになるため、fontSizeに近い値が明示的に上書きされていることを確認する
      expect(flattened.lineHeight).toBe(11);
      expect(flattened.lineHeight).toBeLessThan(24);
    });

    it('shows a count badge displaying the total "11" (not "+10") when a day has 11 diary entries, confirming double-digit counts still render correctly inside the badge (境界値: 2桁の件数)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = Array.from({ length: 11 }, (_, i) => ({
        id: `${i}`,
        text: `${i}件目の日記`,
        createdAt: isoAt(now, dayWithEntry, i, 0),
      }));
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const badgeTexts = findEntryCountBadgeTexts();
      expect(badgeTexts).toHaveLength(1);
      expect(String(badgeTexts[0].props.children)).toBe('11');
      expect(screen.queryByText('+10')).toBeNull();
      expect(findEntryCountBadgeViews()).toHaveLength(1);
    });

    it('keeps the count badge visible after tapping the day cell to navigate to the day-entries screen (regression: badge does not disappear due to the navigation)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(findEntryCountBadgeViews()).toHaveLength(1);

      fireEvent.press(screen.getByText(String(dayWithEntry)));
      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);

      expect(findEntryCountBadgeViews()).toHaveLength(1);
      expect(String(findEntryCountBadgeTexts()[0].props.children)).toBe('2');
    });

    it('updates the badge from "2" to "3" once a third entry is saved for a day that already had 2 entries (正常系: 動的な件数増加への追従)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(String(findEntryCountBadgeTexts()[0].props.children)).toBe('2');

      // 保存欄からの追加は「今日」の日付にしか保存できない実装のため、pickTestDaysが選ぶ範囲
      // (10〜20日)と実行日が一致しない限り直接は再現できない。そのためAsyncStorageへ直接
      // 3件目を追記して再フォーカス相当の再読み込みを模す。
      const key = await getOrCreateEncryptionKey();
      const threeEntries = [
        ...storedEntries,
        { id: '3', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(threeEntries), key));
      triggerRefocus();

      await waitFor(() => expect(String(findEntryCountBadgeTexts()[0].props.children)).toBe('3'));
    });

    it('changes the dot to a count badge once a second entry is added to a day that had exactly 1 entry (正常系: ドットからバッジへの切り替わり)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '1件目の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(findEntryDotViews()).toHaveLength(1);
      expect(findEntryCountBadgeViews()).toHaveLength(0);

      const key = await getOrCreateEncryptionKey();
      const twoEntries = [
        ...storedEntries,
        { id: '2', text: '2件目の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(twoEntries), key));
      triggerRefocus();

      await waitFor(() => expect(findEntryCountBadgeViews()).toHaveLength(1));
      expect(findEntryDotViews()).toHaveLength(0);
      expect(String(findEntryCountBadgeTexts()[0].props.children)).toBe('2');
    });

    it('includes the entry count in the accessibilityLabel of a day cell with diary entries, e.g. "日記あり(3件)" (アクセシビリティ)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
        { id: '3', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日、日記あり(3件)`;
      expect(screen.getByLabelText(expectedLabel)).toBeTruthy();
    });

    it('includes the entry count of 1 in the accessibilityLabel of a day cell with a single diary entry, e.g. "日記あり(1件)" (アクセシビリティ/境界値)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '1件のみの日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日、日記あり(1件)`;
      expect(screen.getByLabelText(expectedLabel)).toBeTruthy();
    });
  });

  describe('日付セルのフォント拡大率の上限(maxFontSizeMultiplier)', () => {
    // OSの文字サイズ設定を拡大しても日付セル内テキストが際限なく拡大され最下段の週が
    // 見切れないよう、`maxFontSizeMultiplier`で上限が指定されていることを検証する。
    // react-native-calendars自体の月見出し・曜日行は常に`allowFontScaling={false}`のため対象外。
    const EXPECTED_MAX_FONT_SCALE = 1.5;

    it('caps the font scale multiplier at a value greater than 1 but not unbounded (sanity check on the constant itself)', () => {
      // 実装側の定数はモジュール外にexportされていないため、期待値自体が1(拡大なし)や
      // 極端に大きい値(実質無制限)ではない妥当な範囲であることをここで明記する
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

    it('sets maxFontSizeMultiplier on the entry-count badge text shown inside a day cell with 2 or more entries', async () => {
      const now = new Date();
      const day = pickNonTodayDayInRange(now);
      const storedEntries = [
        { id: '1', text: 'フォント拡大確認用の日記1', createdAt: isoAt(now, day, 7, 0) },
        { id: '2', text: 'フォント拡大確認用の日記2', createdAt: isoAt(now, day, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 日付セルの数字(例: 二桁未満の日付)と表示内容が衝突しうるため、バッジテキストに
      // 固有のスタイル(lineHeight: 11)を目印に絞り込む
      const [badgeText] = screen.UNSAFE_getAllByType(Text).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.lineHeight === 11;
      });
      expect(badgeText.props.maxFontSizeMultiplier).toBe(EXPECTED_MAX_FONT_SCALE);
    });

    it('still shows the day number and entry-count badge as before (regression check: adding maxFontSizeMultiplier does not change rendered content)', async () => {
      const now = new Date();
      const day = pickNonTodayDayInRange(now);
      const storedEntries = [
        { id: '1', text: '回帰確認用の日記1', createdAt: isoAt(now, day, 7, 0) },
        { id: '2', text: '回帰確認用の日記2', createdAt: isoAt(now, day, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const badgeViews = screen.UNSAFE_getAllByType(View).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.minWidth === 16 && flattened.height === 16;
      });
      expect(badgeViews).toHaveLength(1);
      expect(screen.getByText(String(day))).toBeTruthy();
    });
  });

  describe('日記の無い日をタップした新規作成モーダル', () => {
    // 対象日('YYYY年M月D日、日記なし、タップして新規作成')のアクセシビリティラベルからセルを特定する
    function pastOrTodayCellLabel(date: Date): string {
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日、日記なし、タップして新規作成`;
    }

    function openNewEntryModalFor(date: Date) {
      fireEvent.press(screen.getByLabelText(pastOrTodayCellLabel(date)));
    }

    // 新規作成モーダルの保存ボタンは、composer(画面上部の入力欄)と同じ文言「保存」を使うため、
    // `getByText('保存')`だと2件ヒットする(編集モーダルを一度も開いていなければ、その分は
    // マウントされない)。JSXの描画順(composerが先、新規作成モーダルが後)に依存して2件目を取得する。
    function getNewEntrySaveButton() {
      const saveButtons = screen.getAllByText('保存');
      expect(saveButtons).toHaveLength(2);
      return saveButtons[1];
    }

    // 新規作成モーダルのTextInputは、composerと同じaccessibilityLabel「日記本文」を使うため、
    // placeholderの違いで特定する
    function getNewEntryInput() {
      const inputs = screen.getAllByLabelText('日記本文');
      const input = inputs.find(
        (candidate) => candidate.props.placeholder === 'その日の出来事や気持ちを書いてみましょう',
      );
      expect(input).toBeTruthy();
      return input!;
    }

    it('opens the new-entry modal (does not navigate to the day-entries screen) with a heading and placeholder for the tapped date, when a day without any diary entries that is today or in the past is tapped (正常系)', async () => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      openNewEntryModalFor(yesterday);

      const heading = `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日の日記を書く`;
      expect(await screen.findByText(heading)).toBeTruthy();
      expect(getNewEntryInput().props.placeholder).toBe('その日の出来事や気持ちを書いてみましょう');

      const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
      expect(newEntryModal.props.visible).toBe(true);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("saves a new entry anchored to local noon of the tapped date as createdAt (regardless of the current time-of-day), persists it encrypted, closes the modal, and reflects the entry in that day's calendar cell", async () => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      jest.clearAllMocks();

      openNewEntryModalFor(yesterday);
      fireEvent.changeText(getNewEntryInput(), '過去日の新規日記');
      fireEvent.press(getNewEntrySaveButton());

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      const persisted = (await decryptPersistedEntry(value)) as DiaryEntry;
      expect(persisted.text).toBe('過去日の新規日記');

      // createdAtはタップした日付の「ローカル正午」になっており、現在時刻(now)には依存しない
      const createdAt = new Date(persisted.createdAt);
      expect(createdAt.getFullYear()).toBe(yesterday.getFullYear());
      expect(createdAt.getMonth()).toBe(yesterday.getMonth());
      expect(createdAt.getDate()).toBe(yesterday.getDate());
      expect(createdAt.getHours()).toBe(12);
      expect(createdAt.getMinutes()).toBe(0);
      expect(createdAt.getSeconds()).toBe(0);

      // 保存に成功するとモーダルが閉じる
      await waitFor(() => {
        const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
        expect(newEntryModal.props.visible).toBe(false);
      });

      // entriesByDateはcreatedAtの日付(=タップした日付)をキーにするため、
      // 対象日のカレンダーセルに日記件数インジケーターとして反映される
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
    });

    it('shows an error message and rolls back the optimistic calendar update when persisting the new entry fails, keeping the modal open with the input preserved (異常系)', async () => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      jest.clearAllMocks();
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      openNewEntryModalFor(yesterday);
      fireEvent.changeText(getNewEntryInput(), '保存失敗する新規日記');
      fireEvent.press(getNewEntrySaveButton());

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();

      // ロールバックにより、カレンダーセルにはタイトルが反映されない
      expect(screen.queryByText('保存失敗する新規日記')).toBeNull();

      // モーダルは開いたままで、入力内容も保持されている
      const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
      expect(newEntryModal.props.visible).toBe(true);
      expect(getNewEntryInput().props.value).toBe('保存失敗する新規日記');
    });

    it('disables the save button while the new-entry input is empty or whitespace-only, and does not call AsyncStorage.setItem, matching disabled={!newEntryDraft.trim()} (異常系/境界値)', async () => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      jest.clearAllMocks();

      openNewEntryModalFor(yesterday);
      const saveButton = getNewEntrySaveButton().parent?.parent?.parent;
      expect(saveButton?.props.accessibilityState?.disabled).toBe(true);
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);

      fireEvent.changeText(getNewEntryInput(), '   \n   ');
      expect(saveButton?.props.accessibilityState?.disabled).toBe(true);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      fireEvent.changeText(getNewEntryInput(), '空でなくなった');
      expect(saveButton?.props.accessibilityState?.disabled).toBe(false);
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(1);
    });

    it('truncates input exceeding BODY_MAX_LENGTH via onChangeText (grapheme-based, no maxLength prop), and allows saving when the text is exactly at the limit (境界値)', async () => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      jest.clearAllMocks();

      openNewEntryModalFor(yesterday);
      const input = getNewEntryInput();

      // 上限を1文字超えるテキストは、grapheme単位でちょうど上限文字数まで切り詰められる
      fireEvent.changeText(input, 'あ'.repeat(1001));
      expect(input.props.value).toBe('あ'.repeat(1000));
      expect(screen.getByText('1000/1000')).toBeTruthy();

      // 上限ちょうどの文字数は切り詰められず、そのまま保存できる
      fireEvent.press(getNewEntrySaveButton());
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntry(value)) as DiaryEntry;
      expect(persisted.text).toBe('あ'.repeat(1000));
    });

    describe('新規作成モーダルを閉じる際の未保存入力の破棄確認ダイアログ', () => {
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

      it('closes the modal immediately without any confirmation dialog via the close button when the input is still empty (正常系)', async () => {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        openNewEntryModalFor(yesterday);
        const heading = `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日の日記を書く`;
        await screen.findByText(heading);

        const closeButtons = screen.getAllByText(CLOSE_BUTTON_TEXT);
        fireEvent.press(closeButtons[closeButtons.length - 1]);

        await waitFor(() => expect(screen.queryByText(heading)).toBeNull());
        expect(Alert.alert).not.toHaveBeenCalled();
      });

      it('shows the discard confirmation dialog when the background overlay is tapped after typing, and keeps the modal open until "破棄" is chosen (正常系)', async () => {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        openNewEntryModalFor(yesterday);
        fireEvent.changeText(getNewEntryInput(), '破棄されるはずの下書き');

        const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
        const overlay = getModalOverlayPressable(newEntryModal);
        fireEvent.press(overlay);

        // ダイアログが出た段階ではまだモーダルは開いたままで、破棄もされていない
        expect(Alert.alert).toHaveBeenCalledTimes(1);
        expect(newEntryModal.props.visible).toBe(true);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();

        await pressAlertButton('破棄');

        await waitFor(() => expect(newEntryModal.props.visible).toBe(false));
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      });

      it('keeps the modal open and preserves the unsaved draft when "キャンセル" is chosen in the discard confirmation dialog (異常系)', async () => {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        openNewEntryModalFor(yesterday);
        fireEvent.changeText(getNewEntryInput(), 'キャンセルで残るはずの下書き');

        const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
        const overlay = getModalOverlayPressable(newEntryModal);
        fireEvent.press(overlay);

        await pressAlertButton('キャンセル');

        expect(newEntryModal.props.visible).toBe(true);
        expect(getNewEntryInput().props.value).toBe('キャンセルで残るはずの下書き');
      });
    });

    it('does not open the new-entry modal when tapping a day that already has diary entries; navigates to the day-entries screen instead', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(screen.getByText(String(dayWithEntry)));

      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);
      const [newEntryModal] = screen.UNSAFE_getAllByType(Modal);
      expect(newEntryModal.props.visible).toBe(false);
    });

    it("keeps the top composer's save flow (createdAt = the current moment, not local noon of a tapped date) unaffected by the new per-date creation modal", async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      jest.clearAllMocks();

      const beforeSave = Date.now();
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日書いた日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const afterSave = Date.now();
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntry(value)) as DiaryEntry;

      const createdAtMs = new Date(persisted.createdAt).getTime();
      expect(createdAtMs).toBeGreaterThanOrEqual(beforeSave);
      expect(createdAtMs).toBeLessThanOrEqual(afterSave);
    });
  });

  describe('タブ再フォーカス時にpending中の書き込みキューを待ってから読み直す', () => {
    it('does not flicker back to stale data when useFocusEffect refires while a save is still pending in the write queue', async () => {
      const now = new Date();
      // 新規保存したエントリはcreatedAtが実行時点の「今日」になるため、既存エントリは
      // 「今日」とは別の日にしておき、カレンダー上で2つのタイトルを独立して検証できるようにする
      const existingDay = pickNonTodayDayInRange(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: 'existing', text: '既存の日記', createdAt: isoAt(now, existingDay) },
        ]),
      );
      jest.clearAllMocks();

      // 保存の永続化書き込み(enqueueDiaryWrite内のsetItem)の完了タイミングを制御できるようにする。
      // 既存の直列化テストと同様、実際のAsyncStorageへの書き込み自体は元の実装
      // 経由で行い、完了タイミングだけを遅延させる
      const originalSetItem = AsyncStorage.setItem;
      let resolveSaveWrite: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        (key: string, value: string) =>
          new Promise<void>((resolve) => {
            resolveSaveWrite = () => {
              originalSetItem(key, value).then(resolve);
            };
          }),
      );

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);

      // 新規保存を開始する。楽観的UI更新は同期的に反映されるが、AsyncStorageへの実際の
      // 書き込み(enqueueDiaryWrite内のsetItem)はpendingのまま止まる
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '新しい日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      // 楽観的UI更新により、書き込みが完了する前から新しい日記のセルが一覧に加わっている
      // (既存の日記の日・新規保存(今日)の日、あわせて2セル)
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(2);

      const getItemMock = AsyncStorage.getItem as jest.Mock;
      const getItemCallsWhilePending = getItemMock.mock.calls.length;

      // 書き込みがまだpending中に、useFocusEffectの再発火(タブへの再フォーカス)を模す
      act(() => {
        (triggerRefocus as () => void)();
      });

      // 修正前は、pending中の書き込みを待たずに即座にAsyncStorageを読み直し、まだ反映されていない
      // 古い内容で一覧を上書きしてしまっていた。修正後はキューの完了を待つため追加のgetItem呼び出しは発生しない
      expect(getItemMock.mock.calls.length).toBe(getItemCallsWhilePending);
      // 読み直しがブロックされている間も、楽観的更新済みの新しい日記のセルが古い状態へ
      // 巻き戻ってちらつくことはない
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(2);

      // pending中の書き込みを完了させる
      await act(async () => {
        resolveSaveWrite();
      });

      // 書き込み完了後、待たされていた読み直しが実行され、AsyncStorage.getItemが追加で呼ばれる
      await waitFor(() =>
        expect(getItemMock.mock.calls.length).toBeGreaterThan(getItemCallsWhilePending),
      );

      // 最終的に画面には、pending中だった書き込みが反映された最新の状態(既存+新規)が
      // 表示され続けている(一時的にせよ新しい日記のセルが消えることはなかった)
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(2);

      // 実際に永続化された内容にも新しい日記が反映されている(新規保存は自分専用の個別キーに書き込まれる)
      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const [, lastValue] = setItemMock.mock.calls[setItemMock.mock.calls.length - 1];
      const persisted = (await decryptPersistedEntry(lastValue)) as { id: string; text: string };
      expect(persisted.text).toBe('新しい日記');
      // 既存のエントリも(個別キー方式へ移行済みのまま)引き続き残っている
      expect(await readPersistedEntry('existing')).not.toBeNull();
    });

    // pending中の書き込みが無い通常時は、余分な待ち合わせをせず即座に読み直す従来通りの
    // 挙動を維持していることを確認する回帰テスト(loadEntries冒頭のawaitは
    // pendingWriteCountRef.current > 0のときのみ行われる)
    it('reloads immediately on refocus when there is no pending write in the queue (regression check for normal refetch behavior)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: 'existing', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);

      const getItemMock = AsyncStorage.getItem as jest.Mock;
      const callsBeforeRefocus = getItemMock.mock.calls.length;

      // pending中の書き込みが存在しない状態で再フォーカスした場合、待ち合わせ無く
      // 即座に読み直しが実行される
      act(() => {
        (triggerRefocus as () => void)();
      });

      await waitFor(() =>
        expect(getItemMock.mock.calls.length).toBeGreaterThan(callsBeforeRefocus),
      );
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
    });
  });

  describe('テーマに応じたエラー色', () => {
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

    // 編集失敗時のエラーメッセージ・削除リンクのダークモード配色は、それぞれ専用画面へ移動したため
    // tests/app/edit-entry/[id].test.tsx・tests/app/day-entries/[date].test.tsxで検証する(Issue #221)
  });

  describe('日記のキーワード検索', () => {
    it('does not show the search results list while the search input is empty (regular calendar view is shown)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 検索欄は表示されているが、キーワード未入力のうちは検索結果一覧(「見つかりませんでした」等)は表示されない
      expect(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER)).toBeTruthy();
      expect(screen.queryByText('見つかりませんでした')).toBeNull();
    });

    it('shows matching entries (case-insensitive, partial match) as a search results list once a keyword is entered', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
          { id: '2', text: '仕事で疲れた一日だった', createdAt: isoAt(now, dayWithoutEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
      fireEvent.changeText(searchInput, '公園');

      expect(await screen.findByText(/公園/)).toBeTruthy();
      expect(screen.queryByText(/仕事で疲れた/)).toBeNull();
    });

    it('shows a "見つかりませんでした" message when no entry matches the keyword', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(
        screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER),
        '該当しないはずのキーワード',
      );

      expect(await screen.findByText('見つかりませんでした')).toBeTruthy();
    });

    it('restores the normal calendar view once the search keyword is cleared back to empty', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
      fireEvent.changeText(searchInput, '該当しないはずのキーワード');
      expect(await screen.findByText('見つかりませんでした')).toBeTruthy();

      fireEvent.changeText(searchInput, '');
      await waitFor(() => expect(screen.queryByText('見つかりませんでした')).toBeNull());
      // 通常のカレンダー表示(セル)に戻っている
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
    });

    it('navigates to the day-entries screen for the date of the tapped search result', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry, 9, 0) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      const resultItem = await screen.findByText(/公園/);
      fireEvent.press(resultItem);

      expect(mockPush).toHaveBeenCalledWith(`/day-entries/${toDateKeyForTest(now, dayWithEntry)}`);
    });

    it('excerpts the matched portion of the entry text (with surrounding context) rather than only the first line, unlike the calendar cell title', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      // 1行目には検索キーワードを含めず、本文の途中(2行目以降)にキーワードを配置する。
      // カレンダーセルのタイトル(1行目のみ)には現れないキーワードで検索結果に表示されることを確認する
      const longEntryText = 'あ'.repeat(30) + '\n' + 'ここに検索キーワードのりんごが登場する';
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: longEntryText, createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'りんご');

      expect(await screen.findByText(/りんご/)).toBeTruthy();
    });

    it('shows the diary date above each search result excerpt', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      await screen.findByText(/公園/);

      expect(
        screen.getByText(`${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日`),
      ).toBeTruthy();
    });

    it('matches regardless of ASCII letter case (真の大文字小文字混在ケース。日本語の文字自体には大文字小文字の区別が無いため、既存テストとは別にASCII文字で検証する)', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日はAppleパイを食べた', createdAt: isoAt(now, dayWithEntry) },
          { id: '2', text: '仕事で疲れた一日だった', createdAt: isoAt(now, dayWithoutEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);

      // 本文中は先頭大文字の"Apple"だが、全て小文字の"apple"で検索してもヒットする
      fireEvent.changeText(searchInput, 'apple');
      expect(await screen.findByText(/Apple/)).toBeTruthy();
      expect(screen.queryByText(/仕事で疲れた/)).toBeNull();

      // 全て大文字の"APPLE"でもヒットする
      fireEvent.changeText(searchInput, 'APPLE');
      expect(await screen.findByText(/Apple/)).toBeTruthy();
    });

    it('treats a whitespace-only search query the same as an empty query (regular calendar view stays shown, no results list)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 空白のみのキーワードはtrim後に空文字列として扱われ、検索結果一覧(0件メッセージ含む)は表示されない
      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '   ');

      expect(screen.queryByText('見つかりませんでした')).toBeNull();
      expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
    });

    it('sorts multiple matching search results by date, newest first', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: 'old', text: '古い日の公園散歩の記録', createdAt: isoAt(now, dayWithEntry, 8, 0) },
          {
            id: 'new',
            text: '新しい日の公園散歩の記録',
            createdAt: isoAt(now, dayWithoutEntry, 8, 0),
          },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園散歩');
      await screen.findByText(/新しい日の公園散歩/);
      expect(screen.getByText(/古い日の公園散歩/)).toBeTruthy();

      // 新しい日付のエントリ(dayWithoutEntry)が、古い日付のエントリ(dayWithEntry)より先に表示される
      const texts = flattenTexts(screen.toJSON());
      expect(texts.indexOf('新しい日の公園散歩の記録')).toBeLessThan(
        texts.indexOf('古い日の公園散歩の記録'),
      );
    });

    it('truncates the excerpt with an ellipsis (…) on both sides when the match is surrounded by more than the context length on each side (boundary)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      // マッチ箇所(りんご)の前後にSEARCH_EXCERPT_CONTEXT_LENGTH(20文字)を超える文字を配置し、
      // 抜粋の前後両方が切り詰められて省略記号が付くケースを検証する
      const longEntryText = 'あ'.repeat(30) + 'りんご' + 'い'.repeat(30);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: longEntryText, createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'りんご');

      const resultText = await screen.findByText(/りんご/);
      const excerpt = resultText.props.children as string;
      expect(excerpt.startsWith('…')).toBe(true);
      expect(excerpt.endsWith('…')).toBe(true);
      // マッチ全体(前後の文脈込み)は元の本文よりも短く切り詰められている
      expect(excerpt.length).toBeLessThan(longEntryText.length);
    });

    it('sets maxLength={1000} (BODY_MAX_LENGTH) on the search input, so it cannot exceed the diary body max length itself', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
      // composer/edit用のTextInputとは異なりgrapheme単位の切り詰めロジックは持たないため、
      // ネイティブのmaxLength propがBODY_MAX_LENGTH(1000)に設定されていることを直接確認する
      expect(searchInput.props.maxLength).toBe(1000);
    });

    describe('検索欄のクリアボタン', () => {
      it('does not show the clear button while the search input is empty', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        expect(screen.queryByLabelText('検索キーワードをクリア')).toBeNull();
      });

      it('shows the clear button once a keyword is entered', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');

        expect(screen.getByLabelText('検索キーワードをクリア')).toBeTruthy();
      });

      it('clears the search query and restores the normal calendar view when the clear button is pressed', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '今日は公園を散歩した', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
        fireEvent.changeText(searchInput, '公園');
        expect(await screen.findByText(/公園/)).toBeTruthy();

        fireEvent.press(screen.getByLabelText('検索キーワードをクリア'));

        expect(searchInput.props.value).toBe('');
        // クリア後は検索結果一覧ではなく通常のカレンダー表示(セル)に戻り、
        // クリアボタン自体も再び非表示になる
        await waitFor(() => expect(screen.queryByLabelText('検索キーワードをクリア')).toBeNull());
        expect(queryCalendarDayButtonsWithEntry()).toHaveLength(1);
      });

      it('shows the clear button even for a whitespace-only query, even though the calendar view (not the results list) stays shown (boundary: clear button visibility uses the raw searchQuery, not the trimmed value)', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '   ');

        // trim後は空文字列扱いのため検索結果一覧(0件メッセージ含む)は出さない一方、
        // クリアボタンは入力欄が空文字列そのものでない限り表示され続ける
        expect(screen.queryByText('見つかりませんでした')).toBeNull();
        expect(screen.getByLabelText('検索キーワードをクリア')).toBeTruthy();
      });

      it('clears a whitespace-only query when the clear button is pressed', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
        fireEvent.changeText(searchInput, '   ');

        fireEvent.press(screen.getByLabelText('検索キーワードをクリア'));

        expect(searchInput.props.value).toBe('');
        expect(screen.queryByLabelText('検索キーワードをクリア')).toBeNull();
      });

      it('sets accessibilityRole="button" in addition to accessibilityLabel on the clear button', async () => {
        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');

        const clearButton = screen.getByLabelText('検索キーワードをクリア');
        expect(clearButton.props.accessibilityRole).toBe('button');
      });
    });

    describe('全角/半角・ひらがな/カタカナの表記ゆれ吸収', () => {
      it('matches a full-width digit query ("１２３") against an entry body containing half-width digits ("123")', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '今日は123円のパンを買った', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '１２３');

        expect(await screen.findByText(/123/)).toBeTruthy();
      });

      it('matches a half-width digit query ("123") against an entry body containing full-width digits ("１２３")', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '今日は１２３円のパンを買った', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '123');

        expect(await screen.findByText(/１２３/)).toBeTruthy();
      });

      it('matches a hiragana query ("らーめん") against an entry body containing katakana ("ラーメン")', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '昼にラーメンを食べた', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'らーめん');

        expect(await screen.findByText(/ラーメン/)).toBeTruthy();
      });

      it('matches a katakana query ("ラーメン") against an entry body containing hiragana ("らーめん")', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '昼にらーめんを食べた', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'ラーメン');

        expect(await screen.findByText(/らーめん/)).toBeTruthy();
      });

      it('matches a half-width katakana query ("ｺｰﾋｰ") against an entry body containing full-width katakana ("コーヒー")', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '朝はコーヒーを飲んだ', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'ｺｰﾋｰ');

        expect(await screen.findByText(/コーヒー/)).toBeTruthy();
      });

      it('still matches regardless of ASCII letter case even when combined with full-width normalization', async () => {
        const now = new Date();
        const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '今日はCafeでコーヒーを飲んだ', createdAt: isoAt(now, dayWithEntry) },
            { id: '2', text: '仕事で疲れた一日だった', createdAt: isoAt(now, dayWithoutEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        // 大文字小文字表記ゆれ(既存機能)と全角/半角表記ゆれ(今回の対応)が両方壊れていないことを、
        // 全て小文字の半角"cafe"で検索して確認する
        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), 'cafe');
        expect(await screen.findByText(/Cafe/)).toBeTruthy();
        expect(screen.queryByText(/仕事で疲れた/)).toBeNull();
      });

      it('shows no search results (見つかりませんでした) when the normalized query does not match any entry', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '今日は123円のパンを買った', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        // 全角へ正規化しても本文には存在しない数字なので、ヒットしない
        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '４５６');

        expect(await screen.findByText('見つかりませんでした')).toBeTruthy();
      });

      it('excerpts the original (non-normalized) text at the correct position even when the match was found via normalization', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        // マッチ箇所(全角の１２３)の前後にSEARCH_EXCERPT_CONTEXT_LENGTH(20文字)を超える文字を配置し、
        // 正規化後の文字列上で見つけたマッチ位置を、元の文字列(全角のまま)上の正しい位置へ
        // 復元できているかを検証する
        const longEntryText = 'あ'.repeat(25) + '１２３' + 'い'.repeat(25);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([{ id: '1', text: longEntryText, createdAt: isoAt(now, dayWithEntry) }]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        // 半角の"123"で検索するが、抜粋には元の本文にある全角の"１２３"がそのまま現れるはず
        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '123');

        const resultText = await screen.findByText(/１２３/);
        const excerpt = resultText.props.children as string;
        // マッチ位置(matchStart=25, matchEnd=28)から前後20文字ずつ、両端は省略記号付きで
        // 切り詰められた、元の文字列上の正しい範囲がそのまま抜粋されていることを厳密に検証する
        expect(excerpt).toBe(`…${'あ'.repeat(20)}１２３${'い'.repeat(20)}…`);
      });

      it('excerpts the original text at the correct position even when the body contains surrogate-pair emoji before the match (regression)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        // マッチ箇所('123')より前にサロゲートペア絵文字(UTF-16で2コードユニット)を3つ配置し、
        // 正規化後の文字列と元の文字列の対応付け(startMap/endMap)が絵文字によってズレないかを検証する
        const longEntryText = '😀'.repeat(3) + 'あ'.repeat(30) + '123' + 'い'.repeat(30);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([{ id: '1', text: longEntryText, createdAt: isoAt(now, dayWithEntry) }]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '123');

        const resultText = await screen.findByText(/123/);
        const excerpt = resultText.props.children as string;
        // 絵文字によるズレが無ければ、マッチ箇所の前後はちょうど20文字ずつになるはず
        expect(excerpt).toBe(`…${'あ'.repeat(20)}123${'い'.repeat(20)}…`);
      });
    });
  });
});
