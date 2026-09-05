import { useCallback, useState } from 'react';
import type { RefObject } from 'react';

import { BODY_MAX_LENGTH, splitIntoGraphemes } from '@/utils/diary-text';

// 日記の保存処理に共通する「連打防止 → trim → 文字数上限検証 → 保存中フラグON →
// 永続化 → catchでエラーメッセージ設定 → finallyで保存中フラグOFF」という骨格を切り出したフック
// 実際の永続化処理(persist)と、成功/失敗時の画面固有の副作用
// (楽観的更新・ロールバック・トースト表示・画面遷移等)は呼び出し側からコールバックとして渡す。
// `app/edit-entry/[id].tsx`のhandleSaveEdit、`app/(tabs)/index.tsx`のhandleSave /
// handleSaveNewEntryの3箇所で個別に手書きされていた同一パターンを共通化する。
export type SaveDiaryEntryOptions = {
  // 保存対象の本文(trim前)。空文字列・文字数上限超過の場合は何もせず(エラー設定もせず)returnする
  text: string;
  // 実際の永続化処理。trim済みの本文を受け取る
  persist: (trimmedText: string) => Promise<void>;
  // 永続化成功時に呼ばれる画面固有の副作用(モーダルを閉じる・トースト表示・router.back()等)
  onSuccess?: (trimmedText: string) => void | Promise<void>;
  // 永続化失敗時に呼ばれる画面固有の副作用(楽観的更新のロールバック等)。
  // エラーメッセージのstateへの設定自体はこのフックが行うため、呼び出し側で行う必要はない
  onError?: () => void;
  // 永続化失敗時にエラーstateへ設定するメッセージ
  errorMessage: string;
  // アンマウント後のstate更新(Reactの警告の原因)を避けるためのフラグ。永続化の完了を待つ間に
  // 画面がアンマウントされ得る場合のみ呼び出し側から渡す(省略時は常にtrueとして扱う)
  isMountedRef?: RefObject<boolean>;
};

export function useSaveDiaryEntry() {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async ({
      text,
      persist,
      onSuccess,
      onError,
      errorMessage,
      isMountedRef,
    }: SaveDiaryEntryOptions) => {
      // 既に保存処理が進行中であれば、連打による重複保存を防ぐため何もしない
      if (isSaving) {
        return;
      }

      const trimmed = text.trim();
      // チェックはgrapheme単位で行い、UTF-16コードユニット単位のlengthとのズレを防ぐ
      if (!trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
        return;
      }

      setIsSaving(true);
      setError(null);

      try {
        await persist(trimmed);
        await onSuccess?.(trimmed);
      } catch {
        onError?.();
        if (isMountedRef?.current ?? true) {
          setError(errorMessage);
        }
      } finally {
        if (isMountedRef?.current ?? true) {
          setIsSaving(false);
        }
      }
    },
    [isSaving],
  );

  return { isSaving, error, setError, save };
}
