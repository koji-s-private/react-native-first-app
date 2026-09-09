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

/**
 * ホーム画面のカレンダー部分の表示レイアウト。
 * `'month'`は既存の1ヶ月分をまとめて表示するレイアウト、`'week'`は1週間分のみを表示するレイアウト(#283)。
 */
export type CalendarLayoutPreference = 'month' | 'week';

/**
 * 選択済みのカレンダー表示レイアウトをAsyncStorageに保存する際のキー。
 * `contexts/calendar-layout-preference-context.tsx`(読み書き)からのみ参照する想定。
 */
export const CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY = 'calendar-layout-preference';

type CalendarLayoutPreferenceContextValue = {
  /** ユーザーが選択している表示レイアウト */
  layout: CalendarLayoutPreference;
  /** 表示レイアウトを変更し、AsyncStorageへの永続化も行う */
  setLayout: (layout: CalendarLayoutPreference) => void;
};

const CalendarLayoutPreferenceContext = createContext<CalendarLayoutPreferenceContextValue | null>(
  null,
);

function isCalendarLayoutPreference(value: unknown): value is CalendarLayoutPreference {
  return value === 'month' || value === 'week';
}

export function CalendarLayoutPreferenceProvider({ children }: PropsWithChildren) {
  const [layout, setLayoutState] = useState<CalendarLayoutPreference>('month');

  // 起動時にAsyncStorageから前回選択した設定を読み込む。未保存または読み込み失敗時は
  // 既定値の'month'(月表示)のままにしておく(theme-preference-context.tsxと同じ方式)
  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY)
      .then((value) => {
        if (isMounted && isCalendarLayoutPreference(value)) {
          setLayoutState(value);
        }
      })
      .catch(() => {
        // 読み込みに失敗しても既定値の'month'のまま動作を続ける
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const setLayout = useCallback((next: CalendarLayoutPreference) => {
    // 保存の完了を待たずに即座に画面へ反映する(保存に失敗しても目の前の見た目は更新済みなので、
    // 致命的な不具合にはならない。次回起動時に選択がリセットされる程度に留まる)
    setLayoutState(next);
    AsyncStorage.setItem(CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY, next).catch(() => {});
  }, []);

  const value = useMemo<CalendarLayoutPreferenceContextValue>(
    () => ({ layout, setLayout }),
    [layout, setLayout],
  );

  return (
    <CalendarLayoutPreferenceContext.Provider value={value}>
      {children}
    </CalendarLayoutPreferenceContext.Provider>
  );
}

/**
 * 選択中のカレンダー表示レイアウトを取得するフック。
 * `CalendarLayoutPreferenceProvider`配下でない場合(単体テストなど)は、既定値'month'を
 * 返す読み取り専用相当の値を返す。
 */
export function useCalendarLayoutPreference(): CalendarLayoutPreferenceContextValue {
  const context = useContext(CalendarLayoutPreferenceContext);

  if (context) {
    return context;
  }

  return {
    layout: 'month',
    setLayout: () => {},
  };
}
