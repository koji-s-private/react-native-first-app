import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  decryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';

/**
 * 日記データをAsyncStorageに保存する際のキー。
 * `app/(tabs)/index.tsx`(保存・読み込み)とこのファイル(全件削除・全件取得)の両方で
 * 同じキーを参照する必要があるため、一箇所にまとめてexportする。
 */
export const DIARY_ENTRIES_STORAGE_KEY = 'diary-entries';

/**
 * 日記1件分のデータ構造。`app/(tabs)/index.tsx`とエクスポート機能(`getAllDiaryEntries`)の
 * 両方で使うため、ここに集約する。
 */
export type DiaryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

/**
 * 与えられた値が`DiaryEntry`として妥当な形をしているかどうかを判定する型ガード。
 * `id`, `text`, `createdAt`のいずれもstring型であることを確認する
 * (AsyncStorageから読み込んだJSONは実行時に型が保証されないため、`JSON.parse`結果を
 * そのまま`as DiaryEntry`で扱わずここで検証する)。
 */
function isDiaryEntry(value: unknown): value is DiaryEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}

/**
 * 保存済みの日記データをAsyncStorageから全件削除する。
 * ストアのデータ削除要件(Google Play/Apple双方でユーザーによるデータ削除手段の提供が
 * 求められる)に対応するための機能で、設定画面から呼び出される想定。
 *
 * 暗号鍵(expo-secure-store側)や他の設定値など、日記データ以外のAsyncStorageキーには
 * 影響を与えないよう、日記データのキーのみを対象にremoveItemする。
 */
export async function clearAllDiaryEntries(): Promise<void> {
  await AsyncStorage.removeItem(DIARY_ENTRIES_STORAGE_KEY);
}

/**
 * 保存済みの日記データをAsyncStorageから全件取得し、必要であれば復号して返す。
 * `app/(tabs)/index.tsx`の一覧表示と、設定画面のエクスポート機能の両方から利用する
 * 共通ロジックとして切り出している(復号ロジックを重複実装しない)。
 *
 * ストレージが空・壊れている・スキーマ不整合・復号失敗のいずれの場合も例外を投げず、
 * 空配列を返す(呼び出し元の既存の挙動を踏襲)。
 */
export async function getAllDiaryEntries(): Promise<DiaryEntry[]> {
  try {
    const stored = await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY);
    if (!stored) {
      return [];
    }
    let parsed: unknown;
    if (isEncryptedPayload(stored)) {
      const key = await getOrCreateEncryptionKey();
      parsed = JSON.parse(decryptText(stored, key));
    } else {
      // 暗号化対応前に保存された平文JSON(後方互換)。そのまま読み込む
      parsed = JSON.parse(stored);
    }
    // パース結果自体が配列でない場合は空配列を返す
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 配列の要素のうち型ガードを通らない不正な要素はスキップし、有効なエントリのみを返す
    return parsed.filter(isDiaryEntry);
  } catch {
    // ストレージが壊れている・復号失敗の場合は空配列を返す
    return [];
  }
}
