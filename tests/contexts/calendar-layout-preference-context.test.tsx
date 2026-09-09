import { act, renderHook } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY,
  CalendarLayoutPreferenceProvider,
  useCalendarLayoutPreference,
} from '@/contexts/calendar-layout-preference-context';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できない(`NativeModule: AsyncStorage is
// null`になる)ため、パッケージが公式に提供しているインメモリのモックに差し替える
// (tests/contexts/theme-preference-context.test.tsxと同じ方針)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const wrapper = ({ children }: PropsWithChildren) => (
  <CalendarLayoutPreferenceProvider>{children}</CalendarLayoutPreferenceProvider>
);

describe('CalendarLayoutPreferenceProvider / useCalendarLayoutPreference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('defaults to "month" layout before AsyncStorage has resolved (初期値は月表示)', () => {
    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    expect(result.current.layout).toBe('month');
  });

  it('persists the new layout to AsyncStorage when setLayout("week") is called (正常系)', async () => {
    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    await act(async () => {
      result.current.setLayout('week');
    });

    expect(result.current.layout).toBe('week');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY,
      'week',
    );
    expect(await AsyncStorage.getItem(CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY)).toBe('week');
  });

  it('loads a previously saved layout from AsyncStorage on mount (正常系: 起動時の復元)', async () => {
    await AsyncStorage.setItem(CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY, 'week');

    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.layout).toBe('week');
  });

  it('ignores a stored value that is not a valid CalendarLayoutPreference and stays on the "month" default (境界値: 不正な保存値)', async () => {
    // AsyncStorageは文字列しか保存できないため、想定外の値(例: 過去バージョンの壊れたデータ)が
    // 入っている可能性がある。その場合は無視して既定値のままにする
    await AsyncStorage.setItem(CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY, 'invalid-value');

    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.layout).toBe('month');
  });

  it('falls back to "month" without crashing when AsyncStorage.getItem rejects (異常系: 読み込み失敗)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.layout).toBe('month');
  });

  it('keeps the newly selected layout reflected in the UI without crashing even when AsyncStorage.setItem rejects (異常系: 保存失敗)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));
    const { result } = renderHook(() => useCalendarLayoutPreference(), { wrapper });

    await act(async () => {
      result.current.setLayout('week');
      // setItemの失敗(rejectしたPromise)がハンドリングされるのを待つ
      await Promise.resolve();
    });

    // 保存に失敗しても、目の前の選択状態(見た目)は既に更新済みのまま
    expect(result.current.layout).toBe('week');
  });

  it('falls back to the "month" default when used outside of CalendarLayoutPreferenceProvider (異常系/境界値: Provider外での利用)', () => {
    const { result } = renderHook(() => useCalendarLayoutPreference());

    expect(result.current.layout).toBe('month');
  });

  it('does not throw when setLayout is called outside of CalendarLayoutPreferenceProvider (境界値: Provider外でのsetLayoutはno-op)', () => {
    const { result } = renderHook(() => useCalendarLayoutPreference());

    expect(() => result.current.setLayout('week')).not.toThrow();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
