import { act, renderHook } from '@testing-library/react-native';

import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { BODY_MAX_LENGTH } from '@/utils/diary-text';

describe('useSaveDiaryEntry', () => {
  it('trims the text and calls persist with the trimmed value on success (正常系: trim・永続化・onSuccess呼び出し)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const persist = jest.fn().mockResolvedValue(undefined);
    const onSuccess = jest.fn();

    await act(async () => {
      await result.current.save({
        text: '  こんにちは  ',
        persist,
        onSuccess,
        errorMessage: 'エラー',
      });
    });

    expect(persist).toHaveBeenCalledWith('こんにちは');
    expect(onSuccess).toHaveBeenCalledWith('こんにちは');
    expect(result.current.isSaving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets isSaving to true only while persist is pending (正常系: 保存中フラグのON/OFF)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    let resolvePersist: () => void = () => {};
    const persist = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save({ text: '本文', persist, errorMessage: 'エラー' });
    });

    expect(result.current.isSaving).toBe(true);

    await act(async () => {
      resolvePersist();
      await savePromise;
    });

    expect(result.current.isSaving).toBe(false);
  });

  it('does nothing when the text is empty after trimming (バリデーション: 空文字はエラー設定もせず何もしない)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const persist = jest.fn();

    await act(async () => {
      await result.current.save({ text: '   ', persist, errorMessage: 'エラー' });
    });

    expect(persist).not.toHaveBeenCalled();
    expect(result.current.isSaving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does nothing when the text exceeds BODY_MAX_LENGTH graphemes (バリデーション: 文字数上限超過はエラー設定もせず何もしない)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const persist = jest.fn();
    const tooLong = 'あ'.repeat(BODY_MAX_LENGTH + 1);

    await act(async () => {
      await result.current.save({ text: tooLong, persist, errorMessage: 'エラー' });
    });

    expect(persist).not.toHaveBeenCalled();
    expect(result.current.isSaving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('skips persist and returns immediately when a save is already in progress (連打防止: 保存中は再入力を無視する)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    let resolveFirstPersist: () => void = () => {};
    const persist = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstPersist = resolve;
        }),
    );

    let firstSavePromise!: Promise<void>;
    act(() => {
      firstSavePromise = result.current.save({ text: '本文', persist, errorMessage: 'エラー' });
    });
    expect(result.current.isSaving).toBe(true);

    await act(async () => {
      await result.current.save({ text: '別の本文', persist, errorMessage: 'エラー' });
    });

    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstPersist();
      await firstSavePromise;
    });
  });

  it('calls onError and sets the error message when persist rejects (異常系: persist失敗時のonError呼び出しとエラー設定)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const persist = jest.fn().mockRejectedValue(new Error('failed'));
    const onError = jest.fn();
    const onSuccess = jest.fn();

    await act(async () => {
      await result.current.save({
        text: '本文',
        persist,
        onSuccess,
        onError,
        errorMessage: '保存に失敗しました。もう一度お試しください。',
      });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.error).toBe('保存に失敗しました。もう一度お試しください。');
    expect(result.current.isSaving).toBe(false);
  });

  it('clears a previous error at the start of a new save attempt (正常系: 再保存開始時にエラーがリセットされる)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const failingPersist = jest.fn().mockRejectedValue(new Error('failed'));

    await act(async () => {
      await result.current.save({ text: '本文', persist: failingPersist, errorMessage: '失敗' });
    });
    expect(result.current.error).toBe('失敗');

    const succeedingPersist = jest.fn().mockResolvedValue(undefined);
    await act(async () => {
      await result.current.save({
        text: '本文',
        persist: succeedingPersist,
        errorMessage: '失敗',
      });
    });

    expect(result.current.error).toBeNull();
  });

  it('does not update state after isMountedRef.current becomes false (アンマウント対策: isMountedRefがfalseならstate更新をスキップする)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const isMountedRef = { current: true };
    const persist = jest.fn().mockRejectedValue(new Error('failed'));

    await act(async () => {
      isMountedRef.current = false;
      await result.current.save({
        text: '本文',
        persist,
        errorMessage: 'エラー',
        isMountedRef,
      });
    });

    // isMountedRef.currentがfalseのため、エラーメッセージも保存中フラグも更新されないまま
    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(true);
  });

  it('allows the caller to reset the error via setError (例: モーダルを閉じる際のエラークリア)', async () => {
    const { result } = renderHook(() => useSaveDiaryEntry());
    const persist = jest.fn().mockRejectedValue(new Error('failed'));

    await act(async () => {
      await result.current.save({ text: '本文', persist, errorMessage: '失敗' });
    });
    expect(result.current.error).toBe('失敗');

    act(() => {
      result.current.setError(null);
    });

    expect(result.current.error).toBeNull();
  });
});
