import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import { loadDraftText } from '@/utils/diary-draft-storage';

export type DraftRestoreOptions = {
  // 復元対象のAsyncStorageキー。変わるたびに復元をやり直し、nullの間は何もしない
  draftKey: string | null;
  // 復元された下書きを入力欄のstateへ反映する
  onRestore: (storedDraft: string) => void;
  // 入力の編集回数。復元の読み込み中にユーザーが入力を始めた場合、その入力を上書きしないために使う
  editRevisionRef: RefObject<number>;
};

// 保存済みの下書きを復元し、復元が完了したか(useDraftAutoSaveの`isRestored`に渡す)を返す共通フック。
// 読み込みに失敗しても復元を諦めるだけで、完了扱いにして以降の自動保存が止まらないようにする
export function useDraftRestore({
  draftKey,
  onRestore,
  editRevisionRef,
}: DraftRestoreOptions): boolean {
  const [isRestored, setIsRestored] = useState(false);
  // onRestoreの参照が変わるたびに復元をやり直さないよう、最新の関数だけをrefで保持する
  const onRestoreRef = useRef(onRestore);
  useEffect(() => {
    onRestoreRef.current = onRestore;
  }, [onRestore]);

  useEffect(() => {
    setIsRestored(false);
    if (!draftKey) {
      return;
    }
    let isCancelled = false;
    const editRevisionAtStart = editRevisionRef.current;
    (async () => {
      try {
        const storedDraft = await loadDraftText(draftKey);
        if (!isCancelled && storedDraft && editRevisionRef.current === editRevisionAtStart) {
          onRestoreRef.current(storedDraft);
        }
      } catch {
        // 復元を諦めるだけにとどめる
      } finally {
        if (!isCancelled) {
          setIsRestored(true);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [draftKey, editRevisionRef]);

  return isRestored;
}
