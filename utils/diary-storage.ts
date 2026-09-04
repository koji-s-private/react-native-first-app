import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  decryptText,
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';

/**
 * かつて全件を1つの配列として保存していた際の単一キー。現在は移行(マイグレーション)元としてのみ
 * 参照する。過去バージョンで保存されたデータとの後方互換のためexportを維持する。
 */
export const DIARY_ENTRIES_STORAGE_KEY = 'diary-entries';

/**
 * 日記エントリ1件を個別キー(`<prefix><id>`)で保存する際のプレフィックス。
 * エントリごとにキーを分けることで、1件の保存/削除をO(1)にする。
 */
export const DIARY_ENTRY_KEY_PREFIX = 'diary-entry:';

/** 指定したエントリidから、AsyncStorage上のキーを組み立てる */
export function buildDiaryEntryKey(id: string): string {
  return `${DIARY_ENTRY_KEY_PREFIX}${id}`;
}

/** 日記1件分のデータ構造。一覧表示とエクスポート機能の両方で使うため、ここに集約する。 */
export type DiaryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

/**
 * 値が`DiaryEntry`として妥当な形かどうかを判定する型ガード。AsyncStorageから読み込んだJSONは
 * 実行時に型が保証されないため、`as DiaryEntry`で決め打ちせずここで検証する。
 * `utils/diary-import.ts`のインポート時スキーマ検証でも再利用するためexportする。
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
 * レガシーキー(`DIARY_ENTRIES_STORAGE_KEY`)に全件配列で保存された日記データが残っていれば、
 * エントリ単位の個別キーへ移行する。復号・パースに失敗した場合は例外を投げてレガシーキーは
 * 削除しない(中途半端な状態でデータを失わないよう、呼び出し元の`getAllDiaryEntries`に委ねる)。
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
 * 保存済みの日記データを全件削除する(Google Play/Apple双方で求められるユーザーによる
 * データ削除手段への対応)。暗号鍵や他の設定値に影響しないよう、日記データのキー
 * (エントリ単位の個別キー、および念のためレガシーキー)のみを対象にする。
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
 * 保存済みの日記データを全件取得し、必要であれば復号して返す。一覧表示とエクスポート機能の
 * 両方が利用する共通ロジック。AsyncStorage.getAllKeys()の順序は保証されないため、
 * `createdAt`の降順(新しい順、UI側は先頭が最新という前提)に並べ替える。
 * ストレージが空・壊れている・復号失敗のいずれの場合も例外を投げず空配列を返す。
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
        // 1件の破損が全件読み込み不能に波及しないよう、このエントリだけをスキップする
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
 * idを指定して日記エントリ1件だけを取得する。編集画面が、全件取得の`getAllDiaryEntries`を
 * 使わずO(1)で対象の1件を取得するために使う。見つからない・復号失敗時はnullを返す。
 */
export async function getDiaryEntryById(id: string): Promise<DiaryEntry | null> {
  try {
    const stored = await AsyncStorage.getItem(buildDiaryEntryKey(id));
    if (!stored) {
      return null;
    }

    let parsed: unknown;
    if (isEncryptedPayload(stored)) {
      const key = await getOrCreateEncryptionKey();
      parsed = JSON.parse(decryptText(stored, key));
    } else {
      // 暗号化対応前に保存された平文JSON(後方互換)
      parsed = JSON.parse(stored);
    }
    return isDiaryEntry(parsed) ? parsed : null;
  } catch {
    return null;
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
