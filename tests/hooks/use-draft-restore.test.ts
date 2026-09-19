import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useDraftRestore } from '@/hooks/use-draft-restore';
import { loadDraftText } from '@/utils/diary-draft-storage';

jest.mock('@/utils/diary-draft-storage', () => ({
  loadDraftText: jest.fn(),
}));

const mockLoadDraftText = loadDraftText as jest.Mock;

describe('useDraftRestore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadDraftText.mockResolvedValue(null);
  });

  it('restores the stored draft and reports completion (正常系)', async () => {
    mockLoadDraftText.mockResolvedValue('保存済みの下書き');
    const onRestore = jest.fn();
    const editRevisionRef = { current: 0 };

    const { result } = renderHook(() =>
      useDraftRestore({ draftKey: 'key', onRestore, editRevisionRef }),
    );
    expect(result.current).toBe(false);

    await waitFor(() => expect(result.current).toBe(true));
    expect(mockLoadDraftText).toHaveBeenCalledWith('key');
    expect(onRestore).toHaveBeenCalledWith('保存済みの下書き');
  });

  it('reports completion without calling onRestore when nothing is stored (正常系: 下書き無し)', async () => {
    const onRestore = jest.fn();

    const { result } = renderHook(() =>
      useDraftRestore({ draftKey: 'key', onRestore, editRevisionRef: { current: 0 } }),
    );

    await waitFor(() => expect(result.current).toBe(true));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('still reports completion when loading fails, so that auto-save is not disabled forever (異常系)', async () => {
    mockLoadDraftText.mockRejectedValue(new Error('decrypt failure'));
    const onRestore = jest.fn();

    const { result } = renderHook(() =>
      useDraftRestore({ draftKey: 'key', onRestore, editRevisionRef: { current: 0 } }),
    );

    await waitFor(() => expect(result.current).toBe(true));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('does not overwrite the input that was edited while the draft was loading (境界値: 読み込み中の入力を優先)', async () => {
    let resolveLoad: (value: string) => void = () => {};
    mockLoadDraftText.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const onRestore = jest.fn();
    const editRevisionRef = { current: 0 };

    const { result } = renderHook(() =>
      useDraftRestore({ draftKey: 'key', onRestore, editRevisionRef }),
    );

    editRevisionRef.current += 1;
    await act(async () => {
      resolveLoad('古い下書き');
    });

    expect(onRestore).not.toHaveBeenCalled();
    expect(result.current).toBe(true);
  });

  it('does nothing and stays incomplete while the draft key is null (境界値: キー未確定)', async () => {
    const onRestore = jest.fn();

    const { result } = renderHook(() =>
      useDraftRestore({ draftKey: null, onRestore, editRevisionRef: { current: 0 } }),
    );

    await act(async () => {});
    expect(result.current).toBe(false);
    expect(mockLoadDraftText).not.toHaveBeenCalled();
  });

  it('resets the completion flag and restores again when the draft key changes (正常系: キー変更で復元をやり直す)', async () => {
    mockLoadDraftText.mockImplementation((key: string) => Promise.resolve(`下書き:${key}`));
    const onRestore = jest.fn();
    const editRevisionRef = { current: 0 };

    const { result, rerender } = renderHook(
      ({ draftKey }: { draftKey: string | null }) =>
        useDraftRestore({ draftKey, onRestore, editRevisionRef }),
      { initialProps: { draftKey: 'a' as string | null } },
    );
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ draftKey: 'b' });
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));

    expect(onRestore).toHaveBeenNthCalledWith(1, '下書き:a');
    expect(onRestore).toHaveBeenNthCalledWith(2, '下書き:b');

    rerender({ draftKey: null });
    expect(result.current).toBe(false);
  });

  it('ignores a load result that resolves after the key changed or after unmount (異常系: 古い読み込み結果の破棄)', async () => {
    const resolvers: Record<string, (value: string) => void> = {};
    mockLoadDraftText.mockImplementation(
      (key: string) =>
        new Promise<string>((resolve) => {
          resolvers[key] = resolve;
        }),
    );
    const onRestore = jest.fn();
    const editRevisionRef = { current: 0 };

    const { result, rerender, unmount } = renderHook(
      ({ draftKey }: { draftKey: string }) =>
        useDraftRestore({ draftKey, onRestore, editRevisionRef }),
      { initialProps: { draftKey: 'a' } },
    );
    rerender({ draftKey: 'b' });

    await act(async () => {
      resolvers.a('a由来の下書き');
    });
    expect(onRestore).not.toHaveBeenCalled();
    expect(result.current).toBe(false);

    unmount();
    await act(async () => {
      resolvers.b('b由来の下書き');
    });
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('calls the latest onRestore without restarting the restore when only its identity changes (正常系)', async () => {
    let resolveLoad: (value: string) => void = () => {};
    mockLoadDraftText.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const firstOnRestore = jest.fn();
    const latestOnRestore = jest.fn();
    const editRevisionRef = { current: 0 };

    const { rerender } = renderHook(
      ({ onRestore }: { onRestore: (text: string) => void }) =>
        useDraftRestore({ draftKey: 'key', onRestore, editRevisionRef }),
      { initialProps: { onRestore: firstOnRestore } },
    );
    rerender({ onRestore: latestOnRestore });

    await act(async () => {
      resolveLoad('下書き');
    });

    expect(mockLoadDraftText).toHaveBeenCalledTimes(1);
    expect(firstOnRestore).not.toHaveBeenCalled();
    expect(latestOnRestore).toHaveBeenCalledWith('下書き');
  });
});
