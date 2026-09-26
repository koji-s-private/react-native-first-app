import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import React from 'react';
import { Alert, Dimensions, StyleSheet, useColorScheme } from 'react-native';

import DayEntriesScreen from '@/app/day-entries/[date]';
import { Colors } from '@/constants/theme';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import {
  DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX,
  loadDraftText,
  saveDraftText,
} from '@/utils/diary-draft-storage';
import {
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';
import {
  buildDiaryEntryKey,
  buildDiaryPartialCorruptionMessage,
  DIARY_LOAD_ERROR_MESSAGE,
  type DiaryEntry,
} from '@/utils/diary-storage';
import { BODY_MAX_LENGTH } from '@/utils/diary-text';

// jest-expoのオートモックだと`setStringAsync`が実際のPromiseを返さず呼び出し引数の検証や
// reject時の異常系テストが行えないため、明示的なモックへ差し替える(tests/app/index.test.tsxと同様)。
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve(true)),
}));

// ネイティブの`AsyncStorage`はJest環境では利用できないため、公式のインメモリモックに差し替える
// (tests/app/index.test.tsxと同じ方式)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// isMountedRefガードが実際にコンポーネントからhookへ配線されているかを、Reactの
// (React 19では撤廃済みの)アンマウント警告に頼らず直接検証するためのモック。
// save呼び出し引数を記録するラッパーで実装本体を包むだけで、実際の保存処理自体は
// 本物のuseSaveDiaryEntryにそのまま委譲するため、他のテストの挙動には影響しない
jest.mock('@/hooks/use-save-diary-entry', () => {
  const actual = jest.requireActual('@/hooks/use-save-diary-entry');
  return {
    ...actual,
    useSaveDiaryEntry: jest.fn(() => {
      const original = actual.useSaveDiaryEntry();
      return { ...original, save: jest.fn(original.save) };
    }),
  };
});

// jest-expoのオートモックは`getRandomBytes`を提供しないため、Node標準の`crypto`モジュールで代替する
// (tests/utils/diary-storage.test.tsと同じ方式。getAllDiaryEntries/deleteDiaryEntryが内部で
// 暗号鍵の生成・取得を経由するために必要)。
jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
    randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  };
});

// expo-secure-storeはjest-expoのオートモックだと状態を永続化しないため、インメモリで
// キーと値を保持する独自モックに差し替える(tests/app/index.test.tsxと同じ方式)。
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
    __reset: () => {
      store = {};
    },
  };
});

// この画面が使うexpo-routerのAPI(useLocalSearchParams/useRouter/useNavigation/useFocusEffect)を
// 単体レンダリングでも動くようモック化する。日付パラメータはテストごとに`__setMockDateParam`で
// 差し替えられるようにする(実際のexpo-routerには存在しないテスト専用のヘルパー)。
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactForMock = require('react');

  let dateParam = '2026-08-15';
  const mockPush = jest.fn();
  const mockSetOptions = jest.fn();

  function useLocalSearchParams() {
    return { date: dateParam };
  }

  function useRouter() {
    return { push: mockPush };
  }

  function useNavigation() {
    return { setOptions: mockSetOptions };
  }

  // tests/app/index.test.tsxと同じ方式:マウント中の全effectを保持し、
  // `__triggerRefocus()`で明示的に再発火できるようにする
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

  return {
    useLocalSearchParams,
    useRouter,
    useNavigation,
    useFocusEffect,
    __triggerRefocus,
    __mockPush: mockPush,
    __mockSetOptions: mockSetOptions,
    __setMockDateParam: (value: string) => {
      dateParam = value;
    },
  };
});

const mockSetStringAsync = Clipboard.setStringAsync as jest.Mock;
const {
  __triggerRefocus: triggerRefocus,
  __mockPush: mockPush,
  __mockSetOptions: mockSetOptions,
  __setMockDateParam: setMockDateParam,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('expo-router') as {
  __triggerRefocus: () => void;
  __mockPush: jest.Mock;
  __mockSetOptions: jest.Mock;
  __setMockDateParam: (value: string) => void;
};

const secureStoreMock = SecureStore as unknown as { __reset: () => void };

const DATE_KEY = '2026-08-15';
const CLIPBOARD_COPY_LABEL = '日記本文をコピー';
const EDIT_BUTTON_LABEL = 'この日記を編集';
const DELETE_BUTTON_LABEL = 'この日記を削除';
const EMPTY_STATE_MESSAGE = 'この日の日記はまだありません';
const LOAD_ERROR_MESSAGE = DIARY_LOAD_ERROR_MESSAGE;

// 新規登録モーダル(components/diary-entry-composer-modal.tsx)関連のテストで使う定数。
// 下書きの自動保存キー接頭辞はホーム画面(diary-new-entry-draft-)と衝突しないよう
// 実装側で別の接頭辞にしているため、その値と対応させる
const NEW_ENTRY_HEADER_BUTTON_LABEL = 'この日の日記を新規作成';
const NEW_ENTRY_HEADING = '2026年8月15日の日記を書く';
const NEW_ENTRY_INPUT_PLACEHOLDER = 'その日の出来事や気持ちを書いてみましょう';
const NEW_ENTRY_INPUT_LABEL = '日記本文';
const NEW_ENTRY_SAVE_LABEL = '保存';
const NEW_ENTRY_CLOSE_LABEL = '閉じる';
const NEW_ENTRY_DRAFT_KEY = `${DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}${DATE_KEY}`;
const HOME_SCREEN_DRAFT_KEY = `diary-new-entry-draft-${DATE_KEY}`;

// テストの事前状態として、指定したエントリ群をエントリ単位の個別キーへ暗号化して直接書き込むヘルパー
// (tests/app/index.test.tsxのseedDiaryEntriesと同じ方式)
async function seedDiaryEntries(entries: DiaryEntry[]): Promise<void> {
  const key = await getOrCreateEncryptionKey();
  for (const entry of entries) {
    await AsyncStorage.setItem(
      buildDiaryEntryKey(entry.id),
      encryptText(JSON.stringify(entry), key),
    );
  }
}

// 'YYYY-MM-DD'形式の日付・時刻から端末ローカル時刻ベースのISO文字列を作る
// (UTC表記のリテラルを直接組み立てるとテスト実行環境のタイムゾーンによって日付がずれる恐れがあるため、
// 必ずDateのローカルコンストラクタ経由で作成する。tests/app/index.test.tsxのisoAtと同じ方針)
function localIso(day: string, hour: number, minute: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hour, minute, 0, 0).toISOString();
}

// ヘッダーの「+」ボタンはnavigation.setOptionsのheaderRightオプションとして渡されるだけで、
// このテスト用のnavigationモックはheaderRightを実際には描画しない。setOptionsへの呼び出し引数から
// headerRightを取り出し、その戻り値(Pressable要素)を直接扱うことで押下操作を再現する
type HeaderNewEntryButtonElement = React.ReactElement<{
  onPress: () => void;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  children: React.ReactElement<{ name: string }>;
}>;

function getHeaderNewEntryButtonElement(): HeaderNewEntryButtonElement {
  const calls = mockSetOptions.mock.calls as [
    { headerRight?: () => HeaderNewEntryButtonElement },
  ][];
  const [options] = calls[calls.length - 1];
  expect(typeof options.headerRight).toBe('function');
  return options.headerRight!();
}

// ヘッダーボタンを押下し、その結果開く新規登録モーダルの下書き復元(AsyncStorage.getItemの完了)まで待つ。
// 復元完了前に入力を始めるとact()外での state 更新警告につながるため、他の多くのテストと同様に
// 復元完了を待ってから後続の操作に進む
async function openNewEntryComposer(): Promise<void> {
  const headerButton = getHeaderNewEntryButtonElement();
  await act(async () => {
    headerButton.props.onPress();
  });
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(NEW_ENTRY_DRAFT_KEY));
}

describe('DayEntriesScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
    setMockDateParam(DATE_KEY);
  });

  // FlatList(VirtualizedList)は内部でセル再計算用のsetTimeoutを予約するため、
  // @testing-library/react-nativeの自動アンマウント前にact()内で確実に発火させ、
  // act()外でのstate更新警告を防ぐ(tests/app/index.test.tsxと同じ対策)。
  afterEach(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    jest.restoreAllMocks();
  });

  it('renders the entries for the given date in chronological order, excluding entries from other dates', async () => {
    await seedDiaryEntries([
      { id: '1', text: '朝の出来事', createdAt: localIso(DATE_KEY, 7, 0) },
      { id: '2', text: '夜の出来事', createdAt: localIso(DATE_KEY, 21, 0) },
      { id: '3', text: '別の日の出来事', createdAt: localIso('2026-08-16', 9, 0) },
    ]);

    render(<DayEntriesScreen />);

    expect(await screen.findByText('朝の出来事')).toBeTruthy();
    expect(screen.getByText('夜の出来事')).toBeTruthy();
    expect(screen.queryByText('別の日の出来事')).toBeNull();

    const texts = screen.toJSON();
    const flattened = JSON.stringify(texts);
    expect(flattened.indexOf('朝の出来事')).toBeLessThan(flattened.indexOf('夜の出来事'));
  }, 15000); // フルスイート実行時の負荷でデフォルト5000msを超えるflaky対策

  it('shows an explicit empty state message when no entries exist for the given date (異常系/境界値: 空の日)', async () => {
    render(<DayEntriesScreen />);

    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
    expect(await screen.findByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText('コピー')).toBeNull();
    expect(screen.queryByText('編集')).toBeNull();
    expect(screen.queryByText('削除')).toBeNull();
  });

  it('does not show the empty state before stored entries finish loading (境界値: 初回読み込み中)', async () => {
    await seedDiaryEntries([
      { id: '1', text: '読み込み後の日記', createdAt: localIso(DATE_KEY, 9, 0) },
    ]);

    render(<DayEntriesScreen />);

    expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    expect(await screen.findByText('読み込み後の日記')).toBeTruthy();
    expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
  });

  it("shows each entry's date/time in a 'YYYY/MM/DD HH:mm' format", async () => {
    await seedDiaryEntries([{ id: '1', text: '日記本文', createdAt: localIso(DATE_KEY, 9, 5) }]);

    render(<DayEntriesScreen />);

    expect(await screen.findByText('2026/08/15 09:05')).toBeTruthy();
  });

  it('sets the navigation title to the formatted date heading via navigation.setOptions', async () => {
    render(<DayEntriesScreen />);

    await waitFor(() =>
      expect(mockSetOptions).toHaveBeenCalledWith(
        expect.objectContaining({ title: '2026年8月15日' }),
      ),
    );
  });

  it('reloads the list when the screen regains focus (e.g. after returning from the edit screen)', async () => {
    await seedDiaryEntries([
      { id: '1', text: '編集前の日記', createdAt: localIso(DATE_KEY, 9, 0) },
    ]);

    render(<DayEntriesScreen />);
    expect(await screen.findByText('編集前の日記')).toBeTruthy();

    // 編集画面での保存を模して、AsyncStorage上のデータを直接書き換える
    await seedDiaryEntries([
      { id: '1', text: '編集後の日記', createdAt: localIso(DATE_KEY, 9, 0) },
    ]);

    act(() => {
      triggerRefocus();
    });

    expect(await screen.findByText('編集後の日記')).toBeTruthy();
    expect(screen.queryByText('編集前の日記')).toBeNull();
  });

  describe('読み込みエラー', () => {
    it('shows a load-error message instead of the empty state message when stored data is corrupted (invalid JSON)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not valid json');

      render(<DayEntriesScreen />);

      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    });

    it('shows the plain empty state message (not the load-error message) when no entries exist and loading succeeds', async () => {
      render(<DayEntriesScreen />);

      expect(await screen.findByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    });

    it('clears the load-error message and shows the entries once a later reload succeeds', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));
      await seedDiaryEntries([
        { id: '1', text: '復旧後に表示される日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();

      act(() => {
        triggerRefocus();
      });

      expect(await screen.findByText('復旧後に表示される日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    });

    it('shows the load-error message in Colors.dark.error when in dark mode', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));
      (useColorScheme as jest.Mock).mockReturnValue('dark');

      try {
        render(<DayEntriesScreen />);

        const message = await screen.findByText(LOAD_ERROR_MESSAGE);
        expect(StyleSheet.flatten(message.props.style).color).toBe(Colors.dark.error);
      } finally {
        (useColorScheme as jest.Mock).mockReturnValue('light');
      }
    });

    it('shows the load-error message in Colors.light.error when in light mode', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));

      render(<DayEntriesScreen />);

      const message = await screen.findByText(LOAD_ERROR_MESSAGE);
      expect(StyleSheet.flatten(message.props.style).color).toBe(Colors.light.error);
    });

    it('does not show the load-error message when only some stored entries are corrupted (partial corruption is skipped, valid entries still shown)', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      await seedDiaryEntries([
        { id: '1', text: '壊れていない日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      await AsyncStorage.setItem(buildDiaryEntryKey('broken'), 'not valid json');

      render(<DayEntriesScreen />);

      expect(await screen.findByText('壊れていない日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    });

    it('replaces the previously shown entries with the load-error message when a later reload fails (前回読み込み済みの内容は残さない)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await seedDiaryEntries([
        { id: '1', text: '一度は表示された日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      expect(await screen.findByText('一度は表示された日記')).toBeTruthy();

      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));
      act(() => {
        triggerRefocus();
      });

      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
      expect(screen.queryByText('一度は表示された日記')).toBeNull();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    });

    it('does not carry the load-error message over to another date when the date param changes and that reload succeeds', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));
      await seedDiaryEntries([
        { id: '1', text: '別の日の日記', createdAt: localIso('2026-08-16', 9, 0) },
      ]);

      const { rerender } = render(<DayEntriesScreen />);
      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();

      setMockDateParam('2026-08-16');
      rerender(<DayEntriesScreen />);

      expect(await screen.findByText('別の日の日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    });

    it('shows the plain empty state (not the load-error message) when the date param changes to a date without entries and that reload succeeds', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));

      const { rerender } = render(<DayEntriesScreen />);
      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();

      setMockDateParam('2026-08-20');
      rerender(<DayEntriesScreen />);

      expect(await screen.findByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    });

    it('shows the load-error message (not the empty state) when the reload after a failed deletion also fails', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await seedDiaryEntries([
        { id: '1', text: '削除も再読み込みも失敗する日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText('削除も再読み込みも失敗する日記');

      jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('remove failed'));
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const confirmButton = buttons.find((b: { text: string }) => b.text === '削除');
      await act(async () => {
        await confirmButton.onPress();
      });

      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    });

    it('still allows creating a new entry from the header "+" button while the load-error message is shown, and replaces the message with the saved entry', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));

      render(<DayEntriesScreen />);
      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();

      await openNewEntryComposer();
      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), 'エラー中に書いた日記');
      fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

      expect(await screen.findByText('エラー中に書いた日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
      await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
        timeout: 5000,
      });

      // 実ストレージへ永続化されており、再フォーカスで読み直しても消えず、エラー表示も戻らない
      act(() => {
        triggerRefocus();
      });
      expect(await screen.findByText('エラー中に書いた日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    }, 15000); // 暗号化を伴う保存のwaitFor(5000ms)にマージンを持たせる

    // opacityを継承するemptyStateTextのままだとエラー表示のコントラストが下がってしまうため、
    // 専用スタイル(emptyStateErrorText)を使い分けていることを確認する
    it('renders the load-error message without the dimmed opacity applied to the plain empty-state message, to preserve contrast (視認性)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));

      render(<DayEntriesScreen />);
      const errorMessage = await screen.findByText(LOAD_ERROR_MESSAGE);
      expect(StyleSheet.flatten(errorMessage.props.style).opacity).toBeUndefined();

      act(() => {
        triggerRefocus();
      });
      const emptyMessage = await screen.findByText(EMPTY_STATE_MESSAGE);
      expect(StyleSheet.flatten(emptyMessage.props.style).opacity).toBe(0.7);
    });

    it('reloads entries when the "再試行" button on the load-error message is pressed directly (not just via refocus)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('storage failure'));
      await seedDiaryEntries([
        { id: '1', text: '再試行ボタンで表示される日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      expect(await screen.findByText(LOAD_ERROR_MESSAGE)).toBeTruthy();

      fireEvent.press(screen.getByRole('button', { name: '再試行' }));

      expect(await screen.findByText('再試行ボタンで表示される日記')).toBeTruthy();
      expect(screen.queryByText(LOAD_ERROR_MESSAGE)).toBeNull();
    });

    it('shows a data-integrity toast with the corrupted entry count when only some stored entries for the date are corrupted (境界値: 一部破損)', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      await seedDiaryEntries([
        { id: '1', text: '壊れていない日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      await AsyncStorage.setItem(buildDiaryEntryKey('broken'), 'not valid json');

      render(<DayEntriesScreen />);

      expect(await screen.findByText('壊れていない日記')).toBeTruthy();
      expect(screen.getByTestId('data-integrity-toast')).toBeTruthy();
      expect(screen.getByText(buildDiaryPartialCorruptionMessage(1))).toBeTruthy();
    });
  });

  describe('非同期読み込みの競合防止(loadRequestIdRef)', () => {
    // 日付変更・連続フォーカス等でloadEntriesが多重に走った場合、後から開始したリクエストより
    // 先に発火した(=古い)リクエストが後から完了しても、その結果でstateを上書きしてはならない
    it('does not let a slower, earlier request overwrite the state already set by a faster, later request (境界値: 世代管理)', async () => {
      await seedDiaryEntries([
        { id: '1', text: '最初から表示されている日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      let resolveSlowFirstLoad: (keys: string[]) => void = () => {};
      jest.spyOn(AsyncStorage, 'getAllKeys').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlowFirstLoad = resolve;
          }),
      );

      render(<DayEntriesScreen />);
      await waitFor(() => expect(AsyncStorage.getAllKeys).toHaveBeenCalledTimes(1));

      // 1回目の読み込みが完了する前に、2回目(より新しい)の読み込みを発火させる。
      // 2回目は通常のgetAllKeysの実装のまま即座に完了する
      await seedDiaryEntries([
        { id: '2', text: '再フォーカスで追加された日記', createdAt: localIso(DATE_KEY, 20, 0) },
      ]);
      act(() => {
        triggerRefocus();
      });
      expect(await screen.findByText('再フォーカスで追加された日記')).toBeTruthy();

      // 1回目の読み込みが、2回目より後に(空の結果で)完了しても、2回目の結果を上書きしない
      await act(async () => {
        resolveSlowFirstLoad([]);
      });

      expect(screen.getByText('最初から表示されている日記')).toBeTruthy();
      expect(screen.getByText('再フォーカスで追加された日記')).toBeTruthy();
      expect(screen.queryByText(EMPTY_STATE_MESSAGE)).toBeNull();
    });
  });

  describe('コピー', () => {
    it('copies the entry text to the clipboard and shows a success toast (正常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'コピー対象の日記本文', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      mockSetStringAsync.mockResolvedValueOnce(true);

      render(<DayEntriesScreen />);
      await screen.findByText('コピー対象の日記本文');

      fireEvent.press(screen.getByText('コピー'));

      await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('コピー対象の日記本文'));
      expect(await screen.findByText('コピーしました')).toBeTruthy();
      expect(screen.getByTestId('copy-toast')).toBeTruthy();
    });

    it('shows an error alert and does not show the success toast when Clipboard.setStringAsync fails (異常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'コピー失敗確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      mockSetStringAsync.mockRejectedValueOnce(new Error('clipboard write failed'));

      render(<DayEntriesScreen />);
      await screen.findByText('コピー失敗確認用の日記');

      await act(async () => {
        fireEvent.press(screen.getByText('コピー'));
      });

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith(
          'コピーに失敗しました',
          'もう一度お試しください。',
        ),
      );
      expect(screen.queryByText('コピーしました')).toBeNull();
    });

    it('sets accessibilityRole="button" and accessibilityLabel="日記本文をコピー" on the copy button (アクセシビリティ)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'アクセシビリティ確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      await screen.findByText('アクセシビリティ確認用の日記');

      const copyButton = screen.getByRole('button', { name: CLIPBOARD_COPY_LABEL });
      expect(copyButton.props.accessibilityLabel).toBe(CLIPBOARD_COPY_LABEL);
    });
  });

  describe('編集画面への遷移', () => {
    it('navigates to /edit-entry/<id> when the edit button is pressed', async () => {
      await seedDiaryEntries([
        { id: 'entry-1', text: '編集対象の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      await screen.findByText('編集対象の日記');

      fireEvent.press(screen.getByText('編集'));

      expect(mockPush).toHaveBeenCalledWith('/edit-entry/entry-1');
    });

    it('sets accessibilityRole="button" and accessibilityLabel="この日記を編集" on the edit button (アクセシビリティ)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'アクセシビリティ確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      await screen.findByText('アクセシビリティ確認用の日記');

      const editButton = screen.getByRole('button', { name: EDIT_BUTTON_LABEL });
      expect(editButton.props.accessibilityLabel).toBe(EDIT_BUTTON_LABEL);
    });
  });

  describe('削除', () => {
    it('shows a confirmation dialog (Alert.alert) with cancel/delete options when the delete button is pressed, without deleting yet (正常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: '削除確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText('削除確認用の日記');

      fireEvent.press(screen.getByText('削除'));

      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      expect(title).toBe('日記を削除しますか?');
      expect(message).toBe('削除後、5秒間は元に戻せます。');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toMatchObject({ text: 'キャンセル', style: 'cancel' });
      expect(buttons[1]).toMatchObject({ text: '削除', style: 'destructive' });
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).not.toBeNull();
    });

    it('deletes only the targeted entry and persists the change to AsyncStorage when "削除" is confirmed (正常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: '残る日記', createdAt: localIso(DATE_KEY, 7, 0) },
        { id: '2', text: '削除される日記', createdAt: localIso(DATE_KEY, 12, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText('削除される日記');

      const deleteButtons = screen.getAllByText('削除');
      expect(deleteButtons).toHaveLength(2);
      fireEvent.press(deleteButtons[1]);

      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const confirmButton = buttons.find((b: { text: string }) => b.text === '削除');
      await act(async () => {
        confirmButton.onPress();
      });

      await waitFor(() => expect(screen.queryByText('削除される日記')).toBeNull());
      expect(screen.getByText('残る日記')).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('2'))).toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).not.toBeNull();
      expect(screen.getByTestId('delete-undo-toast')).toBeTruthy();
      expect(screen.getByRole('button', { name: '元に戻す' })).toBeTruthy();
    });

    it('restores the deleted entry in the list and AsyncStorage when undo is pressed', async () => {
      const deletedEntry = {
        id: '1',
        text: '元に戻す日記',
        createdAt: localIso(DATE_KEY, 9, 0),
      };
      await seedDiaryEntries([deletedEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText(deletedEntry.text);

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      await act(async () => {
        await buttons.find((button: { text: string }) => button.text === '削除').onPress();
      });
      fireEvent.press(await screen.findByRole('button', { name: '元に戻す' }));

      expect(await screen.findByText(deletedEntry.text)).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(deletedEntry.id))).not.toBeNull();
      expect(screen.queryByTestId('delete-undo-toast')).toBeNull();
    });

    it('collects consecutive deletions into one undo action and restores every entry in chronological order', async () => {
      const earlierEntry = {
        id: '1',
        text: '1件目の削除対象',
        createdAt: localIso(DATE_KEY, 8, 0),
      };
      const laterEntry = {
        id: '2',
        text: '2件目の削除対象',
        createdAt: localIso(DATE_KEY, 18, 0),
      };
      await seedDiaryEntries([earlierEntry, laterEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText(laterEntry.text);

      fireEvent.press(screen.getAllByText('削除')[0]);
      let latestButtons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2];
      await act(async () => {
        await latestButtons.find((button: { text: string }) => button.text === '削除').onPress();
      });

      fireEvent.press(screen.getByText('削除'));
      latestButtons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2];
      await act(async () => {
        await latestButtons.find((button: { text: string }) => button.text === '削除').onPress();
      });

      expect(await screen.findByText('2件の日記を削除しました')).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: '元に戻す' }));

      expect(await screen.findByText(earlierEntry.text)).toBeTruthy();
      expect(await screen.findByText(laterEntry.text)).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(earlierEntry.id))).not.toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(laterEntry.id))).not.toBeNull();
    });

    it('expires the pending undo when the route changes to another date', async () => {
      const deletedEntry = {
        id: '1',
        text: '別の日へ移動前に削除する日記',
        createdAt: localIso(DATE_KEY, 9, 0),
      };
      const nextDateEntry = {
        id: '2',
        text: '移動先の日記',
        createdAt: localIso('2026-08-16', 9, 0),
      };
      await seedDiaryEntries([deletedEntry, nextDateEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      const { rerender } = render(<DayEntriesScreen />);
      await screen.findByText(deletedEntry.text);

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      await act(async () => {
        await buttons.find((button: { text: string }) => button.text === '削除').onPress();
      });
      expect(screen.getByTestId('delete-undo-toast')).toBeTruthy();

      setMockDateParam('2026-08-16');
      rerender(<DayEntriesScreen />);

      expect(await screen.findByText(nextDateEntry.text)).toBeTruthy();
      expect(screen.queryByTestId('delete-undo-toast')).toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(deletedEntry.id))).toBeNull();
    });

    it('keeps a failed restore available for retry and restores it on the next attempt', async () => {
      const deletedEntry = {
        id: '1',
        text: '復元を再試行する日記',
        createdAt: localIso(DATE_KEY, 9, 0),
      };
      await seedDiaryEntries([deletedEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText(deletedEntry.text);

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      await act(async () => {
        await buttons.find((button: { text: string }) => button.text === '削除').onPress();
      });

      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('restore failed'));
      fireEvent.press(await screen.findByRole('button', { name: '元に戻す' }));

      expect(await screen.findByText('復元できなかった日記があります')).toBeTruthy();
      expect(screen.queryByText(deletedEntry.text)).toBeNull();
      expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
      expect(Alert.alert).toHaveBeenLastCalledWith(
        '復元に失敗しました',
        '復元できなかった日記があります。もう一度お試しください。',
      );

      fireEvent.press(screen.getByRole('button', { name: '再試行' }));

      expect(await screen.findByText(deletedEntry.text)).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(deletedEntry.id))).not.toBeNull();
      expect(screen.queryByTestId('delete-undo-toast')).toBeNull();
    });

    it('does not start a duplicate restore when undo is pressed repeatedly while persistence is pending', async () => {
      const deletedEntry = {
        id: '1',
        text: '復元連打を確認する日記',
        createdAt: localIso(DATE_KEY, 9, 0),
      };
      await seedDiaryEntries([deletedEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText(deletedEntry.text);

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      await act(async () => {
        await buttons.find((button: { text: string }) => button.text === '削除').onPress();
      });

      let resolveRestore: () => void = () => {};
      const setItemMock = AsyncStorage.setItem as jest.Mock;
      setItemMock.mockClear();
      setItemMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRestore = resolve;
          }),
      );
      const undoButton = await screen.findByRole('button', { name: '元に戻す' });

      fireEvent.press(undoButton);
      fireEvent.press(undoButton);

      await waitFor(() => expect(setItemMock).toHaveBeenCalledTimes(1));

      await act(async () => {
        resolveRestore();
      });
      expect(await screen.findByText(deletedEntry.text)).toBeTruthy();
    });

    it('hides the undo action after the five-second window expires and keeps the entry deleted', async () => {
      jest.useFakeTimers();
      try {
        const deletedEntry = {
          id: '1',
          text: '期限切れで復元できない日記',
          createdAt: localIso(DATE_KEY, 9, 0),
        };
        await seedDiaryEntries([deletedEntry]);
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<DayEntriesScreen />);
        await screen.findByText(deletedEntry.text);

        fireEvent.press(screen.getByText('削除'));
        const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
        await act(async () => {
          await buttons.find((button: { text: string }) => button.text === '削除').onPress();
        });

        expect(screen.getByRole('button', { name: '元に戻す' })).toBeTruthy();
        act(() => {
          jest.advanceTimersByTime(4999);
        });
        expect(screen.getByRole('button', { name: '元に戻す' })).toBeTruthy();

        act(() => {
          jest.advanceTimersByTime(1);
        });
        expect(screen.queryByTestId('delete-undo-toast')).toBeNull();
        expect(await AsyncStorage.getItem(buildDiaryEntryKey(deletedEntry.id))).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps only failed entries available when a batch restore partially fails, then restores them on retry', async () => {
      const failedEntry = {
        id: '1',
        text: '復元に失敗する日記',
        createdAt: localIso(DATE_KEY, 8, 0),
      };
      const restoredEntry = {
        id: '2',
        text: '先に復元される日記',
        createdAt: localIso(DATE_KEY, 18, 0),
      };
      await seedDiaryEntries([failedEntry, restoredEntry]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText(restoredEntry.text);

      fireEvent.press(screen.getAllByText('削除')[0]);
      let latestButtons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2];
      await act(async () => {
        await latestButtons.find((button: { text: string }) => button.text === '削除').onPress();
      });
      fireEvent.press(screen.getByText('削除'));
      latestButtons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2];
      await act(async () => {
        await latestButtons.find((button: { text: string }) => button.text === '削除').onPress();
      });

      const originalSetItem = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
      jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key: string, value: string) => {
        if (key === buildDiaryEntryKey(failedEntry.id)) {
          return Promise.reject(new Error('restore failed'));
        }
        return originalSetItem?.(key, value) ?? Promise.resolve();
      });

      fireEvent.press(await screen.findByRole('button', { name: '元に戻す' }));

      expect(await screen.findByText('復元できなかった日記があります')).toBeTruthy();
      expect(await screen.findByText(restoredEntry.text)).toBeTruthy();
      expect(screen.queryByText(failedEntry.text)).toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(restoredEntry.id))).not.toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(failedEntry.id))).toBeNull();
      expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();

      (AsyncStorage.setItem as jest.Mock).mockImplementation(
        originalSetItem ?? (() => Promise.resolve()),
      );
      fireEvent.press(screen.getByRole('button', { name: '再試行' }));

      expect(await screen.findByText(failedEntry.text)).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey(failedEntry.id))).not.toBeNull();
      expect(screen.queryByTestId('delete-undo-toast')).toBeNull();
    });

    it('shows the empty state message after deleting the only entry for the date (境界値: 最後の1件を削除)', async () => {
      await seedDiaryEntries([{ id: '1', text: '最後の1件', createdAt: localIso(DATE_KEY, 9, 0) }]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText('最後の1件');

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const confirmButton = buttons.find((b: { text: string }) => b.text === '削除');
      await act(async () => {
        confirmButton.onPress();
      });

      await waitFor(() => expect(screen.queryByText('最後の1件')).toBeNull());
      expect(await screen.findByText(EMPTY_STATE_MESSAGE)).toBeTruthy();
      expect(screen.queryByText('削除')).toBeNull();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).toBeNull();
    });

    it('does not delete the entry when "キャンセル" is chosen in the confirmation dialog (正常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'キャンセル対象の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await screen.findByText('キャンセル対象の日記');

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const cancelButton = buttons.find((b: { text: string }) => b.text === 'キャンセル');
      await act(async () => {
        cancelButton.onPress?.();
      });

      expect(screen.getByText('キャンセル対象の日記')).toBeTruthy();
      expect(await AsyncStorage.getItem(buildDiaryEntryKey('1'))).not.toBeNull();
    });

    it('rolls back the deletion (keeps the entry visible) and shows an error alert when AsyncStorage.removeItem fails (異常系)', async () => {
      await seedDiaryEntries([
        { id: '1', text: '削除失敗する日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('remove failed'));

      render(<DayEntriesScreen />);
      await screen.findByText('削除失敗する日記');

      fireEvent.press(screen.getByText('削除'));
      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const confirmButton = buttons.find((b: { text: string }) => b.text === '削除');
      await act(async () => {
        await confirmButton.onPress();
      });

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenLastCalledWith(
          '削除に失敗しました',
          'もう一度お試しください。',
        ),
      );
      expect(screen.getByText('削除失敗する日記')).toBeTruthy();
    });

    it('sets accessibilityRole="button" and accessibilityLabel="この日記を削除" on the delete button (アクセシビリティ)', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'アクセシビリティ確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);

      render(<DayEntriesScreen />);
      await screen.findByText('アクセシビリティ確認用の日記');

      const deleteButton = screen.getByRole('button', { name: DELETE_BUTTON_LABEL });
      expect(deleteButton.props.accessibilityLabel).toBe(DELETE_BUTTON_LABEL);
    });
  });

  describe('新規登録モーダル(ヘッダーの「+」ボタン)', () => {
    it('renders the header "+" button with a plus icon and correct accessibility attributes, and it is initially closed (正常系)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

      const headerButton = getHeaderNewEntryButtonElement();
      expect(headerButton.props.accessibilityRole).toBe('button');
      expect(headerButton.props.accessibilityLabel).toBe(NEW_ENTRY_HEADER_BUTTON_LABEL);
      expect(headerButton.props.children.props.name).toBe('plus');

      expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull();
    });

    it('opens the composer modal with a heading and placeholder for the displayed date when the "+" button is pressed (正常系)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

      await openNewEntryComposer();

      expect(screen.getByText(NEW_ENTRY_HEADING)).toBeTruthy();
      expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.placeholder).toBe(
        NEW_ENTRY_INPUT_PLACEHOLDER,
      );
    });

    it('saves a new entry anchored to the displayed date but with the actual save-moment time as createdAt, immediately reflects it in the list, persists it, and closes the modal (正常系)', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date(2026, 7, 15, 9, 34, 17));

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '新規登録した日記');
        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

        // 永続化(AsyncStorage.setItem)の完了を待たず、楽観的更新により即座に一覧へ反映される
        expect(await screen.findByText('新規登録した日記')).toBeTruthy();
        // createdAtの日付部分はこの画面が表示している日付に固定されるが、時分は正午固定ではなく
        // 実際に保存した瞬間の時刻になる
        expect(screen.getByText('2026/08/15 09:34')).toBeTruthy();

        // 実機の暗号化処理はテスト環境でも一定の実時間を要するため、既定の待機時間(1000ms)を延長する
        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
          timeout: 5000,
        });

        // 再フォーカスによりAsyncStorageから読み直しても消えないことで、永続化されたことを確認する
        act(() => {
          triggerRefocus();
        });
        expect(await screen.findByText('新規登録した日記')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

    it('uses the save-moment time-of-day (not a fixed noon) for createdAt on each save, so consecutive saves at different times produce different displayed times (境界値)', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date(2026, 7, 15, 9, 34, 17));

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '1件目の新規日記');
        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));
        expect(await screen.findByText('2026/08/15 09:34')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
          timeout: 5000,
        });

        jest.setSystemTime(new Date(2026, 7, 15, 21, 12, 0));

        await openNewEntryComposer();
        fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '2件目の新規日記');
        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

        expect(await screen.findByText('2026/08/15 21:12')).toBeTruthy();
        // 1件目の時刻表示は変わらず残っており、登録順に異なる時刻で記録されたことが分かる
        expect(screen.getByText('2026/08/15 09:34')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

    it('keeps createdAt on the displayed date even when saving near the real-clock day boundary (境界値: 0時台・23時台)', async () => {
      jest.useFakeTimers();
      try {
        // 表示している日付(2026-08-15)とは別日の23時台に保存しても、記録される日付は
        // 表示日付のまま(実行時刻の日付には引きずられない)ことを確認する
        jest.setSystemTime(new Date(2026, 7, 20, 23, 50, 0));

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '23時台に登録した日記');
        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

        expect(await screen.findByText('2026/08/15 23:50')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
          timeout: 5000,
        });

        // 続けて0時台に保存しても、記録される日付は変わらず表示日付のまま
        jest.setSystemTime(new Date(2026, 7, 21, 0, 5, 0));

        await openNewEntryComposer();
        fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '0時台に登録した日記');
        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

        expect(await screen.findByText('2026/08/15 00:05')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

    it('disables the save button while the draft is empty or whitespace-only, and does not call AsyncStorage.setItem (異常系/境界値)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      const saveButton = screen.getByRole('button', { name: NEW_ENTRY_SAVE_LABEL });
      expect(saveButton.props.accessibilityState?.disabled).toBe(true);
      expect(StyleSheet.flatten(saveButton.props.style).opacity).toBe(0.5);

      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '   \n   ');
      expect(saveButton.props.accessibilityState?.disabled).toBe(true);

      fireEvent.press(saveButton);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '空でなくなった');
      expect(saveButton.props.accessibilityState?.disabled).toBe(false);
      expect(StyleSheet.flatten(saveButton.props.style).opacity).toBe(1);
    });

    it('truncates input exceeding BODY_MAX_LENGTH via onChangeText (grapheme-based), shows the counter, and allows saving exactly at the limit (境界値)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      const input = screen.getByLabelText(NEW_ENTRY_INPUT_LABEL);
      fireEvent.changeText(input, 'あ'.repeat(BODY_MAX_LENGTH + 1));
      expect(input.props.value).toBe('あ'.repeat(BODY_MAX_LENGTH));
      expect(screen.getByText(`${BODY_MAX_LENGTH}/${BODY_MAX_LENGTH}`)).toBeTruthy();

      // 上限ちょうどの文字数は切り詰められず、そのまま保存できる
      fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));
      await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
        timeout: 5000,
      });
      expect(await screen.findByText('あ'.repeat(BODY_MAX_LENGTH))).toBeTruthy();
    }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

    it('caps the input height so long drafts scroll inside the input, and keeps the counter and an enabled save button available at the length limit (境界値)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      const input = screen.getByLabelText(NEW_ENTRY_INPUT_LABEL);
      const inputStyle = StyleSheet.flatten(input.props.style);
      expect(inputStyle.maxHeight).toBeGreaterThan(inputStyle.minHeight);
      expect(Number.isFinite(inputStyle.maxHeight)).toBe(true);
      expect(screen.queryByText('入力欄内をスクロールできます')).toBeNull();

      fireEvent(input, 'contentSizeChange', {
        nativeEvent: { contentSize: { width: 300, height: inputStyle.maxHeight + 1 } },
      });
      expect(screen.getByText('入力欄内をスクロールできます')).toBeTruthy();

      fireEvent.changeText(input, 'あ\n'.repeat(BODY_MAX_LENGTH));
      expect(screen.getByText(`${BODY_MAX_LENGTH}/${BODY_MAX_LENGTH}`)).toBeTruthy();
      const saveButton = screen.getByRole('button', { name: NEW_ENTRY_SAVE_LABEL });
      expect(saveButton.props.accessibilityState?.disabled).toBe(false);
      expect(StyleSheet.flatten(saveButton.props.style).opacity).toBe(1);
    });

    describe('本文入力欄の高さ上限(画面サイズへの追従)', () => {
      const originalWindow = Dimensions.get('window');

      afterEach(async () => {
        await act(async () => {
          Dimensions.set({ window: originalWindow, screen: originalWindow });
        });
      });

      async function setWindowHeight(height: number): Promise<void> {
        await act(async () => {
          const window = { ...originalWindow, height };
          Dimensions.set({ window, screen: window });
        });
      }

      it('sets the input maxHeight to 35% of the window height and the modal maxHeight to 70%', async () => {
        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        const inputStyle = StyleSheet.flatten(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.style,
        );
        expect(inputStyle.maxHeight).toBe(
          Math.max(inputStyle.minHeight, originalWindow.height * 0.35),
        );
        const modalStyle = StyleSheet.flatten(
          screen.getByTestId('diary-entry-composer-content').props.style,
        );
        expect(modalStyle.maxHeight).toBe(originalWindow.height * 0.7);
      });

      it('follows the window height when it changes while the composer is open (画面回転・分割画面)', async () => {
        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        await setWindowHeight(400);
        expect(
          StyleSheet.flatten(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.style).maxHeight,
        ).toBe(140);

        await setWindowHeight(1000);
        expect(
          StyleSheet.flatten(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.style).maxHeight,
        ).toBe(350);
      });

      it('keeps a finite, positive maxHeight and the minHeight on extremely short windows (境界値)', async () => {
        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        await setWindowHeight(200);
        const inputStyle = StyleSheet.flatten(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.style,
        );
        expect(inputStyle.maxHeight).toBe(80);
        expect(inputStyle.minHeight).toBe(80);

        await setWindowHeight(0);
        const zeroStyle = StyleSheet.flatten(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.style,
        );
        expect(zeroStyle.maxHeight).toBe(80);
        expect(Number.isNaN(zeroStyle.maxHeight)).toBe(false);
        expect(screen.getByRole('button', { name: NEW_ENTRY_SAVE_LABEL })).toBeTruthy();
      });
    });

    it('prevents duplicate saves when the save button is pressed repeatedly while a save is still in flight (連打防止)', async () => {
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '連打される日記');
      const saveButton = screen.getByText(NEW_ENTRY_SAVE_LABEL);
      fireEvent.press(saveButton);
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 1回目の保存がpendingの間に連打しても、追加でAsyncStorage.setItemは呼ばれない
      fireEvent.press(saveButton);
      fireEvent.press(saveButton);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText('連打される日記')).toHaveLength(1);

      await act(async () => {
        resolveSetItem();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
        timeout: 5000,
      });
      expect(screen.getAllByText('連打される日記')).toHaveLength(1);
    }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

    it('shows an error message and rolls back the optimistic list update when persisting fails, keeping the modal open with the input preserved (異常系)', async () => {
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '保存失敗する日記');
      fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

      expect(await screen.findByText('保存に失敗しました。もう一度お試しください。')).toBeTruthy();
      // ロールバックにより一覧には反映されない
      expect(screen.queryByText('保存失敗する日記')).toBeNull();

      // モーダルは開いたままで、入力内容も保持されている
      expect(screen.getByText(NEW_ENTRY_HEADING)).toBeTruthy();
      expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.value).toBe('保存失敗する日記');
    });

    it('passes an isMountedRef to useSaveDiaryEntry.save whose current becomes false after unmounting while a save is still in flight (isMountedRefガードの配線確認)', async () => {
      let rejectSetItem: (error: Error) => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSetItem = reject;
          }),
      );

      const { unmount } = render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      fireEvent.changeText(
        screen.getByLabelText(NEW_ENTRY_INPUT_LABEL),
        'アンマウント時点で保存中の内容',
      );
      fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 保存処理を実際に呼び出したレンダー結果(save.mockが呼ばれているもの)からisMountedRefを取り出す
      const useSaveDiaryEntryMock = useSaveDiaryEntry as jest.Mock;
      const invokedResult = useSaveDiaryEntryMock.mock.results.find(
        (result) => (result.value.save as jest.Mock).mock.calls.length > 0,
      );
      const isMountedRef = invokedResult?.value.save.mock.calls[0][0].isMountedRef;
      expect(isMountedRef).toBeDefined();
      expect(isMountedRef.current).toBe(true);

      unmount();

      expect(isMountedRef.current).toBe(false);

      // アンマウント後に保存が失敗してもエラーは投げられない(save内部の状態更新がガードされ、
      // 呼び出し自体は最後まで解決する)
      await act(async () => {
        rejectSetItem(new Error('write failed'));
      });
    });

    it('closes the modal immediately without a confirmation dialog via the close button when the draft is still empty (正常系)', async () => {
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      fireEvent.press(screen.getByText(NEW_ENTRY_CLOSE_LABEL));

      await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull());
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('sets accessibilityRole="button" and accessibilityLabel="閉じる" on the composer modal\'s close button (アクセシビリティ)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      const closeButton = screen.getByRole('button', { name: NEW_ENTRY_CLOSE_LABEL });
      expect(closeButton.props.accessibilityRole).toBe('button');
      expect(closeButton.props.accessibilityLabel).toBe(NEW_ENTRY_CLOSE_LABEL);
    });

    describe('未保存入力の破棄確認ダイアログ', () => {
      async function pressAlertButton(label: string): Promise<void> {
        const alertMock = Alert.alert as jest.Mock;
        const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
        const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
        const button = buttons.find((b) => b.text === label);
        expect(button).toBeDefined();
        await act(async () => {
          button?.onPress?.();
        });
      }

      it('shows the discard confirmation dialog when the close button is pressed after typing, and keeps the modal open until "破棄" is chosen (正常系)', async () => {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL),
          '破棄されるはずの下書き',
        );
        fireEvent.press(screen.getByText(NEW_ENTRY_CLOSE_LABEL));

        expect(Alert.alert).toHaveBeenCalledWith(
          '変更を破棄しますか?',
          '入力中の内容は保存されません。',
          expect.any(Array),
        );
        expect(screen.getByText(NEW_ENTRY_HEADING)).toBeTruthy();
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          buildDiaryEntryKey(expect.any(String)),
          expect.any(String),
        );

        await pressAlertButton('破棄');

        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull());
      });

      it('keeps the modal open and preserves the unsaved draft when "キャンセル" is chosen in the discard confirmation dialog (異常系)', async () => {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL),
          'キャンセルで残るはずの下書き',
        );
        fireEvent.press(screen.getByText(NEW_ENTRY_CLOSE_LABEL));
        await pressAlertButton('キャンセル');

        expect(screen.getByText(NEW_ENTRY_HEADING)).toBeTruthy();
        expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.value).toBe(
          'キャンセルで残るはずの下書き',
        );
      });

      it('also shows the discard confirmation dialog when the background overlay is tapped with unsaved input (正常系)', async () => {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        fireEvent.changeText(
          screen.getByLabelText(NEW_ENTRY_INPUT_LABEL),
          'オーバーレイタップで破棄確認',
        );
        fireEvent.press(screen.getByTestId('modal-overlay-pressable'));

        expect(Alert.alert).toHaveBeenCalledTimes(1);
        expect(screen.getByText(NEW_ENTRY_HEADING)).toBeTruthy();
      });
    });

    describe('下書きの自動保存', () => {
      it("auto-saves the draft under this screen's own key prefix, distinct from the home screen's, once the debounce interval elapses (正常系)", async () => {
        jest.useFakeTimers();
        try {
          render(<DayEntriesScreen />);
          await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
          await openNewEntryComposer();

          fireEvent.changeText(
            screen.getByLabelText(NEW_ENTRY_INPUT_LABEL),
            '一日一覧画面での書きかけの下書き',
          );

          // デバウンス時間が経過するまでは、下書きキーへの書き込みはまだ発生しない
          expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
            NEW_ENTRY_DRAFT_KEY,
            expect.any(String),
          );

          await act(async () => {
            jest.advanceTimersByTime(1000);
          });

          await waitFor(async () => {
            const storedDraft = await AsyncStorage.getItem(NEW_ENTRY_DRAFT_KEY);
            expect(storedDraft && isEncryptedPayload(storedDraft)).toBe(true);
          });
          await expect(loadDraftText(NEW_ENTRY_DRAFT_KEY)).resolves.toBe(
            '一日一覧画面での書きかけの下書き',
          );
          // ホーム画面の新規作成モーダルと同じ日付でも、別キーのため混ざらない
          expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
            HOME_SCREEN_DRAFT_KEY,
            expect.any(String),
          );
        } finally {
          jest.useRealTimers();
        }
      });

      it('restores a previously auto-saved draft into the input when the composer modal is reopened for the same date (正常系)', async () => {
        await saveDraftText(NEW_ENTRY_DRAFT_KEY, '前回の続きから書きかけの下書き');

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();

        await waitFor(() =>
          expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.value).toBe(
            '前回の続きから書きかけの下書き',
          ),
        );
      });

      it('clears the auto-saved draft key once the entry is successfully saved (正常系)', async () => {
        await AsyncStorage.setItem(NEW_ENTRY_DRAFT_KEY, '保存後に消えるはずの下書き');

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();
        await waitFor(() =>
          expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.value).toBe(
            '保存後に消えるはずの下書き',
          ),
        );

        fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
          timeout: 5000,
        });
        expect(await AsyncStorage.getItem(NEW_ENTRY_DRAFT_KEY)).toBeNull();
      }, 15000); // waitForのtimeout(5000ms)にマージンを持たせ、CI環境の負荷によるflaky失敗を防ぐ

      it('clears the auto-saved draft key once "破棄" is chosen to close the modal without saving (正常系)', async () => {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        await AsyncStorage.setItem(NEW_ENTRY_DRAFT_KEY, '破棄されるはずの下書き');

        render(<DayEntriesScreen />);
        await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
        await openNewEntryComposer();
        await waitFor(() =>
          expect(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL).props.value).toBe(
            '破棄されるはずの下書き',
          ),
        );

        fireEvent.press(screen.getByText(NEW_ENTRY_CLOSE_LABEL));
        const alertMock = Alert.alert as jest.Mock;
        const [, , buttons] = alertMock.mock.calls[alertMock.mock.calls.length - 1];
        const discardButton = buttons.find((b: { text: string }) => b.text === '破棄');
        await act(async () => {
          discardButton.onPress();
        });

        await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull());
        expect(await AsyncStorage.getItem(NEW_ENTRY_DRAFT_KEY)).toBeNull();
      });
    });
  });

  describe('テーマに応じたエラー色', () => {
    const mockedUseColorScheme = useColorScheme as jest.Mock;

    afterEach(() => {
      mockedUseColorScheme.mockReturnValue('light');
    });

    it('shows the delete link in Colors.dark.error when in dark mode', async () => {
      await seedDiaryEntries([
        { id: '1', text: 'ダークモード確認用の日記', createdAt: localIso(DATE_KEY, 9, 0) },
      ]);
      mockedUseColorScheme.mockReturnValue('dark');

      render(<DayEntriesScreen />);
      await screen.findByText('ダークモード確認用の日記');

      const deleteLink = screen.getByText('削除');
      expect(StyleSheet.flatten(deleteLink.props.style).color).toBe(Colors.dark.error);
    });
  });
});
