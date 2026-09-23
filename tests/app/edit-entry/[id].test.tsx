import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import React from 'react';
import { Alert, StyleSheet } from 'react-native';

import EditEntryScreen from '@/app/edit-entry/[id]';
import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import { buildDiaryEntryKey, type DiaryEntry } from '@/utils/diary-storage';
import { BODY_MAX_LENGTH } from '@/utils/diary-text';

// ネイティブの`AsyncStorage`はJest環境では利用できないため、公式のインメモリモックに差し替える
// (tests/app/index.test.tsxと同じ方式)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

let mockSafeAreaBottom = 0;
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const safeAreaMock = require('react-native-safe-area-context/jest/mock').default;
  return {
    ...safeAreaMock,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: mockSafeAreaBottom, left: 0 }),
  };
});

// jest-expoのオートモックは`getRandomBytes`を提供しないため、Node標準の`crypto`モジュールで代替する
// (tests/utils/diary-storage.test.tsと同じ方式)。
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

// この画面が使うexpo-routerのAPI(useLocalSearchParams/useRouter/useNavigation)を単体レンダリングでも
// 動くようモック化する。`navigation.addListener('beforeRemove', ...)`は実際の画面遷移(ヘッダーの
// 戻る操作・Android物理戻るボタン・スワイプ戻るジェスチャー)のいずれでも発火する単一のイベントのため、
// テスト側は登録されたコールバックを直接呼び出すことでこれらすべての操作を模擬できる。
jest.mock('expo-router', () => {
  let idParam = 'entry-1';
  // router.back()が実際にnavigationのbeforeRemoveガードを経由する挙動を再現するため、
  // 現在登録されているリスナーをaddListener側で追跡し、back()呼び出し時にそれを発火させる
  let currentBeforeRemoveListener:
    ((event: { preventDefault: () => void; data: { action: unknown } }) => void) | null = null;
  const BACK_ACTION = { type: 'GO_BACK' };

  const mockDispatch = jest.fn();
  const mockBack = jest.fn(() => {
    if (!currentBeforeRemoveListener) {
      return;
    }
    let prevented = false;
    currentBeforeRemoveListener({
      preventDefault: () => {
        prevented = true;
      },
      data: { action: BACK_ACTION },
    });
    // 実際のReact Navigationと同様、ブロックされなければそのままアクションを反映する
    if (!prevented) {
      mockDispatch(BACK_ACTION);
    }
  });
  const mockAddListener = jest.fn((event: string, callback: unknown) => {
    if (event === 'beforeRemove') {
      currentBeforeRemoveListener = callback as typeof currentBeforeRemoveListener;
    }
    return () => {
      if (event === 'beforeRemove' && currentBeforeRemoveListener === callback) {
        currentBeforeRemoveListener = null;
      }
    };
  });

  function useLocalSearchParams() {
    return { id: idParam };
  }

  function useRouter() {
    return { back: mockBack };
  }

  function useNavigation() {
    return { addListener: mockAddListener, dispatch: mockDispatch };
  }

  return {
    useLocalSearchParams,
    useRouter,
    useNavigation,
    __mockBack: mockBack,
    __mockAddListener: mockAddListener,
    __mockDispatch: mockDispatch,
    __setMockIdParam: (value: string) => {
      idParam = value;
    },
  };
});

const {
  __mockBack: mockBack,
  __mockAddListener: mockAddListener,
  __mockDispatch: mockDispatch,
  __setMockIdParam: setMockIdParam,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('expo-router') as {
  __mockBack: jest.Mock;
  __mockAddListener: jest.Mock;
  __mockDispatch: jest.Mock;
  __setMockIdParam: (value: string) => void;
};

const secureStoreMock = SecureStore as unknown as { __reset: () => void };

const ENTRY_ID = 'entry-1';

// 実装(`app/edit-entry/[id].tsx`)の保存成功トースト表示から画面遷移までの待機時間(1200ms)と対応させる
const NAVIGATE_BACK_DELAY_AFTER_SAVE_MS = 1200;

// `components/save-toast.tsx`の自動非表示までの時間(2500ms)と対応させる
const SAVE_TOAST_AUTO_HIDE_DELAY_MS = 2500;

// 保存成功トーストの表示を確認したうえで、画面遷移までの待機時間をfake timersで進める
// (実時間で待たずに済ませる。呼び出し側で事前にjest.useFakeTimers()を有効にしておくこと)
async function advancePastNavigateBackDelay(): Promise<void> {
  await screen.findByTestId('save-toast');
  await act(async () => {
    jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
  });
}

async function seedDiaryEntry(entry: DiaryEntry): Promise<void> {
  const key = await getOrCreateEncryptionKey();
  await AsyncStorage.setItem(buildDiaryEntryKey(entry.id), encryptText(JSON.stringify(entry), key));
}

async function readPersistedEntry(id: string): Promise<DiaryEntry | null> {
  const stored = await AsyncStorage.getItem(buildDiaryEntryKey(id));
  if (!stored) {
    return null;
  }
  const key = await getOrCreateEncryptionKey();
  return JSON.parse(decryptText(stored, key));
}

// 下書きの暗号化文字列を復号して元の本文に戻すヘルパー(JSONではなくプレーンテキストな点がreadPersistedEntryと異なる)
async function decryptPersistedDraft(encryptedValue: string): Promise<string> {
  const key = await getOrCreateEncryptionKey();
  return decryptText(encryptedValue, key);
}

// beforeRemoveイベントに登録された最新のコールバックを取り出すヘルパー
function getBeforeRemoveListener(): (event: {
  preventDefault: () => void;
  data: { action: unknown };
}) => void {
  const call = mockAddListener.mock.calls.findLast(([eventName]) => eventName === 'beforeRemove');
  if (!call) {
    throw new Error('beforeRemove listener was not registered');
  }
  return call[1];
}

const SAMPLE_ACTION = { type: 'GO_BACK' };

function buildBeforeRemoveEvent(preventDefault: jest.Mock) {
  return { preventDefault, data: { action: SAMPLE_ACTION } };
}

describe('EditEntryScreen', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
    setMockIdParam(ENTRY_ID);
    mockSafeAreaBottom = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the existing text prefilled once the entry is loaded (正常系)', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(<EditEntryScreen />);

    expect(await screen.findByDisplayValue('編集前の日記')).toBeTruthy();
  });

  it('adds the bottom safe-area inset to the editor padding', async () => {
    mockSafeAreaBottom = 34;
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: 'セーフエリアを確認する日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(<EditEntryScreen />);
    await screen.findByDisplayValue('セーフエリアを確認する日記');

    const containerStyle = StyleSheet.flatten(
      screen.getByTestId('edit-entry-container').props.style,
    );
    expect(containerStyle.paddingBottom).toBe(50);
  });

  it('loads the entry when StrictMode re-runs the mount effect', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: 'StrictModeで読み込む日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(
      <React.StrictMode>
        <EditEntryScreen />
      </React.StrictMode>,
    );

    expect(await screen.findByDisplayValue('StrictModeで読み込む日記')).toBeTruthy();
  });

  it('shows a message instead of the editor when no entry matches the given id (異常系/境界値)', async () => {
    render(<EditEntryScreen />);

    expect(await screen.findByText('編集対象の日記が見つかりませんでした。')).toBeTruthy();
  });

  // 補足: React 18以降はアンマウント済みコンポーネントへのstate更新を検知するコンソール警告自体が
  // 撤廃されたため、以下2件のテストはisMountedRefガードの有無に関わらずpassし得る
  // (画面を離れる際の未保存変更の破棄確認(beforeRemove)にある同種テストの補足コメントと同じ理由)
  it('does not crash or update state after unmounting while the initial entry lookup is still in flight', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '読み込み中にアンマウントされる日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const entryKey = buildDiaryEntryKey(ENTRY_ID);
    // async-storage-mockは元々jest.fn()のため、jest.spyOnの`mockRestore()`では元の実装に
    // 戻らない(既知の挙動)。上書き前の実装を保存しておき、finallyで明示的に復元する
    const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
    let resolveEntryLookup: (value: string | null) => void = () => {};
    const deferredLookup = new Promise<string | null>((resolve) => {
      resolveEntryLookup = resolve;
    });
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
      if (key === entryKey) {
        return deferredLookup;
      }
      return originalGetItemImpl ? originalGetItemImpl(key) : Promise.resolve(null);
    });

    try {
      const { unmount } = render(<EditEntryScreen />);
      unmount();

      await act(async () => {
        resolveEntryLookup(originalGetItemImpl ? await originalGetItemImpl(entryKey) : null);
      });

      const stateUpdateWarning = consoleErrorSpy.mock.calls.find(([message]) =>
        String(message).includes('a component'),
      );
      expect(stateUpdateWarning).toBeUndefined();
    } finally {
      consoleErrorSpy.mockRestore();
      if (originalGetItemImpl) {
        getItemSpy.mockImplementation(originalGetItemImpl);
      }
    }
  });

  it('does not crash or update state after unmounting while restoring the auto-saved draft is still in flight', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '下書き復元中にアンマウントされる日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const draftKey = `diary-edit-draft-${ENTRY_ID}`;
    const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
    let resolveDraftLookup: (value: string | null) => void = () => {};
    const deferredDraftLookup = new Promise<string | null>((resolve) => {
      resolveDraftLookup = resolve;
    });
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
      if (key === draftKey) {
        return deferredDraftLookup;
      }
      return originalGetItemImpl ? originalGetItemImpl(key) : Promise.resolve(null);
    });

    try {
      const { unmount } = render(<EditEntryScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(draftKey));
      unmount();

      await act(async () => {
        resolveDraftLookup(originalGetItemImpl ? await originalGetItemImpl(draftKey) : null);
      });

      const stateUpdateWarning = consoleErrorSpy.mock.calls.find(([message]) =>
        String(message).includes('a component'),
      );
      expect(stateUpdateWarning).toBeUndefined();
    } finally {
      consoleErrorSpy.mockRestore();
      if (originalGetItemImpl) {
        getItemSpy.mockImplementation(originalGetItemImpl);
      }
    }
  });

  it('does not let a stale lookup for the previous id overwrite the newly loaded entry once id changes while the screen stays mounted (race condition regression)', async () => {
    const oldEntryId = 'entry-1';
    const newEntryId = 'entry-2';
    await seedDiaryEntry({
      id: oldEntryId,
      text: '古いIDの日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await seedDiaryEntry({
      id: newEntryId,
      text: '新しいIDの日記',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const oldEntryKey = buildDiaryEntryKey(oldEntryId);
    const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
    let resolveOldEntryLookup: (value: string | null) => void = () => {};
    const deferredOldEntryLookup = new Promise<string | null>((resolve) => {
      resolveOldEntryLookup = resolve;
    });
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
      if (key === oldEntryKey) {
        return deferredOldEntryLookup;
      }
      return originalGetItemImpl ? originalGetItemImpl(key) : Promise.resolve(null);
    });

    try {
      const { rerender } = render(<EditEntryScreen />);
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(oldEntryKey));

      // 画面がアンマウントされずにidだけが変わるケース(idが都度pushされる通常経路とは異なる備え)を模擬する
      setMockIdParam(newEntryId);
      rerender(<EditEntryScreen />);

      expect(await screen.findByDisplayValue('新しいIDの日記')).toBeTruthy();

      // 旧idに対する読み込みが新id表示後に解決しても、新idの表示内容を上書きしない
      await act(async () => {
        resolveOldEntryLookup(originalGetItemImpl ? await originalGetItemImpl(oldEntryKey) : null);
      });

      expect(screen.getByDisplayValue('新しいIDの日記')).toBeTruthy();
      expect(screen.queryByDisplayValue('古いIDの日記')).toBeNull();
    } finally {
      if (originalGetItemImpl) {
        getItemSpy.mockImplementation(originalGetItemImpl);
      }
    }
  });

  it('sets accessibilityLabel="日記本文" on the TextInput, and accessibilityRole="button"/accessibilityLabel="保存" on the save button', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(<EditEntryScreen />);
    await screen.findByDisplayValue('編集前の日記');

    expect(screen.getByLabelText('日記本文').props.value).toBe('編集前の日記');
    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(saveButton.props.accessibilityState?.disabled).toBe(false);
  });

  it('renders the save button at reduced opacity and disables it once the text is cleared to whitespace only', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(StyleSheet.flatten(saveButton.props.style).opacity).toBe(1);

    fireEvent.changeText(input, '   ');

    expect(StyleSheet.flatten(saveButton.props.style).opacity).toBe(0.5);
    expect(saveButton.props.accessibilityState?.disabled).toBe(true);
  });

  it('truncates input exceeding the max length via onChangeText (grapheme-based, no maxLength prop)', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '文字数上限確認用',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('文字数上限確認用');

    fireEvent.changeText(input, 'あ'.repeat(1001));

    expect(input.props.value).toBe('あ'.repeat(1000));
    expect(screen.getByText('1000/1000')).toBeTruthy();
  });

  it('does not split a ZWJ-joined family emoji in the middle when truncating overlong input via onChangeText (boundary: exactly at the limit)', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const familyEmoji = '👨‍👩‍👧‍👦';

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');

    const overLimitText = `${'あ'.repeat(999)}${familyEmoji}${'あ'.repeat(10)}`;
    fireEvent.changeText(input, overLimitText);

    expect(input.props.value).toBe(`${'あ'.repeat(999)}${familyEmoji}`);
    expect(screen.getByText('1000/1000')).toBeTruthy();
  });

  it('updates the entry text (keeping createdAt unchanged), persists it encrypted, and navigates back when saved (正常系)', async () => {
    jest.useFakeTimers();
    const createdAt = '2026-01-01T09:00:00.000Z';
    await seedDiaryEntry({ id: ENTRY_ID, text: '編集前の日記', createdAt });

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    fireEvent.changeText(input, '編集後の日記');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    await advancePastNavigateBackDelay();
    expect(mockBack).toHaveBeenCalledTimes(1);

    const persisted = await readPersistedEntry(ENTRY_ID);
    expect(persisted).toEqual({ id: ENTRY_ID, text: '編集後の日記', createdAt });
  });

  describe('保存成功トーストの表示と画面遷移までの待機', () => {
    async function renderAndPressSave(originalText: string, editedText: string) {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: originalText,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      (AsyncStorage.setItem as jest.Mock).mockClear();
      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue(originalText);
      fireEvent.changeText(input, editedText);
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
    }

    it('shows the save success toast and navigates back only after the delay has elapsed (正常系)', async () => {
      jest.useFakeTimers();
      try {
        await renderAndPressSave('トースト確認前の日記', 'トースト確認後の日記');

        expect(await screen.findByTestId('save-toast')).toBeTruthy();
        expect(screen.getByText('保存しました')).toBeTruthy();
        expect(mockBack).not.toHaveBeenCalled();

        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS - 1);
        });
        expect(mockBack).not.toHaveBeenCalled();

        await act(async () => {
          jest.advanceTimersByTime(1);
        });
        expect(mockBack).toHaveBeenCalledTimes(1);
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the save button disabled and ignores extra presses while waiting to navigate back (連打)', async () => {
      jest.useFakeTimers();
      try {
        await renderAndPressSave('連打確認前の日記', '連打確認後の日記');
        await screen.findByTestId('save-toast');
        const saveButton = screen.getByRole('button', { name: '保存' });
        expect(saveButton.props.accessibilityState).toEqual({ disabled: true });
        expect(screen.getByText('保存中...')).toBeTruthy();

        fireEvent.press(saveButton);
        fireEvent.press(saveButton);
        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });

        expect(mockBack).toHaveBeenCalledTimes(1);
        const persistedWrites = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
          ([key]) => key === buildDiaryEntryKey(ENTRY_ID),
        );
        expect(persistedWrites).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('blocks a leave attempt made while waiting to navigate back and navigates only once after the delay (戻る操作)', async () => {
      jest.useFakeTimers();
      try {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        await renderAndPressSave('待機中に戻る日記', '待機中に戻る編集後の日記');
        await screen.findByTestId('save-toast');

        const preventDefault = jest.fn();
        getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(mockDispatch).not.toHaveBeenCalled();

        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });

        expect(mockDispatch).toHaveBeenCalledTimes(1);
        expect(Alert.alert).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not navigate back and releases its timers when unmounted while waiting to navigate back (アンマウント)', async () => {
      jest.useFakeTimers();
      try {
        await renderAndPressSave(
          '待機中にアンマウントされる日記',
          '待機中にアンマウントされる編集後の日記',
        );
        await screen.findByTestId('save-toast');

        const timerCountBeforeUnmount = jest.getTimerCount();
        screen.unmount();
        // 画面遷移の待機タイマーとトーストの自動非表示タイマーの2本がアンマウントで解放される
        expect(jest.getTimerCount()).toBe(timerCountBeforeUnmount - 2);

        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });
        expect(mockBack).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the toast visible for the whole waiting period and hides it by itself afterwards (境界値/トースト表示時間)', async () => {
      jest.useFakeTimers();
      try {
        await renderAndPressSave('トースト表示時間の日記', 'トースト表示時間の編集後の日記');
        await screen.findByTestId('save-toast');

        // 画面遷移の直前(待機終了の1ms前)までトーストが表示され続けていること
        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS - 1);
        });
        expect(screen.getByTestId('save-toast')).toBeTruthy();
        expect(mockBack).not.toHaveBeenCalled();

        await act(async () => {
          jest.advanceTimersByTime(1);
        });
        expect(mockBack).toHaveBeenCalledTimes(1);

        // トースト自体の自動非表示は待機時間より後に来る
        await act(async () => {
          jest.advanceTimersByTime(
            SAVE_TOAST_AUTO_HIDE_DELAY_MS - NAVIGATE_BACK_DELAY_AFTER_SAVE_MS,
          );
        });
        expect(screen.queryByTestId('save-toast')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not dispatch a blocked leave action and leaves no timers behind when unmounted after a leave attempt during the wait (アンマウント/戻る操作)', async () => {
      jest.useFakeTimers();
      try {
        await renderAndPressSave(
          '戻る操作後にアンマウントされる日記',
          '戻る操作後にアンマウントされる編集後の日記',
        );
        await screen.findByTestId('save-toast');

        const preventDefault = jest.fn();
        getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));
        expect(preventDefault).toHaveBeenCalledTimes(1);

        screen.unmount();
        const timerCountAfterUnmount = jest.getTimerCount();
        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });

        expect(mockBack).not.toHaveBeenCalled();
        expect(mockDispatch).not.toHaveBeenCalled();
        // アンマウント後に新たなタイマーが増えていない(フレームワーク由来の常駐タイマーは対象外)
        expect(jest.getTimerCount()).toBeLessThanOrEqual(timerCountAfterUnmount);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not navigate back when unmounted while the draft key removal is still in flight, before the waiting timer is created (アンマウント/待機開始前)', async () => {
      jest.useFakeTimers();
      try {
        let resolveRemoveItem: () => void = () => {};
        await seedDiaryEntry({
          id: ENTRY_ID,
          text: '下書き削除中にアンマウントされる日記',
          createdAt: '2026-01-01T00:00:00.000Z',
        });
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('下書き削除中にアンマウントされる日記');
        fireEvent.changeText(input, '下書き削除中にアンマウントされる編集後の日記');
        (AsyncStorage.removeItem as jest.Mock).mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveRemoveItem = resolve;
            }),
        );
        fireEvent.press(screen.getByRole('button', { name: '保存' }));
        await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalled());

        screen.unmount();
        const timerCountAfterUnmount = jest.getTimerCount();
        // `act`自体がfake timersに残す内部タイマー数を測り、待機タイマーが増えていないことを厳密に比較する
        await act(async () => {});
        const timersLeftPerAct = jest.getTimerCount() - timerCountAfterUnmount;
        const timerCountBeforeResolve = jest.getTimerCount();
        await act(async () => {
          resolveRemoveItem();
        });
        // 待機開始前にアンマウント済みなので、下書き削除の完了直後も待機タイマーは作られない
        expect(jest.getTimerCount()).toBe(timerCountBeforeResolve + timersLeftPerAct);
        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });

        expect(mockBack).not.toHaveBeenCalled();
        expect(mockDispatch).not.toHaveBeenCalled();
        // 待機タイマーが自然消滅し、アンマウント後に残り続けるタイマーが無いこと
        expect(jest.getTimerCount()).toBeLessThanOrEqual(timerCountAfterUnmount);
      } finally {
        jest.useRealTimers();
      }
    });

    it('makes the text input read-only while waiting to navigate back so it cannot be edited after saving (待機中の再編集)', async () => {
      jest.useFakeTimers();
      try {
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        await renderAndPressSave('待機中に再編集される日記', '待機中に再編集される編集後の日記');
        await screen.findByTestId('save-toast');

        const input = screen.getByDisplayValue('待機中に再編集される編集後の日記');
        expect(input.props.editable).toBe(false);
        fireEvent.changeText(input, '待機中にさらに書き足した内容');
        expect(screen.queryByDisplayValue('待機中にさらに書き足した内容')).toBeNull();

        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });

        expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
        expect(Alert.alert).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('does not save when the edited text is emptied out (defense in depth)', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '空にされる日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    jest.clearAllMocks();

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('空にされる日記');
    fireEvent.changeText(input, '   ');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    expect(mockBack).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('rolls back to showing an error message and does not navigate back when saving fails (異常系)', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    fireEvent.changeText(input, '失敗するはずの編集');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('更新に失敗しました。もう一度お試しください。')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('失敗するはずの編集')).toBeTruthy();
    expect(screen.queryByTestId('save-toast')).toBeNull();
    expect(screen.getByDisplayValue('失敗するはずの編集').props.editable).toBe(true);
  });

  it('ignores a second press of the save button while an update is still in flight, preventing a duplicate write', async () => {
    jest.useFakeTimers();
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    jest.clearAllMocks();
    let resolveSetItem: () => void = () => {};
    jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSetItem = resolve;
        }),
    );

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    fireEvent.changeText(input, '連打される編集');
    const saveButton = screen.getByRole('button', { name: '保存' });
    fireEvent.press(saveButton);
    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

    fireEvent.press(saveButton);
    fireEvent.press(saveButton);

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSetItem();
    });
    await advancePastNavigateBackDelay();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner and "保存中..." label while a save is in flight, and reverts to "保存" if it fails', async () => {
    await seedDiaryEntry({
      id: ENTRY_ID,
      text: '編集前の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    let rejectSetItem: (error: Error) => void = () => {};
    jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSetItem = reject;
        }),
    );

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    fireEvent.changeText(input, '保存中表示を確認する編集');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

    expect(screen.getByText('保存中...')).toBeTruthy();
    expect(screen.queryByText('保存')).toBeNull();

    await act(async () => {
      rejectSetItem(new Error('write failed'));
    });

    await screen.findByText('更新に失敗しました。もう一度お試しください。');
    expect(screen.getByText('保存')).toBeTruthy();
    expect(screen.queryByText('保存中...')).toBeNull();
  });

  describe('インポート等で紛れ込んだ本文上限超過データを開いた場合の自動切り詰め', () => {
    it('truncates a persisted entry whose text exceeds BODY_MAX_LENGTH to exactly the limit before displaying it, and notifies the user via Alert with the number of truncated characters (異常系/境界値)', async () => {
      const overLimitText = 'あ'.repeat(BODY_MAX_LENGTH + 10);
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: overLimitText,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const truncatedText = 'あ'.repeat(BODY_MAX_LENGTH);

      const input = await screen.findByDisplayValue(truncatedText);
      expect(input.props.value).toBe(truncatedText);
      expect(screen.getByText(`${BODY_MAX_LENGTH}/${BODY_MAX_LENGTH}`)).toBeTruthy();
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, message] = (Alert.alert as jest.Mock).mock.calls[0];
      expect(title).toBe('本文の一部が切り詰められました');
      expect(message).toContain('10文字');
    });

    it('does not show the truncation Alert when the persisted text is within BODY_MAX_LENGTH (正常系)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '上限以内の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      await screen.findByDisplayValue('上限以内の日記');

      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('allows saving without error immediately (no edits) once the overlong text has been truncated on load', async () => {
      jest.useFakeTimers();
      const overLimitText = 'あ'.repeat(BODY_MAX_LENGTH + 10);
      const createdAt = '2026-01-01T00:00:00.000Z';
      await seedDiaryEntry({ id: ENTRY_ID, text: overLimitText, createdAt });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const truncatedText = 'あ'.repeat(BODY_MAX_LENGTH);
      await screen.findByDisplayValue(truncatedText);

      fireEvent.press(screen.getByRole('button', { name: '保存' }));

      await advancePastNavigateBackDelay();
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('更新に失敗しました。もう一度お試しください。')).toBeNull();

      const persisted = await readPersistedEntry(ENTRY_ID);
      expect(persisted).toEqual({ id: ENTRY_ID, text: truncatedText, createdAt });
    });
  });

  describe('画面を離れる際の未保存変更の破棄確認(beforeRemove)', () => {
    it('does not prevent leaving and does not show a confirmation dialog when the draft has not been changed (正常系)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '未変更の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      await screen.findByDisplayValue('未変更の日記');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('prevents leaving and shows the discard confirmation dialog when the draft has been changed (正常系)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '変更前の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('変更前の日記');
      fireEvent.changeText(input, '変更後の内容');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      expect(title).toBe('変更を破棄しますか?');
      expect(message).toBe('編集中の内容は保存されません。');
      expect(buttons[0]).toMatchObject({ text: 'キャンセル', style: 'cancel' });
      expect(buttons[1]).toMatchObject({ text: '破棄', style: 'destructive' });
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('treats the draft as "unchanged" (does not prevent leaving) when it differs from the original only by leading/trailing whitespace that disappears after trimming (境界値)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '前後空白トリム境界値対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('前後空白トリム境界値対象');
      fireEvent.changeText(input, '  前後空白トリム境界値対象  ');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('dispatches the pending navigation action when "破棄" is chosen, discarding the unsaved draft', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '破棄選択対象の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.clearAllMocks();
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('破棄選択対象の日記');
      fireEvent.changeText(input, '破棄されるはずの内容');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const discardButton = (buttons as { text: string; onPress?: () => void }[]).find(
        (b) => b.text === '破棄',
      );
      await act(async () => {
        discardButton?.onPress?.();
      });

      expect(mockDispatch).toHaveBeenCalledWith(SAMPLE_ACTION);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('does not dispatch and keeps the unsaved draft when "キャンセル" is chosen', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: 'キャンセル選択対象の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('キャンセル選択対象の日記');
      fireEvent.changeText(input, 'キャンセルで保持される内容');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const cancelButton = (buttons as { text: string; onPress?: () => void }[]).find(
        (b) => b.text === 'キャンセル',
      );
      await act(async () => {
        cancelButton?.onPress?.();
      });

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('キャンセルで保持される内容')).toBeTruthy();
    });

    it('blocks leaving without showing the discard confirmation dialog while a save is still in flight, then navigates back via handleSaveEdit once the save completes (異常系/競合)', async () => {
      jest.useFakeTimers();
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存中に離脱される日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('保存中に離脱される日記');
      fireEvent.changeText(input, '保存中に離脱される変更後の内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 保存処理が完了するまでの間は、破棄確認ダイアログを出さずに一律離脱をブロックする
      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();

      await act(async () => {
        resolveSetItem();
      });

      // 保存完了後はhandleSaveEdit内のrouter.back()によってのみ画面を離れる
      await advancePastNavigateBackDelay();
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('keeps blocking every subsequent leave attempt consistently while the save is still in flight (境界値/複数回試行)', async () => {
      jest.useFakeTimers();
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存中に複数回離脱される日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('保存中に複数回離脱される日記');
      fireEvent.changeText(input, '保存中に複数回離脱される変更後の内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // ヘッダーの戻る操作・物理戻るボタン・スワイプなど、保存完了までの間に何度離脱を
      // 試みても一貫してブロックされ続けることを確認する(1回目だけ塞いで2回目以降は
      // すり抜けてしまう、といった回帰が無いか)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const preventDefault = jest.fn();
        getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));
        expect(preventDefault).toHaveBeenCalledTimes(1);
      }
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();

      await act(async () => {
        resolveSetItem();
      });

      await advancePastNavigateBackDelay();
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    // 補足: React 18以降はアンマウント済みコンポーネントへのstate更新を検知する
    // コンソール警告自体が撤廃されたため、このテストはガードの有無に関わらずpassし得る
    // (console.errorへの出力が無いことは確認できるが、isMountedRefガードが実際に効いた
    // ことの直接証明にはならない)。ガードの意義はReactの将来的な仕様変更や他レンダラーへの
    // 備えとしての防御的実装であり、コードレビューで妥当性を担保する。
    it('does not update state after unmounting while a save is still in flight (avoids a "state update on an unmounted component" warning)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: 'アンマウントされる日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      let rejectSetItem: (error: Error) => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSetItem = reject;
          }),
      );

      const { unmount } = render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('アンマウントされる日記');
      fireEvent.changeText(input, 'アンマウント時点で保存中の内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      unmount();

      await act(async () => {
        rejectSetItem(new Error('write failed'));
      });

      const stateUpdateWarning = consoleErrorSpy.mock.calls.find(([message]) =>
        String(message).includes('a component'),
      );
      expect(stateUpdateWarning).toBeUndefined();
      consoleErrorSpy.mockRestore();
    });

    it('does not prevent leaving on a subsequent beforeRemove check once the draft has been saved successfully', async () => {
      jest.useFakeTimers();
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存後に戻る対象の日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('保存後に戻る対象の日記');
      fireEvent.changeText(input, '保存される内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await advancePastNavigateBackDelay();
      expect(mockBack).toHaveBeenCalledTimes(1);

      // 保存成功後は「未保存の変更」ではなくなるため、以降のbeforeRemoveチェックでは
      // 確認ダイアログを出さない(保存後にeditOriginalTextRefが更新されていることの確認)
      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('actually leaves the screen after a successful save, even though router.back() is itself initially blocked by the in-flight beforeRemove guard (異常系/自己ガード競合)', async () => {
      jest.useFakeTimers();
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '自身のガードでブロックされないか確認する日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('自身のガードでブロックされないか確認する日記');
      fireEvent.changeText(input, '保存成功後に画面を離れられることを確認する内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));

      // router.back()自体はhandleSaveEdit完了前(isSavingEdit === true)に呼ばれるため、
      // 一度は自身のbeforeRemoveガードでブロックされる。それでも保存完了後にアクションが
      // 再送され、実際に画面遷移(navigation.dispatch)まで完了することを確認する
      await advancePastNavigateBackDelay();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(Alert.alert).not.toHaveBeenCalled();

      const persisted = await readPersistedEntry(ENTRY_ID);
      expect(persisted?.text).toBe('保存成功後に画面を離れられることを確認する内容');
    });

    it('dispatches only the most recently blocked action (not a stale earlier one) when beforeRemove fires more than once during an in-flight save (境界値/複数回発火時の上書き)', async () => {
      jest.useFakeTimers();
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存中に複数回beforeRemoveが発火する日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      let resolveSetItem: () => void = () => {};
      jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSetItem = resolve;
          }),
      );

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('保存中に複数回beforeRemoveが発火する日記');
      fireEvent.changeText(input, '複数回発火後も最新のアクションが送られることを確認する内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 保存中に実際のユーザー操作(スワイプ戻る等)によって発火したbeforeRemoveを模擬する。
      // router.back()が使うアクションとは別物であることを区別できるよう、あえて異なる
      // アクションを渡す
      const staleAction = { type: 'POP', payload: { count: 1 } };
      const preventDefault = jest.fn();
      getBeforeRemoveListener()({ preventDefault, data: { action: staleAction } });
      expect(preventDefault).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSetItem();
      });

      // handleSaveEdit完了後のrouter.back()がGO_BACKアクションで自身のbeforeRemoveガードを
      // 再度ブロックし、保持していたアクションを上書きする。保存完了後に再送されるのは
      // 最新のGO_BACKであり、先に保持されていた古いPOPアクションではないことを確認する
      await advancePastNavigateBackDelay();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
      expect(mockDispatch).not.toHaveBeenCalledWith(staleAction);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it('does not force-navigate away using a blocked leave action once a save fails, keeping the unsaved edit and error message visible (異常系/保存失敗時の離脱アクション再送抑止)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存失敗時に離脱しないことを確認する日記',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write failed'));

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('保存失敗時に離脱しないことを確認する日記');
      fireEvent.changeText(input, '保存失敗するはずの編集内容');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));

      // 保存が失敗する前に、ユーザーが実際に画面を離れようとした操作を模擬する
      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));
      expect(preventDefault).toHaveBeenCalledTimes(1);

      await screen.findByText('更新に失敗しました。もう一度お試しください。');

      // 保存に失敗した場合、保存中にブロックしていた離脱アクションを勝手に再送して画面を
      // 離れさせてはならない(ユーザーが確認する間もなく未保存の編集内容を失ってしまうため)
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('保存失敗するはずの編集内容')).toBeTruthy();
    });
  });

  describe('編集下書きの自動保存', () => {
    // 実装(`app/edit-entry/[id].tsx`)の`diary-edit-draft-`接頭辞・デバウンス間隔(1000ms)と対応させる
    const DRAFT_STORAGE_KEY = `diary-edit-draft-${ENTRY_ID}`;
    const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

    it('does not immediately persist the edit draft key when the user types (debounced)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '下書き自動保存確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('下書き自動保存確認対象');

      fireEvent.changeText(input, '書きかけの編集内容');

      // デバウンス時間が経過するまでは、下書きキーへの書き込みはまだ発生しない
      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String));
    });

    it('auto-saves the edit draft under an entry-id-specific AsyncStorage key once the debounce interval elapses', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '下書き自動保存確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('下書き自動保存確認対象');

        fireEvent.changeText(input, '書きかけの編集内容');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String)),
        );
        const [, persistedDraft] = (AsyncStorage.setItem as jest.Mock).mock.calls.find(
          ([key]) => key === DRAFT_STORAGE_KEY,
        );
        // 保存済みエントリと同じくAES-256-GCMで暗号化され、平文のままでは保存されない
        expect(persistedDraft).not.toBe('書きかけの編集内容');
        await expect(decryptPersistedDraft(persistedDraft)).resolves.toBe('書きかけの編集内容');
      } finally {
        jest.useRealTimers();
      }
    });

    it('restores a previously auto-saved draft (prioritized over the saved original text) into the text input on mount', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存済みの元の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '前回の続きから復元される下書き');

      render(<EditEntryScreen />);

      expect(await screen.findByDisplayValue('前回の続きから復元される下書き')).toBeTruthy();
    });

    it('shows the discard confirmation dialog on beforeRemove after restoring a draft that differs from the original text, even without further edits', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存済みの元の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '前回の続きから復元される下書き');
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      await screen.findByDisplayValue('前回の続きから復元される下書き');

      // 下書きを復元しただけで、そこから更に編集していない状態でも、元の本文とは
      // 異なるため破棄確認が発火する(editOriginalTextRefが下書きではなく元の本文を保持している確認)
      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(Alert.alert).toHaveBeenCalledTimes(1);
    });

    it('does not prioritize the restored draft and does not trigger the discard confirmation when the auto-saved draft equals the saved original text', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '元の本文と同一の下書き',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, '元の本文と同一の下書き');
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      await screen.findByDisplayValue('元の本文と同一の下書き');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('clears the auto-saved edit draft key once the entry is successfully saved', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '下書き削除確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('下書き削除確認対象');

        fireEvent.changeText(input, '保存される編集内容');
        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });
        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String)),
        );

        fireEvent.press(screen.getByRole('button', { name: '保存' }));

        await waitFor(() =>
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the auto-saved edit draft key once "破棄" is chosen to leave without saving', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '破棄時下書き削除確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);
      const input = await screen.findByDisplayValue('破棄時下書き削除確認対象');
      fireEvent.changeText(input, '破棄されるはずの編集内容');

      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
      const discardButton = (buttons as { text: string; onPress?: () => void }[]).find(
        (b) => b.text === '破棄',
      );
      await act(async () => {
        discardButton?.onPress?.();
      });

      await waitFor(() => expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY));
    });

    it('does not resurrect the discarded draft when the pending debounce timer fires after "破棄" is confirmed (race condition regression)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '破棄後タイマー発火確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('破棄後タイマー発火確認対象');
        fireEvent.changeText(input, '破棄されるはずの内容');

        // デバウンスタイマーが発火する(1000ms経過する)前に破棄を確定する
        const preventDefault = jest.fn();
        getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));
        const [, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
        const discardButton = (buttons as { text: string; onPress?: () => void }[]).find(
          (b) => b.text === '破棄',
        );
        await act(async () => {
          discardButton?.onPress?.();
        });
        await waitFor(() =>
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY),
        );
        (AsyncStorage.setItem as jest.Mock).mockClear();

        // 破棄確定時点で残っていたはずのデバウンスタイマーが発火しても、
        // 明示的にキャンセルされているため下書きが復活しない
        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          DRAFT_STORAGE_KEY,
          expect.any(String),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not re-persist the just-cleared draft when the pending debounce timer fires after a successful save', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '保存後タイマー発火確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('保存後タイマー発火確認対象');
        fireEvent.changeText(input, '保存される編集内容');

        // デバウンスタイマーが発火する(1000ms経過する)前に保存する
        fireEvent.press(screen.getByRole('button', { name: '保存' }));
        await waitFor(() =>
          expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY),
        );
        (AsyncStorage.setItem as jest.Mock).mockClear();

        // 保存完了時点で残っていたはずのデバウンスタイマーが発火しても、
        // 明示的にキャンセルされているため下書きキーへの書き込みが復活しない
        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          DRAFT_STORAGE_KEY,
          expect.any(String),
        );

        await act(async () => {
          jest.advanceTimersByTime(NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
        });
        expect(mockBack).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps auto-saved drafts separate per entry id so they do not bleed into another entry', async () => {
      const otherEntryId = 'entry-2';
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: 'エントリ1の元の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await seedDiaryEntry({
        id: otherEntryId,
        text: 'エントリ2の元の本文',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, 'エントリ1専用の下書き');

      setMockIdParam(otherEntryId);
      render(<EditEntryScreen />);

      // エントリ1専用の下書きキーが、無関係なエントリ2の編集画面に混入していないことを確認する
      expect(await screen.findByDisplayValue('エントリ2の元の本文')).toBeTruthy();
      expect(screen.queryByDisplayValue('エントリ1専用の下書き')).toBeNull();
    });

    it('truncates a restored draft to BODY_MAX_LENGTH when the auto-saved draft itself exceeds the limit, even though the saved original text is within the limit (境界値)', async () => {
      const overLimitDraft = 'あ'.repeat(BODY_MAX_LENGTH + 10);
      const truncatedDraft = 'あ'.repeat(BODY_MAX_LENGTH);
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '上限以内の元の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await AsyncStorage.setItem(DRAFT_STORAGE_KEY, overLimitDraft);
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});

      render(<EditEntryScreen />);

      expect(await screen.findByDisplayValue(truncatedDraft)).toBeTruthy();
      expect(screen.getByText(`${BODY_MAX_LENGTH}/${BODY_MAX_LENGTH}`)).toBeTruthy();
      // 切り詰め通知Alertは「保存済みの元の本文」の文字数のみを基準に判定される実装のため、
      // 元の本文自体は上限以内であるこのケースでは、下書き側が切り詰められても通知は出ない
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('falls back to the saved original text and keeps auto-save working afterward when restoring the draft fails (AsyncStorage.getItem rejects) (異常系)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '下書き復元に失敗した場合の元の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      // async-storage-mockは元々jest.fn()のため、jest.spyOnの`mockRestore()`では元の実装に
      // 戻らない(既知の挙動)。上書き前の実装を保存しておき、finallyで明示的に復元する
      const originalGetItemImpl = (AsyncStorage.getItem as jest.Mock).getMockImplementation();
      // 下書きキーへのgetItemのみrejectさせ、日記本体キーへの呼び出しは通常通り解決させる
      const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
        if (key === DRAFT_STORAGE_KEY) {
          return Promise.reject(new Error('read failed'));
        }
        return originalGetItemImpl ? originalGetItemImpl(key) : Promise.resolve(null);
      });

      // 未処理のPromise rejectionが発生していないことを検知するため、一時的にリスナーを登録する
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);

        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY));

        // rejectしたPromiseのcatch/finally節が実行されるまでマイクロタスクキューをフラッシュする
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(unhandledRejections).toHaveLength(0);
        expect(screen.getByDisplayValue('下書き復元に失敗した場合の元の本文')).toBeTruthy();

        // 復元処理が失敗してもisDraftRestoredはtrueになり、自動保存が無効化されたままにならない
        const input = screen.getByDisplayValue('下書き復元に失敗した場合の元の本文');
        fireEvent.changeText(input, '復元失敗後も自動保存される内容');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });

        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String)),
        );
        const [, persistedDraft] = (AsyncStorage.setItem as jest.Mock).mock.calls.find(
          ([key]) => key === DRAFT_STORAGE_KEY,
        );
        await expect(decryptPersistedDraft(persistedDraft)).resolves.toBe(
          '復元失敗後も自動保存される内容',
        );
      } finally {
        jest.useRealTimers();
        process.off('unhandledRejection', onUnhandledRejection);
        if (originalGetItemImpl) {
          getItemSpy.mockImplementation(originalGetItemImpl);
        }
      }
    });

    it('silently ignores an auto-save write failure (AsyncStorage.setItem rejects for the draft key) without showing an error or losing the in-progress edit (異常系)', async () => {
      await seedDiaryEntry({
        id: ENTRY_ID,
        text: '下書き自動保存失敗確認対象',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const originalSetItemImpl = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key: string, value: string) => {
        if (key === DRAFT_STORAGE_KEY) {
          return Promise.reject(new Error('write failed'));
        }
        return originalSetItemImpl ? originalSetItemImpl(key, value) : Promise.resolve();
      });

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      jest.useFakeTimers();
      try {
        render(<EditEntryScreen />);
        const input = await screen.findByDisplayValue('下書き自動保存失敗確認対象');
        fireEvent.changeText(input, '保存に失敗するはずの下書き');

        await act(async () => {
          jest.advanceTimersByTime(DRAFT_AUTO_SAVE_DEBOUNCE_MS);
        });
        await waitFor(() =>
          expect(AsyncStorage.setItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY, expect.any(String)),
        );

        // 下書きの自動保存(補助的な処理)が失敗しても、本文編集は継続でき、
        // 更新失敗のエラーメッセージ(本保存用)は表示されない
        expect(screen.queryByText('更新に失敗しました。もう一度お試しください。')).toBeNull();
        expect(screen.getByDisplayValue('保存に失敗するはずの下書き')).toBeTruthy();
        expect(unhandledRejections).toHaveLength(0);

        const stateUpdateWarning = consoleErrorSpy.mock.calls.find(([message]) =>
          String(message).includes('a component'),
        );
        expect(stateUpdateWarning).toBeUndefined();
      } finally {
        jest.useRealTimers();
        process.off('unhandledRejection', onUnhandledRejection);
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
