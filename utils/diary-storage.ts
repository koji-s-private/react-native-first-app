import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 日記データをAsyncStorageに保存する際のキー。
 * `app/(tabs)/index.tsx`(保存・読み込み)とこのファイル(全件削除)の両方で
 * 同じキーを参照する必要があるため、一箇所にまとめてexportする。
 */
export const DIARY_ENTRIES_STORAGE_KEY = 'diary-entries';

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
