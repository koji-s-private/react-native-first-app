import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import {
  authenticateForAppLockAsync,
  isAppLockSupportedAsync,
} from '@/utils/app-lock-authentication';

// jest-expoが自動生成するexpo-local-authenticationのモックは、Web版のスタブ実装
// (node_modules/expo-local-authentication/src/ExpoLocalAuthentication.web.ts。常に固定値を返し、
// authenticateAsyncはUnavailabilityErrorを投げる)をそのまま使ってしまい、ハードウェア有無・
// 登録状況・認証成功/失敗のパターンを自由に検証できない。tests/README.mdの
// expo-crypto/expo-notificationsと同じ方針で、このファイルで検証したい各APIを
// 明示的に`jest.fn()`で差し替える。
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
  authenticateAsync: jest.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

const mockedLocalAuthentication = LocalAuthentication as unknown as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  getEnrolledLevelAsync: jest.Mock;
  authenticateAsync: jest.Mock;
};

describe('utils/app-lock-authentication', () => {
  const originalPlatformOS = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = originalPlatformOS;
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
  });

  describe('isAppLockSupportedAsync', () => {
    it('returns false without querying the native module on web (異常系: Web版は常に非対応)', async () => {
      Platform.OS = 'web';

      await expect(isAppLockSupportedAsync()).resolves.toBe(false);

      expect(mockedLocalAuthentication.hasHardwareAsync).not.toHaveBeenCalled();
    });

    it('returns false when the device has no biometric hardware (異常系: ハードウェア無し)', async () => {
      Platform.OS = 'ios';
      mockedLocalAuthentication.hasHardwareAsync.mockResolvedValue(false);

      await expect(isAppLockSupportedAsync()).resolves.toBe(false);

      expect(mockedLocalAuthentication.isEnrolledAsync).not.toHaveBeenCalled();
      expect(mockedLocalAuthentication.getEnrolledLevelAsync).not.toHaveBeenCalled();
    });

    it('returns true when biometrics are enrolled (正常系: 生体認証登録済み)', async () => {
      Platform.OS = 'ios';
      mockedLocalAuthentication.hasHardwareAsync.mockResolvedValue(true);
      mockedLocalAuthentication.isEnrolledAsync.mockResolvedValue(true);

      await expect(isAppLockSupportedAsync()).resolves.toBe(true);

      // 生体認証が登録済みと分かった時点で確定するため、getEnrolledLevelAsyncは呼ばれない
      expect(mockedLocalAuthentication.getEnrolledLevelAsync).not.toHaveBeenCalled();
    });

    it('returns true when biometrics are not enrolled but the OS passcode is set (正常系: パスコードのみ登録済み)', async () => {
      Platform.OS = 'android';
      mockedLocalAuthentication.hasHardwareAsync.mockResolvedValue(true);
      mockedLocalAuthentication.isEnrolledAsync.mockResolvedValue(false);
      mockedLocalAuthentication.getEnrolledLevelAsync.mockResolvedValue(
        LocalAuthentication.SecurityLevel.SECRET,
      );

      await expect(isAppLockSupportedAsync()).resolves.toBe(true);
    });

    it('returns false when hardware exists but nothing is enrolled (境界値: SecurityLevel.NONE)', async () => {
      Platform.OS = 'ios';
      mockedLocalAuthentication.hasHardwareAsync.mockResolvedValue(true);
      mockedLocalAuthentication.isEnrolledAsync.mockResolvedValue(false);
      mockedLocalAuthentication.getEnrolledLevelAsync.mockResolvedValue(
        LocalAuthentication.SecurityLevel.NONE,
      );

      await expect(isAppLockSupportedAsync()).resolves.toBe(false);
    });

    it('propagates the error when hasHardwareAsync rejects (異常系: ネイティブ呼び出し失敗)', async () => {
      Platform.OS = 'ios';
      mockedLocalAuthentication.hasHardwareAsync.mockRejectedValue(new Error('native error'));

      await expect(isAppLockSupportedAsync()).rejects.toThrow('native error');
    });

    it('propagates the error when getEnrolledLevelAsync rejects (異常系: 登録レベル取得失敗)', async () => {
      Platform.OS = 'ios';
      mockedLocalAuthentication.hasHardwareAsync.mockResolvedValue(true);
      mockedLocalAuthentication.isEnrolledAsync.mockResolvedValue(false);
      mockedLocalAuthentication.getEnrolledLevelAsync.mockRejectedValue(
        new Error('enrolled level error'),
      );

      await expect(isAppLockSupportedAsync()).rejects.toThrow('enrolled level error');
    });
  });

  describe('authenticateForAppLockAsync', () => {
    it('returns true and allows falling back to the OS passcode when authentication succeeds (正常系: 認証成功)', async () => {
      mockedLocalAuthentication.authenticateAsync.mockResolvedValue({ success: true });

      await expect(authenticateForAppLockAsync()).resolves.toBe(true);

      expect(mockedLocalAuthentication.authenticateAsync).toHaveBeenCalledWith({
        promptMessage: 'アプリのロックを解除',
        cancelLabel: 'キャンセル',
        fallbackLabel: 'パスコードを使う',
        disableDeviceFallback: false,
      });
    });

    it('returns false when authentication fails or is cancelled (異常系: 認証失敗)', async () => {
      mockedLocalAuthentication.authenticateAsync.mockResolvedValue({
        success: false,
        error: 'user_cancel',
      });

      await expect(authenticateForAppLockAsync()).resolves.toBe(false);
    });

    it('propagates the error when the underlying call rejects (異常系: ネイティブ呼び出し失敗)', async () => {
      mockedLocalAuthentication.authenticateAsync.mockRejectedValue(new Error('native error'));

      await expect(authenticateForAppLockAsync()).rejects.toThrow('native error');
    });
  });
});
