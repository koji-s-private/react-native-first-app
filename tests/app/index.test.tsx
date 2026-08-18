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
  useColorScheme,
  View,
} from 'react-native';
import { Calendar } from 'react-native-calendars';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/(tabs)/index';
import { TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID } from '@/components/tab-screen-container';
import { Colors } from '@/constants/theme';
import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import { buildDiaryEntryKey, type DiaryEntry } from '@/utils/diary-storage';

// `expo-router`の`Link`(Trigger/Preview/Menuを伴う複合API)はナビゲーション/routerコンテキストを
// 要求するため、単体レンダリングでも動くよう単純なパススルーコンポーネントに差し替える。
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

  return { Link, useFocusEffect, __triggerRefocus };
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
// expo-hapticsも、保存成功時のハプティックフィードバック(Issue #55)を呼び出し引数まで
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
const { __triggerRefocus: triggerRefocus } = require('expo-router') as {
  __triggerRefocus: () => void;
};

const STORAGE_KEY = 'diary-entries';
const ENCRYPTED_PREFIX = 'encrypted:v1:';
const INPUT_PLACEHOLDER = '今日の出来事や気持ちを書いてみましょう';
// 日記本文のキーワード検索用の入力欄(composerとは別の検索専用入力欄、Issue #81)
const SEARCH_INPUT_PLACEHOLDER = '日記を検索';
const CLOSE_BUTTON_TEXT = '閉じる';
// 日記が0件のときにカレンダーの上に表示される案内メッセージ
const EMPTY_STATE_TEXT = 'まだ日記がありません。最初の日記を書いてみましょう。';
const KEYBOARD_AVOIDING_VIEW_TEST_ID = 'keyboard-avoiding-view';

// Issue #34で保存ボタンにaccessibilityRole="button"を付与したことで、
// `queryAllByRole('button')`は常に保存ボタンを含むようになった。カレンダーの日付セル
// (日記のある日だけがタップ可能なボタンとして描画される)の個数だけを数えたいテストでは、
// 保存ボタンを除外したこのヘルパーを使う。
function queryCalendarDayButtons() {
  return screen
    .queryAllByRole('button')
    .filter((button) => button.props.accessibilityLabel !== '保存');
}

// AsyncStorageに実際に永続化された値(暗号化済み文字列)を、テストで検証しやすいよう
// 復号してJSONとしてパースするヘルパー。エントリ単位のキー方式(Issue #83)では
// 1つの暗号化文字列は常に1エントリ分のオブジェクトを表す。`getOrCreateEncryptionKey`は
// SecureStoreモックに永続化された鍵をそのまま返すため、画面側が使った鍵と同じ鍵が得られる。
async function decryptPersistedEntry(encryptedValue: string): Promise<unknown> {
  const key = await getOrCreateEncryptionKey();
  return JSON.parse(decryptText(encryptedValue, key));
}

// テストの事前状態として、指定したエントリ群をエントリ単位の個別キー(`diary-entry:<id>`)へ
// 暗号化して直接書き込むヘルパー。実装側(utils/diary-storage.ts)の保存方式と揃えることで、
// レガシーの単一キー方式からの移行(マイグレーション)を経由せずに直接テスト対象の状態を作れる。
async function seedDiaryEntries(entries: DiaryEntry[]): Promise<void> {
  const key = await getOrCreateEncryptionKey();
  for (const entry of entries) {
    await AsyncStorage.setItem(
      buildDiaryEntryKey(entry.id),
      encryptText(JSON.stringify(entry), key),
    );
  }
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

// 実装側(`app/(tabs)/index.tsx`)の非公開関数`formatEntryDateTime`と同じ'YYYY/MM/DD HH:mm'形式で
// 日時を整形するテスト用ヘルパー。エントリ一覧モーダル内の時刻表示を検証するために使う
function formatEntryDateTimeForTest(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
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

// 日付一覧モーダルの背景オーバーレイPressableを特定するヘルパー(Issue #84)。実装側は
// `modalOverlay`スタイルをエクスポートしていないため、同じ背景色を手がかりに探す。
const MODAL_OVERLAY_BACKGROUND_COLOR = 'rgba(0, 0, 0, 0.4)';
function getModalOverlayPressable(modal: TestNode): TestNode {
  const overlay = modal
    .findAll((node: TestNode) => typeof node.props.onPress === 'function')
    .find(
      (node: TestNode) =>
        StyleSheet.flatten(node.props.style).backgroundColor === MODAL_OVERLAY_BACKGROUND_COLOR,
    );
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
  // act(...)`)を引き起こすことがある(Issue #196)。Jestはネストした`describe`内の`afterEach`を
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

  describe('背景タップでキーボードを閉じる(Issue #50)', () => {
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
    // で直接特定できる。また、日付一覧モーダルはReact Native実装上、一度も開いていない
    // (visible=falseのまま)状態では内部state `isRendered` もfalseのままで中身がマウントされない
    // (一度trueになると閉じてもマウントされ続ける)ため、検証には先に日付セルをタップして開く必要がある。
    function queryAllFlatLists() {
      return screen.UNSAFE_queryAllByType(FlatList);
    }

    it('does not mount the entry-list modal FlatList until the modal has been opened at least once (前提条件の確認)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(queryAllFlatLists()).toHaveLength(0);
    });

    it('sets keyboardDismissMode="on-drag" on the entry-list modal FlatList once it is opened, so dragging it also dismisses the keyboard (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { id: '1', text: 'キーボード確認用の日記', createdAt: isoAt(now, dayWithEntry) },
        ]),
      );
      jest.clearAllMocks();

      render(<HomeScreen />);
      await screen.findByText('キーボード確認用の日記');

      fireEvent.press(screen.getByText('キーボード確認用の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      // 検索キーワード未入力のため、日付一覧モーダル用のFlatListのみが該当する
      const flatLists = queryAllFlatLists();
      expect(flatLists).toHaveLength(1);
      expect(flatLists[0].props.keyboardDismissMode).toBe('on-drag');
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
      await screen.findByText('今日は公園を散歩した');

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      await screen.findByText(/公園/);

      // 日付一覧モーダルは未オープンのため、検索結果一覧用のFlatListのみが該当する
      const flatLists = queryAllFlatLists();
      expect(flatLists).toHaveLength(1);
      expect(flatLists[0].props.keyboardDismissMode).toBe('on-drag');
    });

    it('sets keyboardDismissMode="on-drag" on both FlatLists simultaneously when the entry-list modal is left open while a search keyword is also entered (境界値: 両方が同時にマウントされているケース)', async () => {
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
      await screen.findByText('今日は公園を散歩した');

      // 日付一覧モーダルを開いたまま(閉じない)にしておく。visible=falseに戻ると
      // モーダル内のFlatListがアンマウントされてしまうため、開いたまま検索欄を操作することで
      // 2つのFlatListが同時にマウントされている状態を再現する
      fireEvent.press(screen.getByText('今日は公園を散歩した'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      // 検索結果一覧用のFlatListがマウントされたことを、対象のFlatListが2つに増えたことで確認する
      await waitFor(() => expect(queryAllFlatLists()).toHaveLength(2));

      const flatLists = queryAllFlatLists();
      for (const flatList of flatLists) {
        expect(flatList.props.keyboardDismissMode).toBe('on-drag');
      }
    });
  });

  describe('日記の保存', () => {
    it('does not save and does not call AsyncStorage.setItem when the input is empty', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(queryCalendarDayButtons()).toHaveLength(0);
    });

    it('does not save an entry consisting only of whitespace', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '   \n   ');
      fireEvent.press(screen.getByText('保存'));

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(queryCalendarDayButtons()).toHaveLength(0);
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

    describe('絵文字(サロゲートペア・ZWJ結合絵文字)を含む本文の文字数カウント・切り詰め(Issue #139)', () => {
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

    // Issue #34: スクリーンリーダー利用者にも入力欄・保存ボタンの役割が伝わるよう、
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

    it('renders the save button at reduced opacity (0.5) while the input is empty, and at full opacity (1) once text is entered, so the disabled state is also visible (正常系/境界値, Issue #42)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const saveButton = screen.getByText('保存').parent?.parent?.parent;
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(0.5);

      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '何か書く');
      expect(StyleSheet.flatten(saveButton?.props.style).opacity).toBe(1);

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

      // モーダル表示中も背後のカレンダーセルは残るため、先頭の日記のタイトルは2箇所に表示される
      fireEvent.press(screen.getAllByText('1件目の日記')[0]);
      expect(await screen.findByText('2件目の日記')).toBeTruthy();
      expect(screen.getAllByText('1件目の日記').length).toBeGreaterThanOrEqual(1);

      // 時刻の昇順(先に書かれたものが先)に並んでいる
      const texts = flattenTexts(screen.toJSON());
      expect(texts.indexOf('1件目の日記')).toBeLessThan(texts.indexOf('2件目の日記'));
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
      await screen.findByText('過去の日記');

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
      await screen.findByText('過去の日記');

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

      // セルのタイトルは変わらず一番早い時刻の「過去の日記」のまま
      expect(screen.getByText('過去の日記')).toBeTruthy();
      expect(screen.queryByText('今日の日記')).toBeNull();

      fireEvent.press(screen.getAllByText('過去の日記')[0]);
      expect(await screen.findByText('今日の日記')).toBeTruthy();
      expect(screen.getAllByText('過去の日記').length).toBeGreaterThanOrEqual(1);
    });

    it('shows the empty state when stored data is corrupted (invalid JSON)', async () => {
      jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not valid json');

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 壊れたデータは読み捨てられ、空の状態から始まるためカレンダーに操作可能なセルは無い
      expect(queryCalendarDayButtons()).toHaveLength(0);
    });

    it('shows the empty state when stored data has the encrypted-payload marker but fails to decrypt (corrupted ciphertext)', async () => {
      jest
        .spyOn(AsyncStorage, 'getItem')
        .mockResolvedValueOnce(`${ENCRYPTED_PREFIX}not-a-real-ciphertext`);

      render(<HomeScreen />);

      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY));
      // 復号に失敗したデータは読み捨てられ、空の状態から始まるためカレンダーに操作可能なセルは無い
      expect(queryCalendarDayButtons()).toHaveLength(0);
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

      // 同じ日に書かれた3件すべてが、セルをタップした一覧に表示される
      // (セルには最初に書かれた「1件目」のタイトルのみが表示される)
      expect(screen.getByText('1件目')).toBeTruthy();
      fireEvent.press(screen.getByText('1件目'));
      expect(await screen.findByText('2件目')).toBeTruthy();
      expect(screen.getByText('3件目')).toBeTruthy();
    });
  });

  describe('下書きの自動保存(Issue #54)', () => {
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
      // 下書きキーのクリア(removeItem)はhandleSave成功時のみ実行される(Issue #54)。
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

  describe('保存成功時のフィードバック(Issue #55)', () => {
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
    // Issue #39: 初回読み込み中はentriesの初期値が空配列であることに起因して空状態メッセージが
    // 一瞬誤って表示されてしまわないよう、代わりにローディング表示(ActivityIndicator)を出す。
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
    // タブへ再フォーカスするたびにloadEntriesは再実行されるが、その都度ローディング表示が
    // ちらつかないことを確認する。
    it('does not show the loading indicator again on a subsequent focus refetch (regression for Issue #39: isLoading only ever transitions true -> false, never back to true)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '既存の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      // 1回目のフォーカス(初回マウント)。画面はアンマウントせず、そのままstate(isLoading)を
      // 保持し続ける(実機のexpo-router Tabsがタブ画面をアンマウントしないのと同じ状況)
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

      // マウント時には日記本文(STORAGE_KEY)に加えて下書き復元用(diary-draft)のgetItemも
      // 1回呼ばれているため(Issue #54)、再フォーカス後の合計は3回になる
      act(() => {
        (triggerRefocus as () => void)();
      });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledTimes(3));

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

      // react-native-calendarsのヘッダーは`importantForAccessibility="no-hide-descendants"`で
      // 内部テキストをアクセシビリティツリーから隠している(画面上には表示されている)ため、
      // `includeHiddenElements`を指定して検索する。年月ジャンプ用ピッカー(Issue #76)を開ける
      // ボタンであることを示す末尾の"▾"込みの表記になる。
      expect(
        await screen.findByText(`${now.getFullYear()}年${now.getMonth() + 1}月 ▾`, {
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
      // '😀'はサロゲートペア(UTF-16で2コードユニット)の絵文字。単純なUTF-16単位のslice(0, 20)
      // だと絵文字の途中(サロゲートの片割れ)で切れてしまう境界を狙う構成
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
      // ZWJ(Zero Width Joiner)で複数の絵文字コードポイントを結合した家族の絵文字(単一の書記素
      // クラスタ)。コードポイント単位の分割(Array.from())だと境目で分断されてしまう構成
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
      expect(queryCalendarDayButtons()).toHaveLength(0);
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
      expect(queryCalendarDayButtons()).toHaveLength(1);

      const emptyDayCell = screen.getByText(String(dayWithoutEntry));
      fireEvent.press(emptyDayCell);
      expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull();
    });

    // Issue #114: スクリーンリーダー(VoiceOver/TalkBack)利用者にも、日付セルの数字だけでなく
    // 「何年何月何日か」と「その日に日記があるかどうか」が伝わるよう、accessibilityLabel/
    // accessibilityStateを検証する
    it('sets an accessibilityLabel with the full date and "日記あり" on a day cell that has a diary entry, and does not mark it as accessibility-disabled', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('日記あり');

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日、日記あり`;
      const dayCell = screen.getByLabelText(expectedLabel);
      expect(dayCell.props.accessibilityRole).toBe('button');
      expect(dayCell.props.accessibilityState?.disabled).toBe(false);
    });

    it('sets an accessibilityLabel with the full date and "日記なし" on a day cell without a diary entry, and marks it as accessibility-disabled so screen readers announce it as non-interactive', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '日記あり', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('日記あり');

      const expectedLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${dayWithoutEntry}日、日記なし`;
      const dayCell = screen.getByLabelText(expectedLabel);
      expect(dayCell.props.accessibilityState?.disabled).toBe(true);
    });

    // Issue #114(境界値): showSixWeeksにより前後月の「はみ出し」日付セルも描画される。
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

    describe('背景タップでモーダルを閉じる(Issue #84)', () => {
      it('closes the modal when the semi-transparent background overlay is tapped (正常系)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '背景タップ対象の日記', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );

        render(<HomeScreen />);
        await screen.findByText('背景タップ対象の日記');

        fireEvent.press(screen.getByText('背景タップ対象の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        const [entryListModal] = screen.UNSAFE_getAllByType(Modal);
        const overlay = getModalOverlayPressable(entryListModal);

        fireEvent.press(overlay);

        // selectedDateがnullに戻り、モーダルの見出し・閉じるボタンが表示されなくなる
        await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());
        expect(
          screen.queryByText(`${now.getFullYear()}年${now.getMonth() + 1}月${dayWithEntry}日`),
        ).toBeNull();
        // 閉じた後もデータ自体は消えておらず、カレンダーセルには引き続きタイトルが表示される
        expect(screen.getByText('背景タップ対象の日記')).toBeTruthy();
      });

      it('keeps the entry-list modal open (does not let the tap bubble to the overlay) when pressing an interactive element inside it, such as the edit button (境界値/異常系: propagation guard regression)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '編集ボタン確認用の日記', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );

        render(<HomeScreen />);
        await screen.findByText('編集ボタン確認用の日記');

        fireEvent.press(screen.getByText('編集ボタン確認用の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        fireEvent.press(screen.getByText('編集'));

        // 編集モーダルが開く一方、日付一覧モーダル自体は閉じられていない
        // (modalContent側のonStartShouldSetResponderにより、内部のボタン操作が
        // 背景オーバーレイのonPressまで伝播して意図せず閉じてしまうことはない)
        expect(await screen.findByText('日記を編集')).toBeTruthy();
        const [entryListModalStillOpen] = screen.UNSAFE_getAllByType(Modal);
        expect(entryListModalStillOpen.props.visible).toBe(true);
      });

      it('sets onStartShouldSetResponder on the modal content so a touch starting inside it is claimed there and does not propagate to the overlay Pressable behind it (境界値: propagation guard implementation contract)', async () => {
        // fireEvent.pressはネイティブのタッチレスポンダー交渉を完全には再現できないため、
        // 「余白タップで閉じない」という挙動そのものではなく、実装のガード
        // (`onStartShouldSetResponder={() => true}`)が実際に設定されtrueを返すことを直接検証する。
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: 'ガード確認用の日記', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );

        render(<HomeScreen />);
        await screen.findByText('ガード確認用の日記');

        fireEvent.press(screen.getByText('ガード確認用の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        const [entryListModal] = screen.UNSAFE_getAllByType(Modal);
        const [modalContentResponder] = entryListModal.findAll(
          (node: TestNode) => typeof node.props.onStartShouldSetResponder === 'function',
        );

        expect(modalContentResponder).toBeTruthy();
        expect(modalContentResponder.props.onStartShouldSetResponder()).toBe(true);
      });

      it('still closes the modal via onRequestClose (Android hardware back / gesture), unaffected by the overlay becoming a Pressable (regression)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            { id: '1', text: '戻る操作確認用の日記', createdAt: isoAt(now, dayWithEntry) },
          ]),
        );

        render(<HomeScreen />);
        await screen.findByText('戻る操作確認用の日記');

        fireEvent.press(screen.getByText('戻る操作確認用の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        const [entryListModal] = screen.UNSAFE_getAllByType(Modal);
        expect(typeof entryListModal.props.onRequestClose).toBe('function');

        act(() => {
          entryListModal.props.onRequestClose();
        });

        await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());
      });
    });

    it('sets statusBarTranslucent and navigationBarTranslucent on the entry-list modal, the edit modal, and the month picker modal, so they match the edge-to-edge display of the screen behind them (Issue #94)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      // 日付タップ時の一覧モーダル・編集モーダル・年月ピッカーモーダル(Issue #76)の3つが常にツリーに存在する
      // (visibleプロパティで表示/非表示を切り替えているだけで、条件付きレンダリングではないため)
      const modals = screen.UNSAFE_getAllByType(Modal);
      expect(modals).toHaveLength(3);
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

  describe('カレンダーの年月ジャンプ用ピッカー(Issue #76)', () => {
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
      return screen.findByText(`${year}年${month}月 ▾`, { includeHiddenElements: true });
    }

    // モーダルは[日付一覧, 編集, 年月ピッカー]の順でJSXに並んでいる(実装側app/(tabs)/index.tsx参照)
    function getMonthPickerModal() {
      return screen.UNSAFE_getAllByType(Modal)[2];
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

    it('increments/decrements the picker year via the "›"/"‹" year stepper buttons, without jumping the calendar until a month button is pressed (正常系)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      fireEvent.press(screen.getByLabelText('次の年'));
      expect(screen.getByText(`${now.getFullYear() + 1}年`)).toBeTruthy();

      fireEvent.press(screen.getByLabelText('前の年'));
      fireEvent.press(screen.getByLabelText('前の年'));
      expect(screen.getByText(`${now.getFullYear() - 1}年`)).toBeTruthy();

      // 年ステッパーの操作だけではカレンダー本体の表示月はまだジャンプしていない
      expect(await findCalendarHeaderText(now.getFullYear(), now.getMonth() + 1)).toBeTruthy();
    });

    it('jumps the calendar to the selected year/month and closes the modal when a month button is tapped (正常系)', async () => {
      const now = new Date();
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);

      fireEvent.press(screen.getByLabelText('次の年'));
      const targetYear = now.getFullYear() + 1;
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
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('次の年'));

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
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('次の年'));
      fireEvent.press(screen.getByLabelText('次の年'));
      expect(screen.getByText(`${now.getFullYear() + 2}年`)).toBeTruthy();

      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));
      await waitFor(() => expect(screen.queryByText('年月を選択')).toBeNull());

      await openMonthPicker(now);
      expect(screen.getByText(`${now.getFullYear()}年`)).toBeTruthy();
      expect(screen.queryByText(`${now.getFullYear() + 2}年`)).toBeNull();
    });

    it("syncs the header heading and the picker's initial year to the new month when the calendar reports a month change via swipe/arrow navigation, crossing a year boundary forward (境界値: 12月→翌年1月)", async () => {
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

      // ピッカーを開くと、スワイプ後の新しい年が初期選択された状態になる
      fireEvent.press(await findCalendarHeaderText(nextYear, 1));
      expect(await screen.findByText(`${nextYear}年`)).toBeTruthy();
      const januaryButton = screen.getByLabelText(`${nextYear}年1月へ移動`);
      expect(januaryButton.props.accessibilityState?.selected).toBe(true);
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
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      await openMonthPicker(now);
      fireEvent.press(screen.getByLabelText('次の年'));

      for (const monthName of MONTH_NAMES_JA) {
        const button = screen.getByLabelText(`${now.getFullYear() + 1}年${monthName}へ移動`);
        expect(button.props.accessibilityState?.selected).toBe(false);
      }
    });
  });

  describe('カレンダーセルの複数件数バッジ(Issue #72)', () => {
    // 同じ日に2件以上の日記がある場合、カレンダーセルの右上に「+N」の件数バッジを表示する。
    // バッジの本体View(styles.entryCountBadge)は`minWidth: 16, height: 16`という
    // 一意な組み合わせのスタイルを持つため、それを目印にView自体を特定するヘルパーを用意する。
    function findEntryCountBadgeViews() {
      return screen.UNSAFE_getAllByType(View).filter((node) => {
        const flattened = StyleSheet.flatten(node.props.style ?? {});
        return flattened.minWidth === 16 && flattened.height === 16;
      });
    }

    it('does not show a count badge when a day has exactly 1 diary entry (正常系/境界値: 単一件数)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '1件のみの日記', createdAt: isoAt(now, dayWithEntry) }]),
      );

      render(<HomeScreen />);
      await screen.findByText('1件のみの日記');

      expect(screen.queryByText(/^\+\d+$/)).toBeNull();
      expect(findEntryCountBadgeViews()).toHaveLength(0);
    });

    it('shows a "+1" badge when a day has exactly 2 diary entries (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の日記');

      expect(screen.getByText('+1')).toBeTruthy();
      // セル自体には先頭(最も時刻が早い)の日記のタイトルのみが表示され、2件目は表示されない
      expect(screen.queryByText('夜の日記')).toBeNull();
    });

    it('shows a "+2" badge when a day has exactly 3 diary entries (正常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
        { id: '3', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の日記');

      expect(screen.getByText('+2')).toBeTruthy();
    });

    it('shows a "+3" badge when a day has 4 diary entries (正常系: 最小の複数件数境界(2件)より先まで正しくスケールすることの確認)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [0, 1, 2, 3].map((i) => ({
        id: `${i}`,
        text: `${i}件目の日記`,
        createdAt: isoAt(now, dayWithEntry, 6 + i * 4, 0),
      }));
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('0件目の日記');

      expect(screen.getByText('+3')).toBeTruthy();
      expect(findEntryCountBadgeViews()).toHaveLength(1);
    });

    it('shows no badge anywhere when there are no diary entries at all (境界値: 0件)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      expect(screen.queryByText(/^\+\d+$/)).toBeNull();
      expect(findEntryCountBadgeViews()).toHaveLength(0);
    });

    it('does not show a badge on a day with no entries (entriesByDate has no key for it), even while another day in the same month has multiple entries (境界値: entriesByDateにキーが無い日付)', async () => {
      const now = new Date();
      const { dayWithEntry, dayWithoutEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の日記');

      // 複数件の日には1つだけバッジが表示され、日記の無い日(dayWithoutEntry)には表示されない。
      // dayWithEntryとdayWithoutEntryの範囲は重複しないため、バッジが1個のみであることの確認は
      // dayWithoutEntry側にバッジが無いことの確認を兼ねる
      expect(screen.getByText('+1')).toBeTruthy();
      expect(screen.getAllByText(/^\+\d+$/)).toHaveLength(1);
      expect(findEntryCountBadgeViews()).toHaveLength(1);

      // 日記の無い日のセルは押せない(タップしても一覧モーダルが開かない)ことも合わせて確認する
      fireEvent.press(screen.getByText(String(dayWithoutEntry)));
      expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull();
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
      await screen.findByText('朝の日記');

      const badgeText = screen.getByText('+1');
      expect(StyleSheet.flatten(badgeText.props.style).color).toBe(Colors.light.background);

      const [badgeView] = findEntryCountBadgeViews();
      expect(StyleSheet.flatten(badgeView.props.style).backgroundColor).toBe(Colors.light.tint);
    });

    it('keeps the count badge visible after the day-entry modal for that date is opened and closed (regression: badge does not disappear due to modal interaction)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '夜の日記', createdAt: isoAt(now, dayWithEntry, 21, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の日記');
      expect(screen.getByText('+1')).toBeTruthy();

      fireEvent.press(screen.getByText('朝の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));
      await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());

      expect(screen.getByText('+1')).toBeTruthy();
    });

    it('updates the badge from "+1" to "+2" once a third entry is saved for a day that already had 2 entries (正常系: 動的な件数増加への追従)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: '1', text: '朝の日記', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: '2', text: '昼の日記', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(storedEntries));

      render(<HomeScreen />);
      await screen.findByText('朝の日記');
      expect(screen.getByText('+1')).toBeTruthy();

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

      await waitFor(() => expect(screen.getByText('+2')).toBeTruthy());
      expect(screen.queryByText('+1')).toBeNull();
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
    // `react-native-calendars`が内部で使う`xdate`はモジュール読み込み時にネイティブの`Date`を
    // 固定的に保持するため`jest.useFakeTimers`が反映されず、うるう年・年またぎ等の「表示月そのもの」
    // を差し替えるケースは決定的にテストできない。実行時点の月の範囲内で日・時・分を選び、
    // それぞれ1桁の値でゼロパディングされることを検証する(期待値は実装のpadStartを模倣せず
    // 別ロジックのpadTwoで計算し、実装と同じ勘違いを見逃さないようにする)。
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

    describe('編集モーダルのKeyboardAvoidingView (Issue #145)', () => {
      // `Platform.OS` はテスト間で状態を共有するモジュールレベルの値のため、
      // 変更したテストの後は必ず元の値(デフォルトの 'ios')へ戻す。
      const originalPlatformOS = Platform.OS;

      afterEach(() => {
        Platform.OS = originalPlatformOS;
      });

      async function openEditModalFor(text: string) {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([{ id: '1', text, createdAt: isoAt(now, dayWithEntry) }]),
        );

        render(<HomeScreen />);
        await screen.findByText(text);
        fireEvent.press(screen.getByText(text));
        await screen.findByText(CLOSE_BUTTON_TEXT);
        fireEvent.press(screen.getByText('編集'));
        await screen.findByText('日記を編集');
      }

      it('wraps the edit modal content in its own KeyboardAvoidingView so the input/save button are not hidden by the keyboard (正常系)', async () => {
        await openEditModalFor('編集モーダルKAV確認用の日記');

        // 画面全体を覆う既存のKeyboardAvoidingViewと、編集モーダル専用のKeyboardAvoidingViewの
        // 合計2つが存在することを確認する
        const keyboardAvoidingViews = screen.getAllByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
        expect(keyboardAvoidingViews).toHaveLength(2);
      });

      it('uses behavior="height" for the edit modal on Android so the input and save button are not hidden by the keyboard', async () => {
        Platform.OS = 'android';

        await openEditModalFor('編集モーダルAndroid確認用の日記');

        const keyboardAvoidingViews = screen.getAllByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
        expect(keyboardAvoidingViews).toHaveLength(2);
        // 画面全体用・編集モーダル用のどちらも、プラットフォームに応じたbehaviorが渡っている
        for (const view of keyboardAvoidingViews) {
          expect(view.props.accessibilityValue.text).toBe('height');
        }
      });

      it('keeps behavior="padding" for the edit modal on iOS (regression check)', async () => {
        Platform.OS = 'ios';

        await openEditModalFor('編集モーダルiOS確認用の日記');

        const keyboardAvoidingViews = screen.getAllByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
        expect(keyboardAvoidingViews).toHaveLength(2);
        for (const view of keyboardAvoidingViews) {
          expect(view.props.accessibilityValue.text).toBe('padding');
        }
      });

      it('does not wrap the edit modal content in a KeyboardAvoidingView while the modal is closed (異常系/境界値)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            {
              id: '1',
              text: '編集モーダル未オープン確認用の日記',
              createdAt: isoAt(now, dayWithEntry),
            },
          ]),
        );

        render(<HomeScreen />);
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

        // 編集モーダルを開いていない状態では、画面全体用の1つしか存在しない
        // (Modalはvisible={false}の間、中身をレンダリングしないため)
        const keyboardAvoidingViews = screen.getAllByTestId(KEYBOARD_AVOIDING_VIEW_TEST_ID);
        expect(keyboardAvoidingViews).toHaveLength(1);
      });
    });

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

    // Issue #34: 編集モーダル側の入力欄・保存ボタンにもcomposerと同じアクセシビリティ属性が
    // 付いていることを検証する
    it('sets accessibilityLabel="日記本文" on the edit TextInput, and accessibilityRole="button"/accessibilityLabel="保存" with a matching accessibilityState on the edit save button', async () => {
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

      // composer用と編集モーダル用のTextInputが両方マウントされているため、
      // 表示中の値で編集モーダル側を特定する
      const editInputs = screen.getAllByLabelText('日記本文');
      const editInput = editInputs.find((input) => input.props.value === '編集前の日記');
      expect(editInput).toBeTruthy();

      const editSaveButton = getEditSaveButton().parent?.parent?.parent;
      expect(editSaveButton?.props.accessibilityRole).toBe('button');
      expect(editSaveButton?.props.accessibilityLabel).toBe('保存');
      expect(editSaveButton?.props.accessibilityState?.disabled).toBe(false);
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

    describe('背景タップでモーダルを閉じる(Issue #173)', () => {
      it('closes the edit modal (editingEntryId becomes null) and discards the unsaved draft (editDraft is cleared) when the semi-transparent background overlay is tapped (正常系)', async () => {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            {
              id: '1',
              text: '編集モーダル背景タップ対象の日記',
              createdAt: isoAt(now, dayWithEntry),
            },
          ]),
        );
        jest.clearAllMocks();

        render(<HomeScreen />);
        await screen.findByText('編集モーダル背景タップ対象の日記');
        fireEvent.press(screen.getByText('編集モーダル背景タップ対象の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        fireEvent.press(screen.getByText('編集'));
        await screen.findByText('日記を編集');

        // 保存前に本文を書き換えておき、オーバーレイタップ後に破棄(editDraftのクリア)されることを
        // AsyncStorageへの書き込みが起きないこと・元の本文が残ることの両面から確認する
        const editInput = screen.getByDisplayValue('編集モーダル背景タップ対象の日記');
        fireEvent.changeText(editInput, '保存されないはずの編集内容');

        const [, editModal] = screen.UNSAFE_getAllByType(Modal);
        const overlay = getModalOverlayPressable(editModal);

        fireEvent.press(overlay);

        // editingEntryIdがnullに戻り、モーダルの見出しが表示されなくなる
        await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull());
        expect(editModal.props.visible).toBe(false);
        // editDraftの変更内容は保存されず破棄される(handleCancelEditと同じ効果)
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
        // 元の本文はそのまま残っている
        expect(
          screen.getAllByText('編集モーダル背景タップ対象の日記').length,
        ).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText('保存されないはずの編集内容')).toBeNull();
      });

      it('sets onStartShouldSetResponder on the edit modal content so a touch starting inside it is claimed there and does not propagate to the overlay Pressable behind it (境界値: propagation guard implementation contract)', async () => {
        // fireEvent.pressの制約(Issue #84のテストと同様の理由)により、実装が伝播を止める
        // ガード(`onStartShouldSetResponder={() => true}`)が編集モーダルにも設定されtrueを返すことを直接検証する。
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([
            {
              id: '1',
              text: '編集モーダルガード確認用の日記',
              createdAt: isoAt(now, dayWithEntry),
            },
          ]),
        );

        render(<HomeScreen />);
        await screen.findByText('編集モーダルガード確認用の日記');
        fireEvent.press(screen.getByText('編集モーダルガード確認用の日記'));
        await screen.findByText(CLOSE_BUTTON_TEXT);

        fireEvent.press(screen.getByText('編集'));
        await screen.findByText('日記を編集');

        const [, editModal] = screen.UNSAFE_getAllByType(Modal);
        const [modalContentResponder] = editModal.findAll(
          (node: TestNode) => typeof node.props.onStartShouldSetResponder === 'function',
        );

        expect(modalContentResponder).toBeTruthy();
        expect(modalContentResponder.props.onStartShouldSetResponder()).toBe(true);

        // ガードが効いている間も、編集モーダル自体は開いたままである
        expect(editModal.props.visible).toBe(true);
      });
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

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      const [savedKey, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      // 編集保存も対象エントリ専用の個別キーに書き込まれる(レガシーの単一キーではない)
      expect(savedKey).toBe(buildDiaryEntryKey('1'));
      expect((value as string).startsWith(ENCRYPTED_PREFIX)).toBe(true);

      // 保存が成功すると編集モーダルは閉じ、一覧・カレンダーセルの表示が更新される
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull());
      expect(screen.queryByText('編集前の日記')).toBeNull();
      expect(screen.getAllByText('編集後の日記').length).toBeGreaterThanOrEqual(1);

      // 永続化された内容もtextのみ更新され、createdAtは変わらない
      const persisted = (await decryptPersistedEntry(value)) as {
        id: string;
        text: string;
        createdAt: string;
      };
      expect(persisted.id).toBe('1');
      expect(persisted.text).toBe('編集後の日記');
      expect(persisted.createdAt).toBe(createdAt);
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

    it('truncates the edit input exceeding the max length via onChangeText (edit TextInput no longer has a maxLength prop either)', async () => {
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
      // maxLength propは指定していないため、handleChangeEditDraft内のgrapheme単位の切り詰めを直接確認する
      fireEvent.changeText(editInput, 'あ'.repeat(1001));

      expect(editInput.props.value).toBe('あ'.repeat(1000));
      expect(screen.getByText('1000/1000')).toBeTruthy();
    });

    describe('絵文字(サロゲートペア・ZWJ結合絵文字)を含む本文の文字数カウント・切り詰め(編集用TextInput, Issue #139)', () => {
      // ZWJ(Zero Width Joiner)で複数の絵文字コードポイントを結合した家族の絵文字。
      // 見た目上は1文字(1書記素クラスタ)だが、UTF-16コードユニットは11個ある
      // ('👨'+ZWJ+'👩'+ZWJ+'👧'+ZWJ+'👦'で、サロゲートペア4つ(各2ユニット)+ZWJ3つ(各1ユニット))
      const familyEmoji = '👨‍👩‍👧‍👦';

      async function openEditModal(initialText: string) {
        const now = new Date();
        const { dayWithEntry } = pickTestDays(now);
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify([{ id: '1', text: initialText, createdAt: isoAt(now, dayWithEntry) }]),
        );

        render(<HomeScreen />);
        await screen.findByText(initialText);
        fireEvent.press(screen.getByText(initialText));
        await screen.findByText(CLOSE_BUTTON_TEXT);
        fireEvent.press(screen.getByText('編集'));
        await screen.findByText('日記を編集');

        return screen.getByDisplayValue(initialText);
      }

      it('counts a ZWJ-joined family emoji as a single grapheme in the edit character counter, not by UTF-16 code units', async () => {
        const editInput = await openEditModal('編集前の日記');

        fireEvent.changeText(editInput, familyEmoji);

        // familyEmojiはUTF-16コードユニット単位では11だが、grapheme単位では1文字
        expect(screen.getByText('1/1000')).toBeTruthy();
        expect(screen.queryByText('11/1000')).toBeNull();
      });

      it('does not split a ZWJ-joined family emoji in the middle when truncating overlong edit input via onChangeText (boundary: exactly at the limit)', async () => {
        const editInput = await openEditModal('編集前の日記');

        // 999文字の'あ' + 家族の絵文字(1000文字目) + さらに超過する10文字、という構成
        const overLimitText = `${'あ'.repeat(999)}${familyEmoji}${'あ'.repeat(10)}`;
        fireEvent.changeText(editInput, overLimitText);

        const expectedTruncated = `${'あ'.repeat(999)}${familyEmoji}`;
        expect(editInput.props.value).toBe(expectedTruncated);
        expect(screen.getByText('1000/1000')).toBeTruthy();
      });
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

    it('resets isSavingEdit after a save failure, re-enabling the save button so a retry can succeed (異常系→正常系, Issue #137 guard boundary)', async () => {
      // handleSaveEditはtry/finallyでisSavingEditを必ずfalseへ戻すため、保存失敗直後でも
      // ガードで弾かれずに再度保存できるはず(finallyブロックが正しく効いていることの検証)
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();
      // 1回目の書き込みだけ失敗させ、2回目以降はデフォルトの(成功する)モック実装に戻す
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '一度失敗した後に成功する編集');
      fireEvent.press(getEditSaveButton());

      await screen.findByText('更新に失敗しました。もう一度お試しください。');
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 失敗直後に保存ボタンが無効化されたまま(isSavingEditがtrueのまま)になっていないことを、
      // disabledプロパティで直接確認する
      const editSaveButton = getEditSaveButton().parent?.parent?.parent;
      expect(editSaveButton?.props.accessibilityState?.disabled).not.toBe(true);

      // 同じ保存ボタンをもう一度押すと、ガードに阻まれず2回目の書き込みが実行される
      fireEvent.press(getEditSaveButton());

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull());
      expect(screen.getAllByText('一度失敗した後に成功する編集').length).toBeGreaterThanOrEqual(1);
    });

    it('ignores a second press of the edit save button while an update is still in flight, preventing a duplicate write (Issue #137)', async () => {
      // 編集モーダルの保存ボタン連打で同一の更新処理が重複実行されないことを確認する。
      // handleSaveの連打防止テスト(Issue #70)と同様、setItemの解決を意図的に遅延させる
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ id: '1', text: '編集前の日記', createdAt: isoAt(now, dayWithEntry) }]),
      );
      jest.clearAllMocks();

      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<HomeScreen />);
      await screen.findByText('編集前の日記');
      fireEvent.press(screen.getByText('編集前の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);
      fireEvent.press(screen.getByText('編集'));
      await screen.findByText('日記を編集');

      const editInput = screen.getByDisplayValue('編集前の日記');
      fireEvent.changeText(editInput, '連打される編集');
      const editSaveButton = getEditSaveButton();
      fireEvent.press(editSaveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 1回目の更新(AsyncStorage.setItem)がまだpendingの間に、続けて保存ボタンを連打する
      fireEvent.press(editSaveButton);
      fireEvent.press(editSaveButton);

      // pending中の連打はガードされ、AsyncStorage.setItemは追加で呼ばれない
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

      resolveSetItem();
      // resolveSetItem後もgetAllDiaryEntries/setEntries等の非同期処理が続けて走るため、
      // CI環境での遅延に備えてデフォルト(1000ms)より長いタイムアウトを明示する
      // (Issue #33の削除/編集競合テストにおける同様のwaitForと同じ方針)
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull(), {
        timeout: 5000,
      });

      // 永続化された内容にも1件のみ含まれ、重複していない
      const [, value] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const persisted = (await decryptPersistedEntry(value)) as { text: string };
      expect(persisted.text).toBe('連打される編集');
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
      // レガシーキー経由の移行時に発生するremoveItem呼び出しと区別できるよう、個別キー方式で
      // 直接シードしておく(この後の削除操作によるremoveItem呼び出し回数だけを検証したいため)
      await seedDiaryEntries(storedEntries);
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

      // 削除はentry専用の個別キーのremoveItemのみで完結し、setItemは呼ばれない
      await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1));
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(buildDiaryEntryKey('2'));
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      // 削除された方は一覧から消え、残る方はそのまま表示される
      expect(screen.queryByText('削除される日記')).toBeNull();
      expect(screen.getAllByText('残る日記').length).toBeGreaterThanOrEqual(1);

      // 残る方の個別キーはそのまま残っており、削除された方の個別キーは消えている
      expect(await readPersistedEntry('1')).toEqual(storedEntries[0]);
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('2'))).toBeNull();
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

    it('rolls back the deletion (keeps the entry visible) and does not crash when AsyncStorage.removeItem fails during delete (異常系)', async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      await seedDiaryEntries([
        { id: '1', text: '削除失敗する日記', createdAt: isoAt(now, dayWithEntry) },
      ]);
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('remove failed'));

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
      expect(queryCalendarDayButtons()).toHaveLength(1);

      fireEvent.press(screen.getByText('その日最後の日記'));
      await screen.findByText(CLOSE_BUTTON_TEXT);

      fireEvent.press(screen.getByText('削除'));
      await pressAlertButton('削除');

      await waitFor(() =>
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith(buildDiaryEntryKey('1')),
      );
      // 一覧モーダルはまだ開いたままだが、日記自体はもう表示されない(entriesByDateから消えた)
      expect(screen.queryByText('その日最後の日記')).toBeNull();

      // モーダルを閉じると、カレンダー上にもタップ可能なセル(タイトル付き)が無くなっている
      fireEvent.press(screen.getByText(CLOSE_BUTTON_TEXT));
      await waitFor(() => expect(screen.queryByText(CLOSE_BUTTON_TEXT)).toBeNull());
      expect(queryCalendarDayButtons()).toHaveLength(0);
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

    it("persists both a delete of entry A and a concurrent edit of entry B, even though A's persistence write is still pending when B's edit save is requested (regression for Issue #130: the write queue still serializes independent per-entry writes, each of which touches only its own AsyncStorage key)", async () => {
      const now = new Date();
      const { dayWithEntry } = pickTestDays(now);
      const storedEntries = [
        { id: 'a', text: 'Aの日記(削除される)', createdAt: isoAt(now, dayWithEntry, 7, 0) },
        { id: 'b', text: 'Bの日記(編集前)', createdAt: isoAt(now, dayWithEntry, 12, 0) },
      ];
      await seedDiaryEntries(storedEntries);
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      // Aの削除(removeItem)・Bの編集保存(setItem)、それぞれの完了タイミングを個別に制御する。
      // 実際の書き込みは元の実装(spyOn前の関数)経由で行い「完了タイミングだけ遅延させる」
      // (単に解決を遅らせるだけだと実際には書き込まれないまま直列化の検証にならない)
      const originalRemoveItem = AsyncStorage.removeItem;
      const originalSetItem = AsyncStorage.setItem;
      let resolveDeleteWrite: () => void = () => {};
      let resolveEditWrite: () => void = () => {};
      jest.spyOn(AsyncStorage, 'removeItem').mockImplementationOnce(
        (key: string) =>
          new Promise<void>((resolve) => {
            resolveDeleteWrite = () => {
              originalRemoveItem(key).then(resolve);
            };
          }),
      );
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
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
      // 実際の書き込み(enqueueDiaryWrite内のremoveItem)はpendingのまま止まる
      const deleteButtons = screen.getAllByText('削除');
      expect(deleteButtons).toHaveLength(2);
      fireEvent.press(deleteButtons[0]);
      await pressAlertButton('削除');

      await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1), {
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

      // 書き込みキューによって直列化されているため、Aの削除が完了する前に
      // Bの編集保存(setItem呼び出し)が発生することはない
      // (このアサーションは、直列化前の実装では即座に発生してしまい失敗する)
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      // Aの書き込みを完了させると、キューの次のタスク(Bの編集保存)が実行される
      resolveDeleteWrite();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      // Bの書き込みも完了させる
      resolveEditWrite();
      await waitFor(() => expect(screen.queryByText('日記を編集')).toBeNull(), {
        timeout: 5000,
      });

      // 最終的にAsyncStorageへ永続化された内容には、Aの削除とBの編集の両方が反映されている
      // (エントリごとに独立したキーへ書き込むため、互いの操作が古いスナップショットで
      // 上書きし合うことはない)
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('a'))).toBeNull();
      expect(await readPersistedEntry('b')).toEqual({
        id: 'b',
        text: 'Bの日記(編集後)',
        createdAt: storedEntries[1].createdAt,
      });

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
      await seedDiaryEntries(storedEntries);
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      // 同上の理由により、実際の書き込みは元の実装経由で行い完了タイミングのみを遅延させる
      const originalRemoveItem = AsyncStorage.removeItem;
      const originalSetItem = AsyncStorage.setItem;
      let resolveDeleteWrite: () => void = () => {};
      let resolveSaveWrite: () => void = () => {};
      jest.spyOn(AsyncStorage, 'removeItem').mockImplementationOnce(
        (key: string) =>
          new Promise<void>((resolve) => {
            resolveDeleteWrite = () => {
              originalRemoveItem(key).then(resolve);
            };
          }),
      );
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
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

      await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      // 削除の書き込みがまだpendingのうちに、新規エントリの保存を開始する
      const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
      fireEvent.changeText(input, '新しい日記');
      fireEvent.press(screen.getByText('保存'));

      // 書き込みキューにより、削除の書き込みが完了するまで新規保存の書き込み(setItem)は発生しない
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      resolveDeleteWrite();
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });

      resolveSaveWrite();
      expect(await screen.findByText('保存しました', {}, { timeout: 5000 })).toBeTruthy();

      // 削除されたエントリのキーは消え、既存の1件・新規保存した1件はそれぞれ独立して残っている
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('todelete'))).toBeNull();
      expect(await readPersistedEntry('keep')).toEqual(storedEntries[0]);

      const setItemMock = AsyncStorage.setItem as jest.Mock;
      const [, lastValue] = setItemMock.mock.calls[setItemMock.mock.calls.length - 1];
      const persistedNewEntry = (await decryptPersistedEntry(lastValue)) as { text: string };
      expect(persistedNewEntry.text).toBe('新しい日記');
    });
  });

  describe('タブ再フォーカス時にpending中の書き込みキューを待ってから読み直す(Issue #152)', () => {
    it('does not flicker back to stale data when useFocusEffect refires while a save is still pending in the write queue (regression for Issue #152)', async () => {
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
      // 既存の直列化テスト(Issue #130)と同様、実際のAsyncStorageへの書き込み自体は元の実装
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
      expect(await screen.findByText('既存の日記')).toBeTruthy();

      // 新規保存を開始する。楽観的UI更新は同期的に反映されるが、AsyncStorageへの実際の
      // 書き込み(enqueueDiaryWrite内のsetItem)はpendingのまま止まる
      fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '新しい日記');
      fireEvent.press(screen.getByText('保存'));

      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
      // 楽観的UI更新により、書き込みが完了する前から新しい日記が一覧に表示されている
      expect(screen.getByText('新しい日記')).toBeTruthy();

      const getItemMock = AsyncStorage.getItem as jest.Mock;
      const getItemCallsWhilePending = getItemMock.mock.calls.length;

      // 書き込みがまだpending中に、useFocusEffectの再発火(タブへの再フォーカス)を模す
      act(() => {
        (triggerRefocus as () => void)();
      });

      // 修正前は、pending中の書き込みを待たずに即座にAsyncStorageを読み直し、まだ反映されていない
      // 古い内容で一覧を上書きしてしまっていた。修正後はキューの完了を待つため追加のgetItem呼び出しは発生しない
      expect(getItemMock.mock.calls.length).toBe(getItemCallsWhilePending);
      // 読み直しがブロックされている間も、楽観的更新済みの新しい日記の表示が古い状態へ
      // 巻き戻ってちらつくことはない
      expect(screen.getByText('新しい日記')).toBeTruthy();
      expect(screen.getByText('既存の日記')).toBeTruthy();

      // pending中の書き込みを完了させる
      await act(async () => {
        resolveSaveWrite();
      });

      // 書き込み完了後、待たされていた読み直しが実行され、AsyncStorage.getItemが追加で呼ばれる
      await waitFor(() =>
        expect(getItemMock.mock.calls.length).toBeGreaterThan(getItemCallsWhilePending),
      );

      // 最終的に画面には、pending中だった書き込みが反映された最新の状態(既存+新規)が
      // 表示され続けている(一時的にせよ新しい日記が消えることはなかった)
      expect(screen.getByText('新しい日記')).toBeTruthy();
      expect(screen.getByText('既存の日記')).toBeTruthy();

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
      expect(await screen.findByText('既存の日記')).toBeTruthy();

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
      expect(screen.getByText('既存の日記')).toBeTruthy();
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

  describe('日記のキーワード検索(Issue #81)', () => {
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
      await screen.findByText('今日は公園を散歩した');

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
      await screen.findByText('今日は公園を散歩した');

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
      await screen.findByText('今日は公園を散歩した');

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
      await screen.findByText('今日は公園を散歩した');

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
      fireEvent.changeText(searchInput, '該当しないはずのキーワード');
      expect(await screen.findByText('見つかりませんでした')).toBeTruthy();

      fireEvent.changeText(searchInput, '');
      await waitFor(() => expect(screen.queryByText('見つかりませんでした')).toBeNull());
      // 通常のカレンダー表示(セル)に戻っている
      expect(screen.getByText('今日は公園を散歩した')).toBeTruthy();
    });

    it('opens the day-entry modal for the tapped search result, using the existing selectedDate modal', async () => {
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
      await screen.findByText('今日は公園を散歩した');

      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '公園');
      const resultItem = await screen.findByText(/公園/);
      fireEvent.press(resultItem);

      // タップ後、その日付のエントリ一覧モーダルが開き、日付見出し・閉じるボタン・
      // エントリの時刻表示(検索結果一覧には出ない書式)が表示される
      expect(await screen.findByText(CLOSE_BUTTON_TEXT)).toBeTruthy();
      expect(
        screen.getByText(formatEntryDateTimeForTest(isoAt(now, dayWithEntry, 9, 0))),
      ).toBeTruthy();
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
      await screen.findByText('今日は公園を散歩した');

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
      await screen.findByText('今日はAppleパイを食べた');

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
      await screen.findByText('今日は公園を散歩した');

      // 空白のみのキーワードはtrim後に空文字列として扱われ、検索結果一覧(0件メッセージ含む)は表示されない
      fireEvent.changeText(screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER), '   ');

      expect(screen.queryByText('見つかりませんでした')).toBeNull();
      expect(screen.getByText('今日は公園を散歩した')).toBeTruthy();
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

    it('sets maxLength={1000} (BODY_MAX_LENGTH) on the search input, so it cannot exceed the diary body max length itself (boundary, Issue #171)', async () => {
      render(<HomeScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());

      const searchInput = screen.getByPlaceholderText(SEARCH_INPUT_PLACEHOLDER);
      // composer/edit用のTextInputとは異なりgrapheme単位の切り詰めロジックは持たないため、
      // ネイティブのmaxLength propがBODY_MAX_LENGTH(1000)に設定されていることを直接確認する
      expect(searchInput.props.maxLength).toBe(1000);
    });
  });
});
