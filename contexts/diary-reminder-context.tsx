import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import {
  cancelDailyReminderAsync,
  getReminderPermissionStatusAsync,
  requestReminderPermissionAsync,
  scheduleDailyReminderAsync,
  type ReminderPermissionStatus,
} from '@/utils/diary-reminder-notifications';

/** AsyncStorageに保存する日記リマインダー設定の形。時刻は端末のローカル時刻の時・分で保持する */
type DiaryReminderSettings = {
  enabled: boolean;
  hour: number;
  minute: number;
};

/**
 * 保存済みの日記リマインダー設定をAsyncStorageに保存する際のキー。
 * `contexts/diary-reminder-context.tsx`(読み書き)からのみ参照する想定。
 */
export const DIARY_REMINDER_STORAGE_KEY = 'diary-reminder-settings';

// 特に指定がなければ「夜21時に今日を振り返る」を想定した既定時刻にする
const DEFAULT_REMINDER_SETTINGS: DiaryReminderSettings = { enabled: false, hour: 21, minute: 0 };

function isDiaryReminderSettings(value: unknown): value is DiaryReminderSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.hour === 'number' &&
    candidate.hour >= 0 &&
    candidate.hour <= 23 &&
    typeof candidate.minute === 'number' &&
    candidate.minute >= 0 &&
    candidate.minute <= 59
  );
}

type DiaryReminderContextValue = {
  /** 毎日のリマインダー通知がONになっているか */
  enabled: boolean;
  /** リマインダーを送る時刻(時。0-23) */
  hour: number;
  /** リマインダーを送る時刻(分。0-59) */
  minute: number;
  /** 現在の通知許可状態。'denied'の場合はONにしてもOSレベルで通知が届かない */
  permissionStatus: ReminderPermissionStatus;
  /**
   * リマインダーのON/OFFを切り替える。ONにする際、未確認(undetermined)であれば
   * 通知許可のリクエストを行い、許可された場合のみ実際に通知をスケジュールする。
   * 拒否された場合はenabled自体はfalseのままになる。
   */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** リマインダーの時刻を変更する。ON状態であれば新しい時刻で再スケジュールする */
  setTime: (hour: number, minute: number) => void;
};

const DiaryReminderContext = createContext<DiaryReminderContextValue | null>(null);

export function DiaryReminderProvider({ children }: PropsWithChildren) {
  const [settings, setSettings] = useState<DiaryReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [permissionStatus, setPermissionStatus] =
    useState<ReminderPermissionStatus>('undetermined');

  // 起動時にAsyncStorageから前回の設定と、現在の通知許可状態(OSの設定画面で後から
  // 変更された可能性もあるため毎回取得し直す)を読み込む
  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(DIARY_REMINDER_STORAGE_KEY)
      .then((value) => {
        if (!isMounted || value === null) {
          return;
        }
        const parsed: unknown = JSON.parse(value);
        if (isDiaryReminderSettings(parsed)) {
          setSettings(parsed);
        }
      })
      .catch(() => {
        // 読み込みに失敗しても既定値(OFF)のまま動作を続ける
      });

    getReminderPermissionStatusAsync()
      .then((status) => {
        if (isMounted) {
          setPermissionStatus(status);
        }
      })
      .catch(() => {
        // 取得に失敗した場合は「未確認」のまま扱う
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const persist = useCallback((next: DiaryReminderSettings) => {
    // 保存の完了を待たずに即座に画面へ反映する(theme-preference-contextと同じ方針。
    // 保存に失敗しても次回起動時に設定がリセットされる程度で、致命的な不具合にはならない)
    setSettings(next);
    AsyncStorage.setItem(DIARY_REMINDER_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const setEnabled = useCallback(
    async (nextEnabled: boolean) => {
      if (!nextEnabled) {
        // OFFにする場合は許可状態に関わらず、スケジュール済みの通知を確実にキャンセルする
        persist({ ...settings, enabled: false });
        await cancelDailyReminderAsync();
        return;
      }

      // ONにする場合は、通知許可がまだ確定していなければリクエストする
      const currentStatus =
        permissionStatus === 'undetermined'
          ? await requestReminderPermissionAsync()
          : permissionStatus;
      setPermissionStatus(currentStatus);

      if (currentStatus !== 'granted') {
        // 拒否されている場合はONにできない(呼び出し側でフォールバック案内を表示する)
        persist({ ...settings, enabled: false });
        return;
      }

      persist({ ...settings, enabled: true });
      await scheduleDailyReminderAsync(settings.hour, settings.minute);
    },
    [permissionStatus, persist, settings],
  );

  const setTime = useCallback(
    (hour: number, minute: number) => {
      const next = { ...settings, hour, minute };
      persist(next);
      if (next.enabled && permissionStatus === 'granted') {
        scheduleDailyReminderAsync(hour, minute).catch(() => {});
      }
    },
    [permissionStatus, persist, settings],
  );

  const value = useMemo<DiaryReminderContextValue>(
    () => ({
      enabled: settings.enabled,
      hour: settings.hour,
      minute: settings.minute,
      permissionStatus,
      setEnabled,
      setTime,
    }),
    [settings, permissionStatus, setEnabled, setTime],
  );

  return <DiaryReminderContext.Provider value={value}>{children}</DiaryReminderContext.Provider>;
}

/**
 * 日記リマインダー設定を取得・変更するフック。
 * `DiaryReminderProvider`配下でない場合(単体テストなど)は、通知を一切スケジュールしない
 * 読み取り専用相当のフォールバック値を返す。
 */
export function useDiaryReminder(): DiaryReminderContextValue {
  const context = useContext(DiaryReminderContext);

  if (context) {
    return context;
  }

  return {
    enabled: DEFAULT_REMINDER_SETTINGS.enabled,
    hour: DEFAULT_REMINDER_SETTINGS.hour,
    minute: DEFAULT_REMINDER_SETTINGS.minute,
    permissionStatus: 'undetermined',
    setEnabled: async () => {},
    setTime: () => {},
  };
}
