import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import React from 'react';
import { Alert, StyleSheet, useColorScheme } from 'react-native';

import DayEntriesScreen from '@/app/day-entries/[date]';
import { Colors } from '@/constants/theme';
import { encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import { buildDiaryEntryKey, type DiaryEntry } from '@/utils/diary-storage';
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

// 実機では`expo-router`の`ExpoRoot`が自動的に`SafeAreaProvider`で全体をラップするが、
// 単体レンダリングではそのラップが無く`useSafeAreaInsets`がエラーを投げるため、
// 公式のjestモック(SafeAreaProvider無しでも既定値を返す)に差し替える(tests/app/index.test.tsxと同じ方式)。
jest.mock(
  'react-native-safe-area-context',
  () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react-native-safe-area-context/jest/mock').default,
);

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

// 新規登録モーダル(components/diary-entry-composer-modal.tsx)関連のテストで使う定数。
// 下書きの自動保存キー接頭辞はホーム画面(diary-new-entry-draft-)と衝突しないよう
// 実装側で別の接頭辞にしているため、その値と対応させる
const NEW_ENTRY_HEADER_BUTTON_LABEL = 'この日の日記を新規作成';
const NEW_ENTRY_HEADING = '2026年8月15日の日記を書く';
const NEW_ENTRY_INPUT_PLACEHOLDER = 'その日の出来事や気持ちを書いてみましょう';
const NEW_ENTRY_INPUT_LABEL = '日記本文';
const NEW_ENTRY_SAVE_LABEL = '保存';
const NEW_ENTRY_CLOSE_LABEL = '閉じる';
const NEW_ENTRY_DRAFT_KEY = `diary-day-entries-new-entry-draft-${DATE_KEY}`;
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
      expect(message).toBe('この操作は取り消せません。');
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

    it('saves a new entry anchored to local noon of the displayed date, immediately reflects it in the list, persists it, and closes the modal (正常系)', async () => {
      render(<DayEntriesScreen />);
      await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());
      await openNewEntryComposer();

      fireEvent.changeText(screen.getByLabelText(NEW_ENTRY_INPUT_LABEL), '新規登録した日記');
      fireEvent.press(screen.getByText(NEW_ENTRY_SAVE_LABEL));

      // 永続化(AsyncStorage.setItem)の完了を待たず、楽観的更新により即座に一覧へ反映される
      expect(await screen.findByText('新規登録した日記')).toBeTruthy();
      // createdAtは実行時刻ではなく、この画面が表示している日付のローカル正午になる
      expect(screen.getByText('2026/08/15 12:00')).toBeTruthy();

      // 実機の暗号化処理はテスト環境でも一定の実時間を要するため、既定の待機時間(1000ms)を延長する
      await waitFor(() => expect(screen.queryByText(NEW_ENTRY_HEADING)).toBeNull(), {
        timeout: 5000,
      });

      // 再フォーカスによりAsyncStorageから読み直しても消えないことで、永続化されたことを確認する
      act(() => {
        triggerRefocus();
      });
      expect(await screen.findByText('新規登録した日記')).toBeTruthy();
    });

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
    });

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

          await waitFor(() =>
            expect(AsyncStorage.setItem).toHaveBeenCalledWith(
              NEW_ENTRY_DRAFT_KEY,
              '一日一覧画面での書きかけの下書き',
            ),
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
        await AsyncStorage.setItem(NEW_ENTRY_DRAFT_KEY, '前回の続きから書きかけの下書き');

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
      });

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
