// アプリロック機能(#155)で使う、expo-local-authenticationの薄いラッパー。
//
// Web版はexpo-local-authenticationのネイティブモジュールが存在せず、`hasHardwareAsync`等が
// 常に固定値(false/[]/NONE)を返す実装になっている(authenticateAsyncに至っては未実装のため
// 呼び出すとUnavailabilityErrorを投げる)。そのため、この機能自体をWebでは提供しない。
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
  // isEnrolledAsyncは生体認証の登録有無のみを見るため、生体認証は未登録でもOS標準パスコードは
  // 設定済み、というケースを取りこぼさないようgetEnrolledLevelAsyncも合わせて確認する
  // (disableDeviceFallback: falseで呼び出すauthenticateAsyncはパスコードにもフォールバックできるため)
  const isBiometricEnrolled = await LocalAuthentication.isEnrolledAsync();
  if (isBiometricEnrolled) {
    return true;
  }
  const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
  return enrolledLevel !== LocalAuthentication.SecurityLevel.NONE;
}

/**
 * 生体認証(またはOS標準パスコード)によるアプリロック解除を試みる。
 * 生体認証が利用できない・失敗した場合は、OS標準のパスコード入力へフォールバックできるよう
 * `disableDeviceFallback: false`で呼び出す。
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
