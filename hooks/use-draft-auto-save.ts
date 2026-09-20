import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef } from 'react';

import { saveDraftText } from '@/utils/diary-draft-storage';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

export type DraftAutoSaveOptions = {
  // 下書きを保存するAsyncStorageキー。nullの間は自動保存しない
  draftKey: string | null;
  // 現在の入力内容。変更をデバウンスして保存し、空文字列の場合はキーを削除する
  draft: string;
  // 下書きの復元が完了したか。完了前に自動保存すると、初期値で保存済みの下書きを誤って上書き・削除する
  isRestored: boolean;
};

// 入力内容(draft)の変更をデバウンスしてAsyncStorageへ暗号化保存する共通フック
// (空文字列の場合はキーを削除する)。復元完了フラグの管理と復元処理は呼び出し側の責務
export function useDraftAutoSave({ draftKey, draft, isRestored }: DraftAutoSaveOptions) {
  // 保留中のデバウンスタイマー。clearDraftがクリーンアップ(アンマウント等)を待たずに
  // 明示的にキャンセルできるようにするために保持する
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isRestored || !draftKey) {
      return;
    }
    const timer = setTimeout(() => {
      timerRef.current = null;
      const persist = draft ? saveDraftText(draftKey, draft) : AsyncStorage.removeItem(draftKey);
      // 下書きの自動保存は補助的な処理のため、失敗しても静かに無視する(本保存の失敗は呼び出し側で伝える)
      persist.catch(() => {});
    }, DRAFT_AUTO_SAVE_DEBOUNCE_MS);
    timerRef.current = timer;
    return () => clearTimeout(timer);
  }, [draft, isRestored, draftKey]);

  // 下書きキーを削除する。先に保留中のタイマーをキャンセルし、削除後の再書き込みを防ぐ
  const clearDraft = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!draftKey) {
      return;
    }
    try {
      await AsyncStorage.removeItem(draftKey);
    } catch {
      // 下書きキーのクリアに失敗しても致命的ではないため無視する
    }
  }, [draftKey]);

  return { clearDraft };
}
