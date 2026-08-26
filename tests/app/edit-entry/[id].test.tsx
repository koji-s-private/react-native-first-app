import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import React from 'react';
import { Alert, StyleSheet } from 'react-native';

import EditEntryScreen from '@/app/edit-entry/[id]';
import { decryptText, encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import { buildDiaryEntryKey, type DiaryEntry } from '@/utils/diary-storage';

// ネイティブの`AsyncStorage`はJest環境では利用できないため、公式のインメモリモックに差し替える
// (tests/app/index.test.tsxと同じ方式)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

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
  const mockBack = jest.fn();
  const mockAddListener = jest.fn((_event: string, _callback: unknown) => () => {});
  const mockDispatch = jest.fn();

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

  it('shows a message instead of the editor when no entry matches the given id (異常系/境界値)', async () => {
    render(<EditEntryScreen />);

    expect(await screen.findByText('編集対象の日記が見つかりませんでした。')).toBeTruthy();
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
    const createdAt = '2026-01-01T09:00:00.000Z';
    await seedDiaryEntry({ id: ENTRY_ID, text: '編集前の日記', createdAt });

    render(<EditEntryScreen />);
    const input = await screen.findByDisplayValue('編集前の日記');
    fireEvent.changeText(input, '編集後の日記');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));

    const persisted = await readPersistedEntry(ENTRY_ID);
    expect(persisted).toEqual({ id: ENTRY_ID, text: '編集後の日記', createdAt });
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
  });

  it('ignores a second press of the save button while an update is still in flight, preventing a duplicate write', async () => {
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
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
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

    it('does not prevent leaving on a subsequent beforeRemove check once the draft has been saved successfully', async () => {
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
      await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));

      // 保存成功後は「未保存の変更」ではなくなるため、以降のbeforeRemoveチェックでは
      // 確認ダイアログを出さない(保存後にeditOriginalTextRefが更新されていることの確認)
      const preventDefault = jest.fn();
      getBeforeRemoveListener()(buildBeforeRemoveEvent(preventDefault));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });
  });
});
