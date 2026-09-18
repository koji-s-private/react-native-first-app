// 保存前の日記下書き(自動保存)をAsyncStorageへ暗号化して読み書きするためのユーティリティ。
// 保存済みエントリ(utils/diary-storage.ts)と同じAES-256-GCM暗号化を通すことで、
// 未保存の下書きだけ平文で端末に残る事態を防ぐ。
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  decryptText,
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';

/** ホーム画面下部composerの下書きを自動保存するAsyncStorageキー */
export const DIARY_DRAFT_STORAGE_KEY = 'diary-draft';

/**
 * 日付指定の新規作成モーダルの下書きを自動保存するAsyncStorageキーの接頭辞。
 * 実際のキーはこの接頭辞+対象日付('YYYY-MM-DD')。
 */
export const DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX = 'diary-new-entry-draft-';

/**
 * 編集画面の下書きを自動保存するAsyncStorageキーの接頭辞。
 * 実際のキーはこの接頭辞+エントリID。
 */
export const DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX = 'diary-edit-draft-';

const DRAFT_STORAGE_KEY_PREFIXES = [
  DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX,
  DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX,
];

/**
 * 指定したキーが下書き系のAsyncStorageキー(完全一致または接頭辞一致)かどうかを判定する。
 * `clearAllDiaryEntries`が全件削除の対象キーを漏れなく拾うために使う。
 */
export function isDraftStorageKey(key: string): boolean {
  if (key === DIARY_DRAFT_STORAGE_KEY) {
    return true;
  }
  return DRAFT_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 下書き本文を暗号化してAsyncStorageへ保存する */
export async function saveDraftText(key: string, text: string): Promise<void> {
  const encryptionKey = await getOrCreateEncryptionKey();
  await AsyncStorage.setItem(key, encryptText(text, encryptionKey));
}

/**
 * 下書き本文を復元する。暗号化対応前に保存された平文の下書きもそのまま読み込める
 * (isEncryptedPayloadで判別する後方互換)。保存が無ければnullを返す。
 */
export async function loadDraftText(key: string): Promise<string | null> {
  const stored = await AsyncStorage.getItem(key);
  if (!stored) {
    return null;
  }
  if (!isEncryptedPayload(stored)) {
    return stored;
  }
  const encryptionKey = await getOrCreateEncryptionKey();
  return decryptText(stored, encryptionKey);
}
