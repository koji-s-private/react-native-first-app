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
  });

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

    await waitFor(() => expect(mockSetOptions).toHaveBeenCalledWith({ title: '2026年8月15日' }));
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
