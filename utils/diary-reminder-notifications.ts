import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * 通知の許可状態(expo-notificationsの`PermissionStatus`をアプリ内で使う3値に単純化したもの)。
 * - 'granted': 許可済み。通知をスケジュールできる
 * - 'denied': 拒否済み。OSの設定画面から手動で許可し直す必要がある
 * - 'undetermined': まだユーザーに確認していない
 */
export type ReminderPermissionStatus = 'granted' | 'denied' | 'undetermined';

// 日記リマインダー通知に使う識別子。常に同じIDでスケジュールし直すことで、
// 時刻変更時に古い通知が二重に残ってしまうのを防ぐ
const REMINDER_NOTIFICATION_IDENTIFIER = 'diary-daily-reminder';

// Android(8以降)は通知チャンネルの登録が必要なため、リマインダー専用のチャンネルを用意する
const ANDROID_REMINDER_CHANNEL_ID = 'diary-reminder';

// アプリがフォアグラウンドで起動中に通知を受け取った場合も、バナー表示で気づけるようにする
// (未設定の場合、フォアグラウンド中は通知が表示されない仕様のため)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * 現在の通知許可状態を、OSの確認ダイアログを表示せずに取得する。
 * 設定画面を開くたびの状態表示(フォールバック案内の要否判定)に使う。
 */
export async function getReminderPermissionStatusAsync(): Promise<ReminderPermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

/**
 * 通知の許可をリクエストする。未確認の場合のみOS標準の確認ダイアログが表示され、
 * 一度「拒否」された後は、OSによってはダイアログ自体が再表示されず即座に'denied'が返る
 * (その場合は端末のOS設定から手動で許可してもらうしかない)。
 */
export async function requestReminderPermissionAsync(): Promise<ReminderPermissionStatus> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status;
}

/**
 * 毎日指定した時刻(端末のローカル時刻)に日記のリマインダー通知を送るようスケジュールする。
 * サーバーや外部のPush通知サービスは一切使わず、端末内のローカル通知スケジューリングのみで完結する。
 * 既に登録済みの場合は一度キャンセルしてから登録し直すため、重複登録は発生しない。
 */
export async function scheduleDailyReminderAsync(hour: number, minute: number): Promise<void> {
  if (Platform.OS === 'android') {
    // Androidは通知チャンネル未登録だと通知が表示されないため、スケジュール前に用意しておく
    await Notifications.setNotificationChannelAsync(ANDROID_REMINDER_CHANNEL_ID, {
      name: '日記リマインダー',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  await cancelDailyReminderAsync();
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_NOTIFICATION_IDENTIFIER,
    content: {
      title: '日記を書く時間です',
      body: '今日あったことを日記に記録しましょう。',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
      ...(Platform.OS === 'android' ? { channelId: ANDROID_REMINDER_CHANNEL_ID } : {}),
    },
  });
}

/**
 * スケジュール済みの日記リマインダー通知をキャンセルする。
 * 未登録の状態で呼んでも例外にはならない(何もしないのと同じ結果になる)。
 */
export async function cancelDailyReminderAsync(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_NOTIFICATION_IDENTIFIER);
}
