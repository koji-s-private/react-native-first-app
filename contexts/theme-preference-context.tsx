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

import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * ユーザーがアプリ内で選べる配色設定。
 * `'system'`はOSの設定(端末に合わせる)に追従することを表す。
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * 選択済みの配色設定をAsyncStorageに保存する際のキー。
 * `contexts/theme-preference-context.tsx`(読み書き)からのみ参照する想定。
 */
export const THEME_PREFERENCE_STORAGE_KEY = 'theme-preference';

type ThemePreferenceContextValue = {
  /** ユーザーが選択している設定値そのもの('system'を含む) */
  preference: ThemePreference;
  /** 設定値を変更し、AsyncStorageへの永続化も行う */
  setPreference: (preference: ThemePreference) => void;
  /** 'system'を実際のOSカラースキームに解決した後の、描画に使う配色('light'|'dark') */
  colorScheme: 'light' | 'dark';
};

const ThemePreferenceContext = createContext<ThemePreferenceContextValue | null>(null);

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function ThemePreferenceProvider({ children }: PropsWithChildren) {
  const systemColorScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // 起動時にAsyncStorageから前回選択した設定を読み込む。未保存または読み込み失敗時は
  // 既定値の'system'(端末に合わせる)のままにしておく
  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)
      .then((value) => {
        if (isMounted && isThemePreference(value)) {
          setPreferenceState(value);
        }
      })
      .catch(() => {
        // 読み込みに失敗しても既定値の'system'のまま動作を続ける
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    // 保存の完了を待たずに即座に画面へ反映する(保存に失敗しても目の前の見た目は更新済みなので、
    // 致命的な不具合にはならない。次回起動時に選択がリセットされる程度に留まる)
    setPreferenceState(next);
    AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next).catch(() => {});
  }, []);

  const colorScheme: 'light' | 'dark' =
    preference === 'system' ? (systemColorScheme ?? 'light') : preference;

  const value = useMemo<ThemePreferenceContextValue>(
    () => ({ preference, setPreference, colorScheme }),
    [preference, setPreference, colorScheme],
  );

  return (
    <ThemePreferenceContext.Provider value={value}>{children}</ThemePreferenceContext.Provider>
  );
}

/**
 * 選択中の配色設定と、実際に描画に使う解決済みカラースキームを取得するフック。
 * `ThemePreferenceProvider`配下でない場合(単体テストなど)は、OSのカラースキームに
 * フォールバックした読み取り専用相当の値を返す。
 */
export function useThemePreference(): ThemePreferenceContextValue {
  const context = useContext(ThemePreferenceContext);
  const systemColorScheme = useColorScheme();

  if (context) {
    return context;
  }

  return {
    preference: 'system',
    setPreference: () => {},
    colorScheme: systemColorScheme ?? 'light',
  };
}
