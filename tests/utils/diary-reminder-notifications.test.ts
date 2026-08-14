import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  cancelDailyReminderAsync,
  getReminderPermissionStatusAsync,
  requestReminderPermissionAsync,
  scheduleDailyReminderAsync,
} from '@/utils/diary-reminder-notifications';

// jest-expoが自動生成するexpo-notificationsのモックは、Expo Go上のPush通知サポート終了に伴う
// 警告ログを出したり(node_modules/expo-notifications/src/warnOfExpoGoPushUsage.ts)、
// 実際にスケジュール・許可状態を検証できるスタブを持たないため、このファイルで検証したい各APIを
// 明示的に`jest.fn()`で差し替える。expo-crypto/expo-secure-storeと同じ方針
// (tests/README.md「expo-crypto / expo-secure-storeのモックについて」参照)。
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('scheduled-id')),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve()),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  SchedulableTriggerInputTypes: { DAILY: 'daily' },
  AndroidImportance: { DEFAULT: 3 },
}));

const mockedNotifications = Notifications as unknown as {
  setNotificationHandler: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
};

const REMINDER_NOTIFICATION_IDENTIFIER = 'diary-daily-reminder';
const ANDROID_REMINDER_CHANNEL_ID = 'diary-reminder';

// `Notifications.setNotificationHandler`はモジュールのimport時(このファイル先頭のimport文評価時)に
// 一度だけ呼ばれる。以降の`beforeEach`で`jest.clearAllMocks()`を呼ぶと呼び出し履歴が消えてしまうため、
// どのテストが実行されるより前(モジュール読み込み直後)に渡された設定内容を退避しておく。
const notificationHandlerConfigAtImportTime =
  mockedNotifications.setNotificationHandler.mock.calls[0]?.[0];

describe('utils/diary-reminder-notifications', () => {
  const originalPlatformOS = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = originalPlatformOS;
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
  });

  describe('モジュール読み込み時の通知ハンドラ登録', () => {
    it('registers a foreground notification handler that shows a banner/list without sound or badge (回帰確認)', async () => {
      expect(notificationHandlerConfigAtImportTime).toBeDefined();
      const { handleNotification } = notificationHandlerConfigAtImportTime;
      await expect(handleNotification()).resolves.toEqual({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
    });
  });

  describe('getReminderPermissionStatusAsync', () => {
    it('returns "granted" when the OS reports the permission as granted (正常系)', async () => {
      mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await expect(getReminderPermissionStatusAsync()).resolves.toBe('granted');
    });

    it('returns "denied" when the OS reports the permission as denied (正常系)', async () => {
      mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'denied' });

      await expect(getReminderPermissionStatusAsync()).resolves.toBe('denied');
    });

    it('returns "undetermined" when the permission has not been decided yet (境界値: 未確認)', async () => {
      mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });

      await expect(getReminderPermissionStatusAsync()).resolves.toBe('undetermined');
    });

    it('does not show an OS confirmation dialog (uses getPermissionsAsync, not requestPermissionsAsync) (回帰確認)', async () => {
      mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await getReminderPermissionStatusAsync();

      expect(mockedNotifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(mockedNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('propagates the error when the underlying call rejects (異常系)', async () => {
      mockedNotifications.getPermissionsAsync.mockRejectedValue(new Error('native error'));

      await expect(getReminderPermissionStatusAsync()).rejects.toThrow('native error');
    });
  });

  describe('requestReminderPermissionAsync', () => {
    it('returns "granted" when the user allows the OS confirmation dialog (正常系)', async () => {
      mockedNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await expect(requestReminderPermissionAsync()).resolves.toBe('granted');
      expect(mockedNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('returns "denied" when the user rejects the OS confirmation dialog (異常系)', async () => {
      mockedNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

      await expect(requestReminderPermissionAsync()).resolves.toBe('denied');
    });

    it('propagates the error when the underlying call rejects (異常系)', async () => {
      mockedNotifications.requestPermissionsAsync.mockRejectedValue(new Error('native error'));

      await expect(requestReminderPermissionAsync()).rejects.toThrow('native error');
    });
  });

  describe('scheduleDailyReminderAsync', () => {
    it('cancels any existing schedule then registers a new DAILY trigger with the given hour/minute on iOS (正常系)', async () => {
      Platform.OS = 'ios';

      await scheduleDailyReminderAsync(21, 0);

      expect(mockedNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
        REMINDER_NOTIFICATION_IDENTIFIER,
      );
      expect(mockedNotifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: REMINDER_NOTIFICATION_IDENTIFIER,
        content: {
          title: '日記を書く時間です',
          body: '今日あったことを日記に記録しましょう。',
        },
        trigger: {
          type: 'daily',
          hour: 21,
          minute: 0,
        },
      });
      // iOSでは通知チャンネルの概念自体が存在しないため登録処理を呼ばない
      expect(mockedNotifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    });

    it('cancels the existing schedule before scheduling the new one (順序の確認)', async () => {
      Platform.OS = 'ios';
      const callOrder: string[] = [];
      mockedNotifications.cancelScheduledNotificationAsync.mockImplementation(() => {
        callOrder.push('cancel');
        return Promise.resolve();
      });
      mockedNotifications.scheduleNotificationAsync.mockImplementation(() => {
        callOrder.push('schedule');
        return Promise.resolve('id');
      });

      await scheduleDailyReminderAsync(9, 30);

      expect(callOrder).toEqual(['cancel', 'schedule']);
    });

    it('registers the Android notification channel before scheduling and includes channelId in the trigger on Android (正常系: Android)', async () => {
      Platform.OS = 'android';

      await scheduleDailyReminderAsync(7, 45);

      expect(mockedNotifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        ANDROID_REMINDER_CHANNEL_ID,
        {
          name: '日記リマインダー',
          importance: 3,
        },
      );
      expect(mockedNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: {
            type: 'daily',
            hour: 7,
            minute: 45,
            channelId: ANDROID_REMINDER_CHANNEL_ID,
          },
        }),
      );
    });

    it('accepts the boundary time 0:00 (境界値: 最小値)', async () => {
      Platform.OS = 'ios';

      await scheduleDailyReminderAsync(0, 0);

      expect(mockedNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: { type: 'daily', hour: 0, minute: 0 } }),
      );
    });

    it('accepts the boundary time 23:59 (境界値: 最大値)', async () => {
      Platform.OS = 'ios';

      await scheduleDailyReminderAsync(23, 59);

      expect(mockedNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: { type: 'daily', hour: 23, minute: 59 } }),
      );
    });

    it('propagates the error without scheduling when registering the Android channel fails (異常系: チャンネル登録失敗)', async () => {
      Platform.OS = 'android';
      mockedNotifications.setNotificationChannelAsync.mockRejectedValue(new Error('channel error'));

      await expect(scheduleDailyReminderAsync(21, 0)).rejects.toThrow('channel error');
      expect(mockedNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('propagates the error when scheduleNotificationAsync itself fails (異常系: スケジュール登録失敗)', async () => {
      Platform.OS = 'ios';
      mockedNotifications.scheduleNotificationAsync.mockRejectedValue(new Error('schedule error'));

      await expect(scheduleDailyReminderAsync(21, 0)).rejects.toThrow('schedule error');
    });
  });

  describe('cancelDailyReminderAsync', () => {
    it('cancels the reminder notification using the fixed identifier (正常系)', async () => {
      await cancelDailyReminderAsync();

      expect(mockedNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
        REMINDER_NOTIFICATION_IDENTIFIER,
      );
      expect(mockedNotifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    });

    it('does not throw even when nothing was scheduled yet (境界値: 未登録状態でのキャンセル)', async () => {
      mockedNotifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined);

      await expect(cancelDailyReminderAsync()).resolves.toBeUndefined();
    });

    it('propagates the error when the underlying call rejects (異常系)', async () => {
      mockedNotifications.cancelScheduledNotificationAsync.mockRejectedValue(
        new Error('cancel error'),
      );

      await expect(cancelDailyReminderAsync()).rejects.toThrow('cancel error');
    });
  });
});
