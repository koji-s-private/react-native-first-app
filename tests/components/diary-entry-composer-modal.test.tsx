import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable } from 'react-native';

import { DiaryEntryComposerModal } from '@/components/diary-entry-composer-modal';
import { type SaveDiaryEntryOptions, useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { loadDraftText, saveDraftText } from '@/utils/diary-draft-storage';

jest.mock('@/hooks/use-modal-slide-transition', () => ({
  useModalSlideTransition: () => ({
    isMounted: true,
    overlayOpacity: 1,
    contentTranslateY: 0,
  }),
}));

jest.mock('@/utils/diary-draft-storage', () => ({
  loadDraftText: jest.fn(),
  saveDraftText: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/hooks/use-save-diary-entry', () => ({
  useSaveDiaryEntry: jest.fn(),
}));

const loadDraftTextMock = jest.mocked(loadDraftText);
const saveDraftTextMock = jest.mocked(saveDraftText);
const useSaveDiaryEntryMock = jest.mocked(useSaveDiaryEntry);
const saveEntryMock = jest.fn(async (_options: SaveDiaryEntryOptions) => {});
const setErrorMock = jest.fn();

const defaultProps = {
  dateKey: '2026-09-19',
  draftStorageKeyPrefix: 'test-draft-',
  contentBottomPadding: 0,
  persist: jest.fn(() => Promise.resolve()),
  onSaved: jest.fn(),
  onClose: jest.fn(),
};

// 呼び出し画面と同様に、閉じる・保存成功でdateKeyをnullへ戻すホスト
function Host({
  initialDateKey = '2026-09-19',
  onSaveError,
}: {
  initialDateKey?: string | null;
  onSaveError?: () => void;
}) {
  const [dateKey, setDateKey] = useState<string | null>(initialDateKey);
  return (
    <>
      <DiaryEntryComposerModal
        {...defaultProps}
        dateKey={dateKey}
        onClose={() => {
          defaultProps.onClose();
          setDateKey(null);
        }}
        onSaved={() => {
          defaultProps.onSaved();
          setDateKey(null);
        }}
        onSaveError={onSaveError}
      />
      <Pressable testID="open-0918" onPress={() => setDateKey('2026-09-18')} />
      <Pressable testID="open-0919" onPress={() => setDateKey('2026-09-19')} />
    </>
  );
}

describe('DiaryEntryComposerModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadDraftTextMock.mockResolvedValue(null);
    saveDraftTextMock.mockResolvedValue(undefined);
    saveEntryMock.mockResolvedValue(undefined);
    useSaveDiaryEntryMock.mockReturnValue({
      isSaving: false,
      error: null,
      setError: setErrorMock,
      save: saveEntryMock,
    });
  });

  it('renders a transparent Modal that extends under the status bar and navigation bar, so the overlay covers the whole screen', async () => {
    render(<DiaryEntryComposerModal {...defaultProps} />);
    await waitFor(() => expect(loadDraftTextMock).toHaveBeenCalled());

    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.transparent).toBe(true);
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
  });

  it('restores the saved draft when the user has not edited the input while loading', async () => {
    loadDraftTextMock.mockResolvedValueOnce('保存されていた下書き');

    render(<DiaryEntryComposerModal {...defaultProps} />);

    await waitFor(() =>
      expect(screen.getByLabelText('日記本文').props.value).toBe('保存されていた下書き'),
    );
    expect(loadDraftTextMock).toHaveBeenCalledWith('test-draft-2026-09-19');
  });

  it('keeps text entered before draft restoration finishes instead of overwriting it', async () => {
    let resolveLoad: (value: string | null) => void = () => {};
    loadDraftTextMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(<DiaryEntryComposerModal {...defaultProps} />);
    fireEvent.changeText(screen.getByLabelText('日記本文'), '読み込み中に入力した本文');

    await act(async () => {
      resolveLoad('古い下書き');
    });

    expect(screen.getByLabelText('日記本文').props.value).toBe('読み込み中に入力した本文');
  });

  it('shows a spinner and changes the save button label while saving is in progress', async () => {
    useSaveDiaryEntryMock.mockReturnValue({
      isSaving: true,
      error: null,
      setError: setErrorMock,
      save: saveEntryMock,
    });

    render(<DiaryEntryComposerModal {...defaultProps} />);
    await waitFor(() => expect(loadDraftTextMock).toHaveBeenCalled());

    expect(screen.getByText('保存中...')).toBeTruthy();
    expect(screen.queryByText('保存')).toBeNull();
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存' }).props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('passes a mounted ref to the save flow after StrictMode replays effects', async () => {
    render(
      <StrictMode>
        <DiaryEntryComposerModal {...defaultProps} />
      </StrictMode>,
    );
    await waitFor(() => expect(loadDraftTextMock).toHaveBeenCalled());

    fireEvent.changeText(screen.getByLabelText('日記本文'), '保存する本文');
    fireEvent.press(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(saveEntryMock).toHaveBeenCalledTimes(1));
    expect(saveEntryMock.mock.calls[0][0].isMountedRef?.current).toBe(true);
  });

  describe('下書きの自動保存・破棄・日付切り替え', () => {
    const DEBOUNCE_MS = 1000;
    const KEY_0919 = 'test-draft-2026-09-19';
    const KEY_0918 = 'test-draft-2026-09-18';
    let removeItemSpy: jest.SpyInstance;
    let alertSpy: jest.SpyInstance;

    async function advance(ms: number) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }

    function pressAlertButton(style: 'cancel' | 'destructive') {
      const buttons = (alertSpy.mock.calls[0][2] ?? []) as {
        style?: string;
        onPress?: () => void;
      }[];
      buttons.find((button) => button.style === style)?.onPress?.();
    }

    beforeEach(() => {
      jest.useFakeTimers();
      removeItemSpy = jest.spyOn(AsyncStorage, 'removeItem').mockResolvedValue(undefined);
      alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    });

    afterEach(() => {
      removeItemSpy.mockRestore();
      alertSpy.mockRestore();
      jest.useRealTimers();
    });

    it('removes an already auto-saved draft key when the modal is closed after the input was emptied within the debounce interval (境界値: 空にして即閉じる)', async () => {
      render(<Host />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '消す予定の本文');
      await advance(DEBOUNCE_MS);
      expect(saveDraftTextMock).toHaveBeenCalledWith(KEY_0919, '消す予定の本文');

      fireEvent.changeText(screen.getByLabelText('日記本文'), '');
      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      await advance(DEBOUNCE_MS * 2);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith(KEY_0919);
    });

    it('removes an already auto-saved draft key when the modal is closed with a whitespace-only input (境界値: 空白のみ)', async () => {
      render(<Host />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '   ');
      await advance(DEBOUNCE_MS);
      expect(saveDraftTextMock).toHaveBeenCalledWith(KEY_0919, '   ');

      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      await advance(DEBOUNCE_MS * 2);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith(KEY_0919);
    });

    it('keeps the stored draft when the modal is closed with an empty input before the draft restoration has finished (境界値: 復元前に閉じる)', async () => {
      loadDraftTextMock.mockImplementationOnce(() => new Promise(() => {}));
      render(<DiaryEntryComposerModal {...defaultProps} />);
      await advance(0);

      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      await advance(DEBOUNCE_MS * 2);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).not.toHaveBeenCalled();
      expect(saveDraftTextMock).not.toHaveBeenCalled();
    });

    it('does not close, and keeps auto-saving, when "キャンセル" is chosen in the discard confirmation (正常系)', async () => {
      render(<Host />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '入力中の本文');
      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      expect(alertSpy).toHaveBeenCalledTimes(1);
      pressAlertButton('cancel');
      await advance(DEBOUNCE_MS);

      expect(defaultProps.onClose).not.toHaveBeenCalled();
      expect(saveDraftTextMock).toHaveBeenCalledWith(KEY_0919, '入力中の本文');
    });

    it('cancels the pending auto-save and removes the key when "破棄" is chosen, so the discarded text is not written back (異常系: 保留タイマーとの競合)', async () => {
      render(<Host />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '破棄する本文');
      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      await act(async () => {
        pressAlertButton('destructive');
      });
      await advance(DEBOUNCE_MS * 2);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith(KEY_0919);
      expect(saveDraftTextMock).not.toHaveBeenCalled();
    });

    it('cancels the pending auto-save and removes the key on a successful save, so the saved text is not written back (正常系: 保留タイマーとの競合)', async () => {
      saveEntryMock.mockImplementationOnce(async (options: SaveDiaryEntryOptions) => {
        await options.persist(options.text.trim());
        await options.onSuccess?.(options.text.trim());
      });
      render(<Host />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '保存する本文');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await advance(0);
      await advance(DEBOUNCE_MS * 2);

      expect(defaultProps.persist).toHaveBeenCalledWith('保存する本文');
      expect(defaultProps.onSaved).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith(KEY_0919);
      expect(saveDraftTextMock).not.toHaveBeenCalled();
    });

    it('keeps the draft (does not remove the key, keeps auto-saving) and calls onSaveError when saving fails (異常系)', async () => {
      const onSaveError = jest.fn();
      saveEntryMock.mockImplementationOnce(async (options: SaveDiaryEntryOptions) => {
        options.onError?.();
      });
      render(<Host onSaveError={onSaveError} />);
      await advance(0);

      fireEvent.changeText(screen.getByLabelText('日記本文'), '失敗する本文');
      fireEvent.press(screen.getByRole('button', { name: '保存' }));
      await advance(DEBOUNCE_MS);

      expect(onSaveError).toHaveBeenCalledTimes(1);
      expect(defaultProps.onSaved).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();
      expect(saveDraftTextMock).toHaveBeenCalledWith(KEY_0919, '失敗する本文');
    });

    it('resets the input and never writes the previous date text under the new date key when dateKey changes directly (境界値: 日付の直接切り替え)', async () => {
      loadDraftTextMock.mockImplementation(async (key: string) =>
        key === KEY_0918 ? '前日の保存済み下書き' : null,
      );
      const { rerender } = render(<DiaryEntryComposerModal {...defaultProps} />);
      await advance(0);
      fireEvent.changeText(screen.getByLabelText('日記本文'), '19日の本文');
      await advance(DEBOUNCE_MS);
      expect(saveDraftTextMock).toHaveBeenLastCalledWith(KEY_0919, '19日の本文');
      saveDraftTextMock.mockClear();

      rerender(<DiaryEntryComposerModal {...defaultProps} dateKey="2026-09-18" />);
      await advance(0);
      expect(screen.getByLabelText('日記本文').props.value).toBe('前日の保存済み下書き');
      await advance(DEBOUNCE_MS * 2);

      expect(saveDraftTextMock).not.toHaveBeenCalledWith(KEY_0918, '19日の本文');
      expect(saveDraftTextMock).not.toHaveBeenCalledWith(KEY_0919, expect.anything());
    });

    it('starts with an empty input, and writes no leftover text, when reopened for another date after being closed (正常系: 閉じて別日を開く)', async () => {
      render(<Host />);
      await advance(0);
      fireEvent.changeText(screen.getByLabelText('日記本文'), '19日の本文');
      await advance(DEBOUNCE_MS);
      saveDraftTextMock.mockClear();
      fireEvent.press(screen.getByRole('button', { name: '閉じる' }));
      await act(async () => {
        pressAlertButton('destructive');
      });

      fireEvent.press(screen.getByTestId('open-0918'));
      await advance(DEBOUNCE_MS * 2);

      expect(screen.getByLabelText('日記本文').props.value).toBe('');
      expect(loadDraftTextMock).toHaveBeenLastCalledWith(KEY_0918);
      expect(saveDraftTextMock).not.toHaveBeenCalled();
    });

    it('does not read or write anything while the modal is closed (dateKey is null) (境界値: キー未確定)', async () => {
      render(<Host initialDateKey={null} />);
      await advance(DEBOUNCE_MS * 2);

      expect(saveDraftTextMock).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();
      expect(loadDraftTextMock).not.toHaveBeenCalled();
    });
  });
});
