import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  decryptText,
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';

/**
 * 日記データをAsyncStorageに保存する際に、かつて使われていた単一キー(全件を1つの配列として
 * 保存する方式)。
 * このキー自体は「移行(マイグレーション)元」としてのみ参照する。
 * 既存テストや過去バージョンで保存されたデータとの後方互換のため、exportは維持する。
 */
export const DIARY_ENTRIES_STORAGE_KEY = 'diary-entries';

/**
 * 日記エントリ1件分をAsyncStorageに個別に保存する際のキーのプレフィックス。
 * `<prefix><id>`の形で、エントリごとに独立したキーを持つ。
 * 1件の保存/削除がO(1)になり、エントリ数が増えても他のエントリの読み書きが発生しない。
 */
export const DIARY_ENTRY_KEY_PREFIX = 'diary-entry:';

/** 指定したエントリidから、AsyncStorage上のキーを組み立てる */
export function buildDiaryEntryKey(id: string): string {
  return `${DIARY_ENTRY_KEY_PREFIX}${id}`;
}

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
 * `utils/diary-import.ts`のインポート時スキーマ検証でも同じロジックを再利用するためexportする。
 */
export function isDiaryEntry(value: unknown): value is DiaryEntry {
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
 * レガシーキー(`DIARY_ENTRIES_STORAGE_KEY`)に全件配列として保存された日記データが残っている場合、
 * エントリ単位の個別キーへ移行する。
 *
 * - レガシーキーが存在しない場合は何もしない(冪等)。
 * - 移行が完了すると必ずレガシーキーを削除するため、次回以降の呼び出しでは即座に返る。
 * - 復号・パースに失敗した場合は例外を投げる(呼び出し元の`getAllDiaryEntries`のtry/catchで
 *   空配列を返す処理に委ねる。中途半端な状態でレガシーキーを消してデータを失わないようにするため、
 *   ここでは削除しない)。
 */
async function migrateLegacyEntriesIfNeeded(): Promise<void> {
  const legacyStored = await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY);
  if (!legacyStored) {
    return;
  }

  let parsed: unknown;
  if (isEncryptedPayload(legacyStored)) {
    const key = await getOrCreateEncryptionKey();
    parsed = JSON.parse(decryptText(legacyStored, key));
  } else {
    // 暗号化対応前に保存された平文JSON(後方互換)
    parsed = JSON.parse(legacyStored);
  }

  const rawEntries = Array.isArray(parsed) ? parsed : [];
  const validEntries = rawEntries.filter(isDiaryEntry);
  if (validEntries.length !== rawEntries.length) {
    console.warn(
      `getAllDiaryEntries: レガシーデータの移行時に${rawEntries.length - validEntries.length}件の不正なエントリをスキップしました(元の件数: ${rawEntries.length}件, 有効な件数: ${validEntries.length}件)`,
    );
  }

  if (validEntries.length > 0) {
    const key = await getOrCreateEncryptionKey();
    const entries: [string, string][] = validEntries.map((entry) => [
      buildDiaryEntryKey(entry.id),
      encryptText(JSON.stringify(entry), key),
    ]);
    await AsyncStorage.multiSet(entries);
  }

  // 移行が完了したので、以降このキーが再び参照されないよう削除する
  await AsyncStorage.removeItem(DIARY_ENTRIES_STORAGE_KEY);
}

/**
 * 保存済みの日記データをAsyncStorageから全件削除する。
 * ストアのデータ削除要件(Google Play/Apple双方でユーザーによるデータ削除手段の提供が
 * 求められる)に対応するための機能で、設定画面から呼び出される想定。
 *
 * 暗号鍵(expo-secure-store側)や他の設定値など、日記データ以外のAsyncStorageキーには
 * 影響を与えないよう、日記データのキー(エントリ単位の個別キー、および念のためレガシーキー)
 * のみを対象に削除する。
 */
export async function clearAllDiaryEntries(): Promise<void> {
  const allKeys = await AsyncStorage.getAllKeys();
  const entryKeys = allKeys.filter((key) => key.startsWith(DIARY_ENTRY_KEY_PREFIX));
  if (entryKeys.length > 0) {
    await AsyncStorage.multiRemove(entryKeys);
  }
  // 移行が完了していれば通常は既に存在しないが、念のため引き続き削除しておく
  await AsyncStorage.removeItem(DIARY_ENTRIES_STORAGE_KEY);
}

/**
 * 保存済みの日記データをAsyncStorageから全件取得し、必要であれば復号して返す。
 * `app/(tabs)/index.tsx`の一覧表示と、設定画面のエクスポート機能の両方から利用する
 * 共通ロジックとして切り出している(復号ロジックを重複実装しない)。
 *
 * 呼び出しの冒頭でレガシーキーからの移行(migrateLegacyEntriesIfNeeded)を行ってから、
 * エントリ単位の個別キーを全て読み込む。AsyncStorage.getAllKeys()の返す順序は保証されない
 * ため、`createdAt`の降順(新しい順)に並べ替えて返す(UI側は配列の先頭が最新という前提を
 * 置いているため、この並び順を崩さないようにする)。
 *
 * ストレージが空・壊れている・スキーマ不整合・復号失敗のいずれの場合も例外を投げず、
 * 空配列を返す(呼び出し元の既存の挙動を踏襲)。
 */
export async function getAllDiaryEntries(): Promise<DiaryEntry[]> {
  try {
    await migrateLegacyEntriesIfNeeded();

    const allKeys = await AsyncStorage.getAllKeys();
    const entryKeys = allKeys.filter((key) => key.startsWith(DIARY_ENTRY_KEY_PREFIX));
    if (entryKeys.length === 0) {
      return [];
    }

    const keyValuePairs = await AsyncStorage.multiGet(entryKeys);

    // 暗号鍵の取得(SecureStoreへの非同期アクセス)は初回の1回だけ行い、以降のエントリで使い回す
    let key: Uint8Array | null = null;
    const validEntries: DiaryEntry[] = [];
    let totalCount = 0;
    let invalidCount = 0;

    for (const [, storedValue] of keyValuePairs) {
      if (!storedValue) {
        continue;
      }
      totalCount += 1;

      try {
        let parsed: unknown;
        if (isEncryptedPayload(storedValue)) {
          if (!key) {
            key = await getOrCreateEncryptionKey();
          }
          parsed = JSON.parse(decryptText(storedValue, key));
        } else {
          // 暗号化対応前に保存された平文JSON(後方互換)。そのまま読み込む
          parsed = JSON.parse(storedValue);
        }
        if (isDiaryEntry(parsed)) {
          validEntries.push(parsed);
        } else {
          invalidCount += 1;
        }
      } catch {
        // 個々のエントリの復号・パースに失敗しても、他の正常なエントリの表示を妨げないよう
        // このエントリだけをスキップする(1件の破損が全件読み込み不能に波及しないようにするため)
        invalidCount += 1;
      }
    }

    if (invalidCount > 0) {
      // サイレントにスキップするとデータ欠落に誰も気づけないため、開発者向けにログを残す
      console.warn(
        `getAllDiaryEntries: ${invalidCount}件の不正なエントリをスキップしました(元の件数: ${totalCount}件, 有効な件数: ${validEntries.length}件)`,
      );
    }

    // createdAtの降順(新しい順)。同じcreatedAtが重複する場合はidの降順でtie-breakし、
    // 呼び出しごとに順序が不安定にならないようにする
    validEntries.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    return validEntries;
  } catch {
    // ストレージが壊れている・復号失敗の場合は空配列を返す
    return [];
  }
}

/**
 * 日記エントリ1件を暗号化して該当の個別キーに保存する(新規追加・編集どちらでも使う)。
 * 1回のAsyncStorage書き込みで完結し、他のエントリの読み書きは発生させない。
 */
export async function saveDiaryEntry(entry: DiaryEntry): Promise<void> {
  const key = await getOrCreateEncryptionKey();
  await AsyncStorage.setItem(buildDiaryEntryKey(entry.id), encryptText(JSON.stringify(entry), key));
}

/** 日記エントリ1件を、該当の個別キーごと削除する */
export async function deleteDiaryEntry(id: string): Promise<void> {
  await AsyncStorage.removeItem(buildDiaryEntryKey(id));
}
