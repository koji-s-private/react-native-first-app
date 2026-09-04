import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import {
  DIARY_REMINDER_STORAGE_KEY,
  DiaryReminderProvider,
  useDiaryReminder,
} from '@/contexts/diary-reminder-context';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える。
// `jest.setup.js`でも全体に適用済みだが、他のテストファイルと同様に明示しておく。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `contexts/diary-reminder-context.tsx`は内部で`utils/diary-reminder-notifications.ts`
// (expo-notificationsの薄いラッパー)を呼び出す。このテストではコンテキストの状態管理・
// 永続化ロジック自体を検証したいため、そのラッパーごとモック化し、許可状態やスケジュール
// 登録・キャンセルの呼び出しを直接検証できるようにする
// (tests/utils/diary-reminder-notifications.test.tsでラッパー自体は別途検証済み)。
jest.mock('@/utils/diary-reminder-notifications', () => ({
  getReminderPermissionStatusAsync: jest.fn(),
  requestReminderPermissionAsync: jest.fn(),
  scheduleDailyReminderAsync: jest.fn(() => Promise.resolve()),
  cancelDailyReminderAsync: jest.fn(() => Promise.resolve()),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedNotificationsUtil = require('@/utils/diary-reminder-notifications') as {
  getReminderPermissionStatusAsync: jest.Mock;
  requestReminderPermissionAsync: jest.Mock;
  scheduleDailyReminderAsync: jest.Mock;
  cancelDailyReminderAsync: jest.Mock;
};

const wrapper = ({ children }: PropsWithChildren) => (
  <DiaryReminderProvider>{children}</DiaryReminderProvider>
);

// `react-native`のJestプリセットが提供する`AppState.addEventListener`は既定で`jest.fn()`化
// されている(`{ remove: jest.fn() }`を返すだけ)ため、`change`イベント用に登録された
// リスナー関数を`mock.calls`から取り出し、テスト側から直接呼び出すことでフォアグラウンド
// 復帰(`'active'`)をシミュレートする。
function getAppStateChangeListener(): (nextAppState: string) => void {
  const addEventListenerMock = AppState.addEventListener as jest.Mock;
  const call = addEventListenerMock.mock.calls.find(([eventName]) => eventName === 'change');
  if (!call) {
    throw new Error('AppState.addEventListener("change", ...) が呼び出されていません');
  }
  return call[1];
}

describe('DiaryReminderProvider / useDiaryReminder', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    // 明示的にモックを指定しないテストでは「未確認」を既定の挙動にしておく
    mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('undetermined');
    mockedNotificationsUtil.requestReminderPermissionAsync.mockResolvedValue('undetermined');
    // 一部のテストが`mockRejectedValue`(永続的な上書き)で失敗をシミュレートするため、
    // `jest.clearAllMocks()`(呼び出し履歴のクリアのみで実装はクリアされない)だけでは
    // 後続テストに失敗が漏れてしまう。既定では成功させておく
    mockedNotificationsUtil.scheduleDailyReminderAsync.mockResolvedValue(undefined);
  });

  it('defaults to disabled, 21:00, and "undetermined" permission before AsyncStorage/OS state has resolved (初期値)', () => {
    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    expect(result.current.enabled).toBe(false);
    expect(result.current.hour).toBe(21);
    expect(result.current.minute).toBe(0);
    expect(result.current.permissionStatus).toBe('undetermined');
  });

  it('loads the current permission status from the OS on mount (正常系: 許可状態の初期取得)', async () => {
    mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.permissionStatus).toBe('granted');
  });

  it('loads a previously saved enabled/time setting from AsyncStorage on mount (正常系: 起動時の復元)', async () => {
    await AsyncStorage.setItem(
      DIARY_REMINDER_STORAGE_KEY,
      JSON.stringify({ enabled: true, hour: 8, minute: 30 }),
    );

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.hour).toBe(8);
    expect(result.current.minute).toBe(30);
  });

  it('ignores a stored value that is not a valid settings object and stays on the default (境界値: 不正な保存値)', async () => {
    await AsyncStorage.setItem(DIARY_REMINDER_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.hour).toBe(21);
    expect(result.current.minute).toBe(0);
  });

  it('ignores a stored hour/minute that is out of range (境界値: 範囲外の時刻)', async () => {
    await AsyncStorage.setItem(
      DIARY_REMINDER_STORAGE_KEY,
      JSON.stringify({ enabled: true, hour: 24, minute: 0 }),
    );

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    // 不正値のため既定値のまま(hour=24は無効)
    expect(result.current.hour).toBe(21);
  });

  it('falls back to the default without crashing when AsyncStorage.getItem rejects (異常系: 読み込み失敗)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(false);
  });

  it('keeps "undetermined" without crashing when getReminderPermissionStatusAsync rejects (異常系: 許可状態取得失敗)', async () => {
    mockedNotificationsUtil.getReminderPermissionStatusAsync.mockRejectedValue(
      new Error('permission query error'),
    );

    const { result } = renderHook(() => useDiaryReminder(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.permissionStatus).toBe('undetermined');
  });

  describe('setEnabled', () => {
    it('requests permission, persists enabled=true, and schedules the reminder when turned ON while undetermined and the user grants it (正常系: ON・未確認から許可)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('undetermined');
      mockedNotificationsUtil.requestReminderPermissionAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.setEnabled(true);
      });

      expect(mockedNotificationsUtil.requestReminderPermissionAsync).toHaveBeenCalledTimes(1);
      expect(result.current.enabled).toBe(true);
      expect(result.current.permissionStatus).toBe('granted');
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledWith(21, 0);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: true, hour: 21, minute: 0 }),
      );
    });

    it('does not schedule anything and keeps enabled=false when the permission is denied by the user (異常系: ON・未確認から拒否)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('undetermined');
      mockedNotificationsUtil.requestReminderPermissionAsync.mockResolvedValue('denied');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.setEnabled(true);
      });

      expect(result.current.enabled).toBe(false);
      expect(result.current.permissionStatus).toBe('denied');
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('schedules directly without re-requesting permission when the permission is already granted (正常系: 既に許可済み)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.setEnabled(true);
      });

      expect(mockedNotificationsUtil.requestReminderPermissionAsync).not.toHaveBeenCalled();
      expect(result.current.enabled).toBe(true);
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledWith(21, 0);
    });

    it('does not schedule and keeps enabled=false when the permission is already denied (異常系: 既に拒否済み)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('denied');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.setEnabled(true);
      });

      expect(mockedNotificationsUtil.requestReminderPermissionAsync).not.toHaveBeenCalled();
      expect(result.current.enabled).toBe(false);
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('persists enabled=false and cancels the schedule when turned OFF, regardless of permission status (正常系: OFF)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      jest.clearAllMocks();

      await act(async () => {
        await result.current.setEnabled(false);
      });

      expect(result.current.enabled).toBe(false);
      expect(mockedNotificationsUtil.cancelDailyReminderAsync).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: false, hour: 21, minute: 0 }),
      );
    });

    it('reverts enabled back to false and propagates the error from scheduleDailyReminderAsync when turning ON (異常系: ON時のスケジュール登録失敗)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      // `mockRejectedValueOnce`を使い、この呼び出しのみを失敗させる。`mockRejectedValue`
      // (永続的な上書き)を使うと`jest.clearAllMocks()`(mock.callsのクリアのみで実装は
      // クリアされない)では戻らず、以降の(このファイル内で後に実行される)テストにまで
      // 失敗が漏れてしまうため注意する
      mockedNotificationsUtil.scheduleDailyReminderAsync.mockRejectedValueOnce(
        new Error('schedule error'),
      );
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      // 状態更新(persist)はact()配下で反映させつつ、rejectする例外自体も捕捉して検証する
      let caughtError: unknown;
      await act(async () => {
        try {
          await result.current.setEnabled(true);
        } catch (error) {
          caughtError = error;
        }
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('schedule error');
      // スケジュール登録に失敗した場合、「ONに見えるが実際には通知が届かない」状態を避けるため
      // enabledはfalseへ戻される(呼び出し元は例外を捕捉してユーザーへ案内する想定)
      expect(result.current.enabled).toBe(false);
      expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: false, hour: 21, minute: 0 }),
      );
    });
  });

  describe('setTime', () => {
    it('persists the new time immediately (正常系: OFF状態での時刻変更は再スケジュールしない)', async () => {
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.setTime(7, 15);
      });

      expect(result.current.hour).toBe(7);
      expect(result.current.minute).toBe(15);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: false, hour: 7, minute: 15 }),
      );
      // OFFのままなので再スケジュールは発生しない
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('re-schedules the reminder with the new time when enabled and permission is granted (正常系: ON状態での時刻変更)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      jest.clearAllMocks();

      await act(async () => {
        result.current.setTime(6, 5);
        await Promise.resolve();
      });

      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledWith(6, 5);
    });

    it('does not re-schedule when enabled but permission is not granted (境界値: ON扱いだが権限未許可)', async () => {
      // AsyncStorageの復元によって、通知許可が無い状態でもenabled=trueが復元されうる
      // (例: 端末のOS設定で後から通知をオフにされたケース)ことを想定する
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('denied');
      await AsyncStorage.setItem(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: true, hour: 21, minute: 0 }),
      );
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.setTime(6, 5);
      });

      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('accepts the boundary time 0:00 (境界値: 最小値)', async () => {
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.setTime(0, 0);
      });

      expect(result.current.hour).toBe(0);
      expect(result.current.minute).toBe(0);
    });

    it('accepts the boundary time 23:59 (境界値: 最大値)', async () => {
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.setTime(23, 59);
      });

      expect(result.current.hour).toBe(23);
      expect(result.current.minute).toBe(59);
    });

    it('keeps the newly selected time reflected in the UI without crashing even when AsyncStorage.setItem rejects (異常系: 保存失敗)', async () => {
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.setTime(10, 20);
      });

      expect(result.current.hour).toBe(10);
      expect(result.current.minute).toBe(20);
    });

    it('reverts enabled back to false and propagates the error from scheduleDailyReminderAsync when changing the time, while keeping the newly selected time (異常系: 再スケジュール失敗時はenabledをfalseへ戻し例外を伝播する)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      // ONにする時点では成功させ、次のsetTime呼び出し時にのみ失敗させる
      await act(async () => {
        await result.current.setEnabled(true);
      });
      // `mockRejectedValueOnce`を使い、この呼び出しのみを失敗させる(setEnabledの
      // 異常系テストと同じ理由で`mockRejectedValue`の永続的な上書きは避ける)
      mockedNotificationsUtil.scheduleDailyReminderAsync.mockRejectedValueOnce(
        new Error('schedule error'),
      );

      // setTimeの呼び出し自体(persistによる新しい時刻の即時反映)を、それを待ち受ける
      // act()とは別の同期act()に分離する。1つのact()内でsetTime呼び出しからPromiseの
      // 解決まで一気にawaitすると、内部で追跡している最新値(settingsRef.current)が
      // 更新される前に失敗時のenabled巻き戻し処理が走ってしまい、テスト環境特有のタイミングで
      // 新しい時刻が失われてしまう(実機では通知APIの呼び出し自体がネイティブブリッジを
      // またぐため、この分離と同等の再レンダー機会が自然に生まれる)
      let promise: Promise<void> = Promise.resolve();
      act(() => {
        promise = result.current.setTime(6, 0);
      });

      let caughtError: unknown;
      await act(async () => {
        try {
          await promise;
        } catch (error) {
          caughtError = error;
        }
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('schedule error');
      // setEnabledと同様、「ONに見えるが実際には通知が届かない」状態を避けるため
      // enabledはfalseへ戻される(呼び出し元は例外を捕捉してユーザーへ案内する想定)。
      // 一方でhour/minuteは新しく選択した値のまま維持される
      expect(result.current.enabled).toBe(false);
      expect(result.current.hour).toBe(6);
      expect(result.current.minute).toBe(0);
      expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: false, hour: 6, minute: 0 }),
      );
    });

    it('serializes rapid consecutive setTime calls so scheduleDailyReminderAsync ultimately runs in call order and settles on the last call even when earlier calls are mocked to resolve later (正常系: 連続呼び出しの直列化でレースコンディションを防ぐ)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      jest.clearAllMocks();

      jest.useFakeTimers();
      try {
        // 呼び出し順(10:00→11:00→12:00)とは逆に、最初の呼び出しほど解決が遅くなるよう
        // モックする。直列化されていなければ最後に解決した呼び出しが最終状態を決めてしまい
        // 表示時刻(12:00)とズレるが、Promiseチェーンで直列化されていれば呼び出し順どおりに
        // 実行されるため、解決の遅さに関わらず呼び出し順=実行順が保たれる
        const delaysMs = [300, 200, 100];
        let callIndex = 0;
        mockedNotificationsUtil.scheduleDailyReminderAsync.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              const delay = delaysMs[callIndex++];
              setTimeout(resolve, delay);
            }),
        );

        act(() => {
          result.current.setTime(10, 0);
          result.current.setTime(11, 0);
          result.current.setTime(12, 0);
        });

        // 画面表示上はすぐに最後の呼び出しの時刻へ更新される
        expect(result.current.hour).toBe(12);
        expect(result.current.minute).toBe(0);
        // キューの先頭(Promise.resolve())へのthen()登録はマイクロタスクとして次のtickで
        // 実行されるため、1回分だけマイクロタスクを進めてから呼び出し回数を確認する
        await act(async () => {
          await Promise.resolve();
        });
        // 直列化により、最初のタスクが完了するまで2番目以降はまだ実行されない
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledTimes(1);
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenNthCalledWith(
          1,
          10,
          0,
        );

        await act(async () => {
          jest.advanceTimersByTime(300);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledTimes(2);
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenNthCalledWith(
          2,
          11,
          0,
        );

        await act(async () => {
          jest.advanceTimersByTime(200);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenCalledTimes(3);
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenNthCalledWith(
          3,
          12,
          0,
        );

        await act(async () => {
          jest.advanceTimersByTime(100);
          await Promise.resolve();
        });

        // 最終的に呼び出し順どおり(10→11→12)に実行され、最後の呼び出し引数で確定する
        expect(mockedNotificationsUtil.scheduleDailyReminderAsync.mock.calls).toEqual([
          [10, 0],
          [11, 0],
          [12, 0],
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps the schedule queue intact so a later setTime call still schedules even if an earlier call in the queue rejects (異常系: 途中の呼び出しが失敗してもキューは壊れない)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      jest.clearAllMocks();

      mockedNotificationsUtil.scheduleDailyReminderAsync.mockRejectedValueOnce(
        new Error('schedule error'),
      );
      mockedNotificationsUtil.scheduleDailyReminderAsync.mockResolvedValueOnce(undefined);

      // 1回目の失敗によって(呼び出し元のPromiseチェーンとは別に)enabledがfalseへ戻される
      // ため、間を空けて2回連続で呼び出すと2回目は再レンダー後のenabled=falseなクロージャを
      // 使ってしまいそもそもスケジュールされなくなる。TimeStepperの連続操作(前段の再レンダーが
      // 反映される前に次の呼び出しが来る状況)を再現するため、同じレンダリング内(enabled=trueの
      // クロージャ)で間を空けずに呼び出す。さらに、この2回の呼び出し自体は、それを待ち受ける
      // act()とは別の同期act()に分離する(理由は直前の異常系テストのコメントと同様。分離しないと
      // テスト環境特有のタイミングで1回目の失敗によるenabled巻き戻しが2回目の新しい時刻まで
      // 巻き戻してしまう)。1回目の返り値はrejectするため、未処理のrejectionにならないよう
      // 明示的に.catch()する
      let firstCall: Promise<void> = Promise.resolve();
      let secondCall: Promise<void> = Promise.resolve();
      act(() => {
        firstCall = result.current.setTime(9, 0);
        secondCall = result.current.setTime(13, 30);
      });

      await act(async () => {
        await Promise.all([firstCall.catch(() => {}), secondCall]);
      });

      // 1回目(9:00)は失敗したが、キュー自体は壊れず2回目(13:30)の再スケジュールも実行される
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenNthCalledWith(1, 9, 0);
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).toHaveBeenNthCalledWith(2, 13, 30);
      expect(result.current.hour).toBe(13);
      expect(result.current.minute).toBe(30);
    });
  });

  describe('AppStateによるフォアグラウンド復帰時の再取得', () => {
    it('refetches the permission status when the app returns to the foreground (正常系: active復帰時の再取得)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockedNotificationsUtil.getReminderPermissionStatusAsync).toHaveBeenCalledTimes(1);

      const handleAppStateChange = getAppStateChangeListener();
      await act(async () => {
        handleAppStateChange('active');
        await Promise.resolve();
      });

      expect(mockedNotificationsUtil.getReminderPermissionStatusAsync).toHaveBeenCalledTimes(2);
    });

    it('does not refetch when the app moves to the background (境界値: background遷移時は再取得しない)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      const handleAppStateChange = getAppStateChangeListener();
      await act(async () => {
        handleAppStateChange('background');
        await Promise.resolve();
      });

      expect(mockedNotificationsUtil.getReminderPermissionStatusAsync).toHaveBeenCalledTimes(1);
    });

    it('turns enabled off and cancels the schedule when the permission changes from granted to denied while resuming (異常系: granted→deniedでenabledをOFFに戻す)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      expect(result.current.enabled).toBe(true);
      // `jest.clearAllMocks()`は`AppState.addEventListener`の呼び出し履歴も消してしまう
      // (リスナー登録はマウント時の一度きりのため)ので、クリア前に取り出しておく
      const handleAppStateChange = getAppStateChangeListener();
      jest.clearAllMocks();
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('denied');

      await act(async () => {
        handleAppStateChange('active');
        await Promise.resolve();
      });

      expect(result.current.permissionStatus).toBe('denied');
      expect(result.current.enabled).toBe(false);
      expect(mockedNotificationsUtil.cancelDailyReminderAsync).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: false, hour: 21, minute: 0 }),
      );
    });

    it('keeps enabled unchanged when the permission stays granted while resuming (正常系: granted→grantedはenabled不変)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();
      jest.clearAllMocks();
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');

      await act(async () => {
        handleAppStateChange('active');
        await Promise.resolve();
      });

      expect(result.current.permissionStatus).toBe('granted');
      expect(result.current.enabled).toBe(true);
      expect(mockedNotificationsUtil.cancelDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('does not turn enabled on automatically when the permission changes from denied to granted while resuming (境界値: denied→grantedでもenabledは自動でONにしない)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('denied');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.enabled).toBe(false);
      const handleAppStateChange = getAppStateChangeListener();
      jest.clearAllMocks();
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');

      await act(async () => {
        handleAppStateChange('active');
        await Promise.resolve();
      });

      expect(result.current.permissionStatus).toBe('granted');
      expect(result.current.enabled).toBe(false);
    });

    it('keeps the previous permission status and enabled state without crashing when getReminderPermissionStatusAsync rejects while resuming (異常系: active復帰時の許可状態再取得に失敗)', async () => {
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { result } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      expect(result.current.enabled).toBe(true);
      const handleAppStateChange = getAppStateChangeListener();
      jest.clearAllMocks();
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockRejectedValueOnce(
        new Error('permission query error'),
      );

      await act(async () => {
        handleAppStateChange('active');
        await Promise.resolve();
      });

      // 再取得に失敗した場合は既存の状態(許可状態・enabled)をそのまま維持し、クラッシュもしない
      expect(result.current.permissionStatus).toBe('granted');
      expect(result.current.enabled).toBe(true);
      expect(mockedNotificationsUtil.cancelDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('removes the AppState subscription on unmount (境界値: アンマウント時のクリーンアップ)', async () => {
      const addEventListenerMock = AppState.addEventListener as jest.Mock;
      mockedNotificationsUtil.getReminderPermissionStatusAsync.mockResolvedValue('granted');
      const { unmount } = renderHook(() => useDiaryReminder(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      const call = addEventListenerMock.mock.calls.find(
        ([eventName]) => eventName === 'change',
      ) as [string, (...args: unknown[]) => void];
      const resultIndex = addEventListenerMock.mock.calls.indexOf(call);
      const removeMock = addEventListenerMock.mock.results[resultIndex].value.remove as jest.Mock;

      unmount();

      expect(removeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Provider外での利用(no-opフォールバック)', () => {
    it('returns the default disabled/21:00/undetermined state when used outside of DiaryReminderProvider (異常系/境界値: Provider外での利用)', () => {
      const { result } = renderHook(() => useDiaryReminder());

      expect(result.current.enabled).toBe(false);
      expect(result.current.hour).toBe(21);
      expect(result.current.minute).toBe(0);
      expect(result.current.permissionStatus).toBe('undetermined');
    });

    it('does not throw and does not touch AsyncStorage/notifications when setEnabled is called outside of the Provider (境界値: Provider外でのsetEnabledはno-op)', async () => {
      const { result } = renderHook(() => useDiaryReminder());

      await expect(result.current.setEnabled(true)).resolves.toBeUndefined();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(mockedNotificationsUtil.requestReminderPermissionAsync).not.toHaveBeenCalled();
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });

    it('does not throw and resolves to undefined when setTime is called outside of the Provider (境界値: Provider外でのsetTimeはno-op)', async () => {
      const { result } = renderHook(() => useDiaryReminder());

      await expect(result.current.setTime(8, 0)).resolves.toBeUndefined();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(mockedNotificationsUtil.scheduleDailyReminderAsync).not.toHaveBeenCalled();
    });
  });
});
