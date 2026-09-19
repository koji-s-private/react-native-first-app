import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

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
  /** 保存済み設定の復元と通知許可状態の取得の両方が終わったか(失敗して既定値のまま確定した場合も含む) */
  isLoaded: boolean;
  /**
   * リマインダーのON/OFFを切り替える。ONにする際、未確認(undetermined)であれば
   * 通知許可のリクエストを行い、許可された場合のみ実際に通知をスケジュールする。
   * 拒否された場合はenabled自体はfalseのままになる。
   * 許可済みでも通知のスケジュール登録自体に失敗した場合は、enabledをfalseへ戻したうえで
   * 返り値のPromiseがreject する(呼び出し元でユーザーへのエラー案内に利用する想定)。
   */
  setEnabled: (enabled: boolean) => Promise<void>;
  /**
   * リマインダーの時刻を変更する。ON状態であれば新しい時刻で再スケジュールする。
   * 許可済みでも通知のスケジュール登録自体に失敗した場合は、setEnabledと同様にenabledを
   * falseへ戻したうえで、返り値のPromiseがreject する(呼び出し元でユーザーへのエラー案内に利用する想定)。
   */
  setTime: (hour: number, minute: number) => Promise<void>;
};

const DiaryReminderContext = createContext<DiaryReminderContextValue | null>(null);

export function DiaryReminderProvider({ children }: PropsWithChildren) {
  const [settings, setSettings] = useState<DiaryReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [permissionStatus, setPermissionStatus] =
    useState<ReminderPermissionStatus>('undetermined');
  const [isLoaded, setIsLoaded] = useState(false);

  const persist = useCallback((next: DiaryReminderSettings) => {
    // 保存の完了を待たずに即座に画面へ反映する(theme-preference-contextと同じ方針。
    // 保存に失敗しても次回起動時に設定がリセットされる程度で、致命的な不具合にはならない)
    setSettings(next);
    AsyncStorage.setItem(DIARY_REMINDER_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  // AppStateのリスナーや起動時の初期化処理からは常に最新のsettings/permissionStatusを
  // 参照したいが、リスナー自体を都度re-subscribeするのは避けたいため、依存配列に含めず
  // refで最新値を追う
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const permissionStatusRef = useRef(permissionStatus);
  permissionStatusRef.current = permissionStatus;

  // 起動時にAsyncStorageから前回の設定と、現在の通知許可状態(OSの設定画面で後から
  // 変更された可能性もあるため毎回取得し直す)を読み込む。この2つの読み込みは並行して走り、
  // どちらが先に解決するかは保証されない。「許可がdeniedなのにenabled=trueが復元される」状態を
  // どちらの解決順でも補正できるよう、Reactの再描画を挟まないローカル変数で双方の結果を追跡する
  useEffect(() => {
    let isMounted = true;
    let loadedSettings: DiaryReminderSettings | null = null;
    let loadedPermissionStatus: ReminderPermissionStatus | null = null;
    let pendingLoads = 2;

    // 復元と許可状態取得の両方が終わった時点でのみ読み込み完了にする(初期値のまま
    // 描画される間、UI側が「OFF」と誤って案内しないため)
    const markLoadSettled = () => {
      pendingLoads -= 1;
      if (isMounted && pendingLoads === 0) {
        setIsLoaded(true);
      }
    };

    const correctIfPermissionDenied = (): boolean => {
      if (
        loadedSettings === null ||
        loadedPermissionStatus !== 'denied' ||
        !loadedSettings.enabled
      ) {
        return false;
      }
      // アプリを完全終了した状態でOS設定から通知許可を取り消された場合、フォアグラウンド
      // 復帰時の整合ロジック(下記useEffect)は`granted`からの変化しか検知できないため、
      // 起動時の復元時にもenabledを実態に合わせて補正する
      persist({ ...loadedSettings, enabled: false });
      cancelDailyReminderAsync().catch(() => {});
      return true;
    };

    AsyncStorage.getItem(DIARY_REMINDER_STORAGE_KEY)
      .then((value) => {
        if (!isMounted || value === null) {
          return;
        }
        const parsed: unknown = JSON.parse(value);
        if (!isDiaryReminderSettings(parsed)) {
          return;
        }
        loadedSettings = parsed;
        if (!correctIfPermissionDenied()) {
          setSettings(parsed);
        }
      })
      .catch(() => {
        // 読み込みに失敗しても既定値(OFF)のまま動作を続ける
      })
      .finally(markLoadSettled);

    getReminderPermissionStatusAsync()
      .then((status) => {
        if (!isMounted) {
          return;
        }
        setPermissionStatus(status);
        loadedPermissionStatus = status;
        correctIfPermissionDenied();
      })
      .catch(() => {
        // 取得に失敗した場合は「未確認」のまま扱う
      })
      .finally(markLoadSettled);

    return () => {
      isMounted = false;
    };
  }, [persist]);

  // OSの設定画面で通知許可が取り消された場合、アプリ再起動まで気づけないと「ONに見えるのに
  // 通知が届かない」状態が放置されてしまう。フォアグラウンド復帰時(active)に限って許可状態を
  // 再取得することで、アプリを閉じずに設定画面へ切り替えただけのケースにも対応する
  // (バックグラウンド遷移時などは問い合わせ不要なので何もしない)
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState !== 'active') {
        return;
      }

      getReminderPermissionStatusAsync()
        .then((status) => {
          const previousStatus = permissionStatusRef.current;
          setPermissionStatus(status);

          if (previousStatus === 'granted' && status === 'denied') {
            // 許可が取り消されたことを検知した場合のみ、スイッチの見た目と実際のスケジュール
            // 登録状況を一致させるためenabledをOFFへ戻す(denied→granted等の変化では
            // ユーザーの明示的な操作なしにenabledを自動でONへは戻さない)
            persist({ ...settingsRef.current, enabled: false });
            cancelDailyReminderAsync().catch(() => {});
          }
        })
        .catch(() => {
          // 取得に失敗した場合は現在の許可状態を維持する
        });
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, [persist]);

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
      try {
        await scheduleDailyReminderAsync(settings.hour, settings.minute);
      } catch (error) {
        // スケジュール登録に失敗した場合、enabled=trueのまま確定させると「ONに見えるが
        // 実際には通知が届かない」状態を検知できなくなる。setTimeとは異なり、ONへの
        // 切り替え自体が失敗したことを示すためenabledをfalseへ戻したうえで、
        // 呼び出し元(app/(tabs)/settings.tsx)がユーザーへエラーを案内できるよう
        // 例外を伝播させる
        persist({ ...settings, enabled: false });
        throw error;
      }
    },
    [permissionStatus, persist, settings],
  );

  // TimeStepperの連続操作でsetTimeが短時間に複数回呼ばれた場合、scheduleDailyReminderAsync同士が
  // 並行して走ると完了順序が呼び出し順と一致しないことがあり、画面表示上の時刻と実際にOSへ
  // 登録される時刻がずれてしまう。enqueueDiaryWrite(app/(tabs)/index.tsx)と同様に
  // Promiseチェーンで直列化し、呼び出し順=実行順を保証する
  const scheduleQueueRef = useRef<Promise<void>>(Promise.resolve());

  const setTime = useCallback(
    (hour: number, minute: number): Promise<void> => {
      const next = { ...settings, hour, minute };
      persist(next);
      if (!(next.enabled && permissionStatus === 'granted')) {
        // OFFまたは未許可の場合はそもそもスケジュールを試みないため、何もせず成功扱いにする
        return Promise.resolve();
      }

      // 直列化キュー(scheduleQueueRef.current)自体は、このタスクが失敗しても後続の
      // 再スケジュールをブロックしてはいけない(TimeStepper連続操作対応)ため、キュー継続用の
      // catchと、呼び出し元へ失敗を伝播させるためのcatchを分離する
      const task = scheduleQueueRef.current.then(() => scheduleDailyReminderAsync(hour, minute));
      scheduleQueueRef.current = task.catch(() => {});

      return task.catch((error) => {
        // setEnabledと同様、スケジュール登録に失敗した場合は「ONに見えるが実際には通知が
        // 届かない」状態を検知できるよう、enabledをfalseへ戻したうえで呼び出し元へ伝播させる
        // (hour/minuteは新しい値のまま維持する)
        persist({ ...settingsRef.current, enabled: false });
        throw error;
      });
    },
    [permissionStatus, persist, settings],
  );

  const value = useMemo<DiaryReminderContextValue>(
    () => ({
      enabled: settings.enabled,
      hour: settings.hour,
      minute: settings.minute,
      permissionStatus,
      isLoaded,
      setEnabled,
      setTime,
    }),
    [settings, permissionStatus, isLoaded, setEnabled, setTime],
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
    isLoaded: true,
    setEnabled: async () => {},
    setTime: async () => {},
  };
}
