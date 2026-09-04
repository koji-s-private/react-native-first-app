import AsyncStorage from '@react-native-async-storage/async-storage';

/** オンボーディング(初回起動時の使い方説明)を表示済みかどうかを保存する際のキー。 */
export const ONBOARDING_COMPLETED_STORAGE_KEY = 'onboarding-completed';

/**
 * オンボーディングを表示済み(最後まで進めた、またはスキップした)かどうかを取得する。
 * 読み込みに失敗した場合は、表示自体をブロックしないよう「未表示(false)」として扱う。
 */
export async function hasCompletedOnboarding(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(ONBOARDING_COMPLETED_STORAGE_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

/** オンボーディングを表示済みとして記録する。 */
export async function markOnboardingCompleted(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_COMPLETED_STORAGE_KEY, 'true');
}
