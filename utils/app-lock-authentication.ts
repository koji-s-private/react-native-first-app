// アプリロック機能で使う、expo-local-authenticationの薄いラッパー。
// Web版はネイティブモジュールが存在せず`hasHardwareAsync`等は常に固定値を返し、
// authenticateAsyncは未実装で呼び出すとUnavailabilityErrorを投げるため、この機能自体を提供しない。
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

/**
 * この端末でアプリロック機能を利用できるかどうかを判定する。
 * 生体認証(顔・指紋)またはOS標準のパスコードのいずれかが端末に登録されている必要がある。
 */
export async function isAppLockSupportedAsync(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) {
    return false;
  }
  // isEnrolledAsyncは生体認証の登録有無のみ判定するため、パスコードのみ設定済みのケースを
  // 取りこぼさないようgetEnrolledLevelAsyncも合わせて確認する
  const isBiometricEnrolled = await LocalAuthentication.isEnrolledAsync();
  if (isBiometricEnrolled) {
    return true;
  }
  const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
  return enrolledLevel !== LocalAuthentication.SecurityLevel.NONE;
}

/**
 * 生体認証(またはOS標準パスコード)によるアプリロック解除を試みる。
 * 生体認証が失敗・利用不可の場合にパスコードへフォールバックできるよう`disableDeviceFallback: false`で呼ぶ。
 */
export async function authenticateForAppLockAsync(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'アプリのロックを解除',
    cancelLabel: 'キャンセル',
    fallbackLabel: 'パスコードを使う',
    disableDeviceFallback: false,
  });
  return result.success;
}
