import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

import { useDraftAutoSave } from '@/hooks/use-draft-auto-save';
import { saveDraftText } from '@/utils/diary-draft-storage';

jest.mock('@/utils/diary-draft-storage', () => ({
  saveDraftText: jest.fn(() => Promise.resolve()),
}));

const DEBOUNCE_MS = 1000;
const KEY = 'test-draft-key';

describe('useDraftAutoSave', () => {
  let removeItemSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    removeItemSpy = jest.spyOn(AsyncStorage, 'removeItem').mockResolvedValue(undefined);
  });

  afterEach(() => {
    removeItemSpy.mockRestore();
    jest.useRealTimers();
  });

  it('saves the draft only after the debounce interval has elapsed (正常系: デバウンス保存)', () => {
    renderHook(() => useDraftAutoSave({ draftKey: KEY, draft: '本文', isRestored: true }));

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS - 1);
    });
    expect(saveDraftText).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(saveDraftText).toHaveBeenCalledTimes(1);
    expect(saveDraftText).toHaveBeenCalledWith(KEY, '本文');
    expect(removeItemSpy).not.toHaveBeenCalled();
  });

  it('saves only the latest draft when it changes again within the debounce interval (正常系: 連続入力は最後の内容のみ保存)', () => {
    const { rerender } = renderHook(
      ({ draft }: { draft: string }) =>
        useDraftAutoSave({ draftKey: KEY, draft, isRestored: true }),
      { initialProps: { draft: 'a' } },
    );

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS - 100);
    });
    rerender({ draft: 'ab' });
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(saveDraftText).toHaveBeenCalledTimes(1);
    expect(saveDraftText).toHaveBeenCalledWith(KEY, 'ab');
  });

  it('removes the storage key instead of saving when the draft is empty (正常系: 空文字時のキー削除)', () => {
    renderHook(() => useDraftAutoSave({ draftKey: KEY, draft: '', isRestored: true }));

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(removeItemSpy).toHaveBeenCalledWith(KEY);
    expect(saveDraftText).not.toHaveBeenCalled();
  });

  it('does not save or remove anything until the draft has been restored (境界値: 復元完了前は上書きしない)', () => {
    const { rerender } = renderHook(
      ({ isRestored }: { isRestored: boolean }) =>
        useDraftAutoSave({ draftKey: KEY, draft: '', isRestored }),
      { initialProps: { isRestored: false } },
    );

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });
    expect(removeItemSpy).not.toHaveBeenCalled();
    expect(saveDraftText).not.toHaveBeenCalled();

    rerender({ isRestored: true });
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(removeItemSpy).toHaveBeenCalledWith(KEY);
  });

  it('does nothing while the draft key is null (境界値: キー未確定)', () => {
    renderHook(() => useDraftAutoSave({ draftKey: null, draft: '本文', isRestored: true }));

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });

    expect(saveDraftText).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
  });

  it('cancels the pending save on unmount (異常系: アンマウント後の書き込み防止)', () => {
    const { unmount } = renderHook(() =>
      useDraftAutoSave({ draftKey: KEY, draft: '本文', isRestored: true }),
    );

    unmount();
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });

    expect(saveDraftText).not.toHaveBeenCalled();
  });

  it('ignores a failure of the background save without throwing (異常系: 自動保存の失敗は無視)', async () => {
    (saveDraftText as jest.Mock).mockRejectedValueOnce(new Error('storage failure'));
    renderHook(() => useDraftAutoSave({ draftKey: KEY, draft: '本文', isRestored: true }));

    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(saveDraftText).toHaveBeenCalledTimes(1);
  });

  it('discards the pending save for the old key and saves only under the new key when the draft key changes (境界値: キー切り替え)', () => {
    const { rerender } = renderHook(
      ({ draftKey }: { draftKey: string }) =>
        useDraftAutoSave({ draftKey, draft: '本文', isRestored: true }),
      { initialProps: { draftKey: 'key-a' } },
    );

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS - 100);
    });
    rerender({ draftKey: 'key-b' });
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });

    expect(saveDraftText).toHaveBeenCalledTimes(1);
    expect(saveDraftText).toHaveBeenCalledWith('key-b', '本文');
  });

  it('cancels the pending save when the draft key becomes null (境界値: モーダルを閉じた状態への遷移)', () => {
    const { rerender } = renderHook(
      ({ draftKey }: { draftKey: string | null }) =>
        useDraftAutoSave({ draftKey, draft: '本文', isRestored: true }),
      { initialProps: { draftKey: KEY as string | null } },
    );

    rerender({ draftKey: null });
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });

    expect(saveDraftText).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
  });

  describe('clearDraft', () => {
    it('cancels the pending save and removes the key so the cleared draft is not written back (正常系)', async () => {
      const { result } = renderHook(() =>
        useDraftAutoSave({ draftKey: KEY, draft: '本文', isRestored: true }),
      );

      await act(async () => {
        await result.current.clearDraft();
      });
      act(() => {
        jest.advanceTimersByTime(DEBOUNCE_MS * 2);
      });

      expect(removeItemSpy).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith(KEY);
      expect(saveDraftText).not.toHaveBeenCalled();
    });

    it('keeps auto-saving later edits after clearDraft (正常系: クリア後の再入力)', async () => {
      const { result, rerender } = renderHook(
        ({ draft }: { draft: string }) =>
          useDraftAutoSave({ draftKey: KEY, draft, isRestored: true }),
        { initialProps: { draft: '本文' } },
      );

      await act(async () => {
        await result.current.clearDraft();
      });
      rerender({ draft: '本文に追記' });
      act(() => {
        jest.advanceTimersByTime(DEBOUNCE_MS);
      });

      expect(saveDraftText).toHaveBeenCalledTimes(1);
      expect(saveDraftText).toHaveBeenCalledWith(KEY, '本文に追記');
    });

    it('removes the key that is current at the time of the call after the draft key changed (境界値: キー切り替え後)', async () => {
      const { result, rerender } = renderHook(
        ({ draftKey }: { draftKey: string }) =>
          useDraftAutoSave({ draftKey, draft: '', isRestored: true }),
        { initialProps: { draftKey: 'key-a' } },
      );
      rerender({ draftKey: 'key-b' });

      await act(async () => {
        await result.current.clearDraft();
      });

      expect(removeItemSpy).toHaveBeenCalledTimes(1);
      expect(removeItemSpy).toHaveBeenCalledWith('key-b');
    });

    it('resolves without throwing even when removing the key fails (異常系)', async () => {
      removeItemSpy.mockRejectedValueOnce(new Error('storage failure'));
      const { result } = renderHook(() =>
        useDraftAutoSave({ draftKey: KEY, draft: '本文', isRestored: true }),
      );

      await expect(result.current.clearDraft()).resolves.toBeUndefined();
    });

    it('does not touch the storage when the draft key is null (境界値)', async () => {
      const { result } = renderHook(() =>
        useDraftAutoSave({ draftKey: null, draft: '本文', isRestored: true }),
      );

      await act(async () => {
        await result.current.clearDraft();
      });

      expect(removeItemSpy).not.toHaveBeenCalled();
    });
  });
});
