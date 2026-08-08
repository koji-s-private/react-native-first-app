import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * オンボーディング(初回起動時の使い方説明)を表示済みかどうかをAsyncStorageに保存する際のキー。
 * `app/_layout.tsx`(表示要否の判定)とこのファイル(読み書き)の両方で同じキーを参照する。
 */
export const ONBOARDING_COMPLETED_STORAGE_KEY = 'onboarding-completed';

/**
 * オンボーディングを表示済み(最後まで進めた、またはスキップした)かどうかを取得する。
 * AsyncStorageの読み込みに失敗した場合は、誤ってオンボーディングの表示自体をブロックしないよう
 * 「未表示(false)」として扱う(表示されても再度閉じれば良いだけで、表示されない方が問題が大きいため)。
 */
export async function hasCompletedOnboarding(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

/**
 * オンボーディングを表示済みとしてAsyncStorageに記録する。
 * これにより2回目以降の起動ではオンボーディングが表示されなくなる。
 */
export async function markOnboardingCompleted(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'true');
}
