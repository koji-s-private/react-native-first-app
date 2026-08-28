import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import {
  APP_LOCK_ENABLED_STORAGE_KEY,
  AppLockProvider,
  useAppLock,
} from '@/contexts/app-lock-context';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できないため、
// 公式のインメモリモックに差し替える(tests/contexts/diary-reminder-context.test.tsxと同様)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `contexts/app-lock-context.tsx`は内部で`utils/app-lock-authentication.ts`
// (expo-local-authenticationの薄いラッパー)を呼び出す。このテストではコンテキストの
// 状態管理・永続化ロジック自体を検証したいため、そのラッパーごとモック化する
// (tests/utils/app-lock-authentication.test.tsでラッパー自体は別途検証済み)。
jest.mock('@/utils/app-lock-authentication', () => ({
  isAppLockSupportedAsync: jest.fn(),
  authenticateForAppLockAsync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedAuthenticationUtil = require('@/utils/app-lock-authentication') as {
  isAppLockSupportedAsync: jest.Mock;
  authenticateForAppLockAsync: jest.Mock;
};

const wrapper = ({ children }: PropsWithChildren) => <AppLockProvider>{children}</AppLockProvider>;

// `react-native`のJestプリセットが提供する`AppState.addEventListener`は既定で`jest.fn()`化
// されている(`{ remove: jest.fn() }`を返すだけ)ため、`change`イベント用に登録された
// リスナー関数を`mock.calls`から取り出し、テスト側から直接呼び出すことでバックグラウンド
// 遷移をシミュレートする(tests/contexts/diary-reminder-context.test.tsxと同様)。
function getAppStateChangeListener(): (nextAppState: string) => void {
  const addEventListenerMock = AppState.addEventListener as jest.Mock;
  const call = addEventListenerMock.mock.calls.find(([eventName]) => eventName === 'change');
  if (!call) {
    throw new Error('AppState.addEventListener("change", ...) が呼び出されていません');
  }
  return call[1];
}

describe('AppLockProvider / useAppLock', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    // 明示的にモックを指定しないテストでは「対応端末」を既定の挙動にしておく
    mockedAuthenticationUtil.isAppLockSupportedAsync.mockResolvedValue(true);
    mockedAuthenticationUtil.authenticateForAppLockAsync.mockResolvedValue(true);
  });

  it('defaults to disabled/unsupported/unlocked before AsyncStorage/OS state has resolved (初期値)', async () => {
    const { result } = renderHook(() => useAppLock(), { wrapper });

    expect(result.current.enabled).toBe(false);
    expect(result.current.isSupported).toBe(false);
    // 起動直後のチラつき防止のため、既定値OFFの読み込み完了前もロック画面は表示しない
    expect(result.current.isUnlocked).toBe(true);

    // 次のテストへ`act`警告が漏れないよう、この後起こる非同期の状態更新が
    // 完了するのを待ってからテストを終える(tests/app/_layout.test.tsxと同じ方針)
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  });

  it('starts with isReady=false and flips to true once the AsyncStorage read settles (初期値: 読み込み完了フラグ)', async () => {
    const { result } = renderHook(() => useAppLock(), { wrapper });

    // AsyncStorageの読み込みが完了するまでは、enabled/isUnlockedがまだ暫定値であることを
    // 示すフラグ。falseのままコンテンツ側が読み込み完了を誤って前提にしないことを検証する
    expect(result.current.isReady).toBe(false);

    await waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it('keeps isReady=false immediately after a previously saved ON setting is restored, and enabled/isUnlocked settle correctly once isReady becomes true (正常系: 起動時のisReadyとisUnlockedの整合性・レースコンディション対策)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'true');

    const { result } = renderHook(() => useAppLock(), { wrapper });

    // 読み込み未完了の間にisUnlocked(暫定値true)だけを見て「未ロック」と誤判定しないよう、
    // 呼び出し側はisReadyも合わせて確認する必要があることを示す
    expect(result.current.isReady).toBe(false);

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.isUnlocked).toBe(false);
  });

  it('sets isReady=true even when AsyncStorage.getItem rejects (異常系: 読み込み失敗時もisReadyは完了扱いになる)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    const { result } = renderHook(() => useAppLock(), { wrapper });

    await waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it('loads isSupported=true from the OS on mount when the device has biometrics/passcode enrolled (正常系: 対応端末)', async () => {
    mockedAuthenticationUtil.isAppLockSupportedAsync.mockResolvedValue(true);

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isSupported).toBe(true);
  });

  it('keeps isSupported=false when the device has nothing enrolled (異常系: 非対応端末)', async () => {
    mockedAuthenticationUtil.isAppLockSupportedAsync.mockResolvedValue(false);

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isSupported).toBe(false);
  });

  it('keeps isSupported=false without crashing when isAppLockSupportedAsync rejects (異常系: 対応判定の取得失敗)', async () => {
    mockedAuthenticationUtil.isAppLockSupportedAsync.mockRejectedValue(
      new Error('hardware query error'),
    );

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isSupported).toBe(false);
  });

  it('loads enabled=true and locks the screen when a previously saved setting is restored (正常系: 起動時の復元・ON)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'true');

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.isUnlocked).toBe(false);
  });

  it('loads enabled=false and keeps the screen unlocked when the saved setting is OFF (正常系: 起動時の復元・OFF)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'false');

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.isUnlocked).toBe(true);
  });

  it('treats a stored value other than the literal "true" as disabled (境界値: 不正な保存値)', async () => {
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, 'yes');

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.isUnlocked).toBe(true);
  });

  it('falls back to disabled/unlocked without crashing when AsyncStorage.getItem rejects (異常系: 読み込み失敗)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage read error'));

    const { result } = renderHook(() => useAppLock(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isUnlocked).toBe(true);
  });

  describe('setEnabled', () => {
    it('persists enabled=true without immediately locking the screen (正常系: ON)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.setEnabled(true);
      });

      expect(result.current.enabled).toBe(true);
      // ONにした直後はまだバックグラウンドに遷移していないため、ロック画面は表示しない
      expect(result.current.isUnlocked).toBe(true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(APP_LOCK_ENABLED_STORAGE_KEY, 'true');
    });

    it('persists enabled=false and forces the screen back to unlocked (正常系: OFF)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();
      act(() => {
        handleAppStateChange('background');
      });
      expect(result.current.isUnlocked).toBe(false);

      await act(async () => {
        await result.current.setEnabled(false);
      });

      expect(result.current.enabled).toBe(false);
      expect(result.current.isUnlocked).toBe(true);
      expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(APP_LOCK_ENABLED_STORAGE_KEY, 'false');
    });
  });

  describe('AppStateによるバックグラウンド遷移時の再ロック', () => {
    it('locks the screen when the app moves to the background while enabled (正常系: background遷移でロック)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();

      act(() => {
        handleAppStateChange('background');
      });

      expect(result.current.isUnlocked).toBe(false);
    });

    it('does not lock the screen when moving to the background while disabled (境界値: OFF時はbackground遷移してもロックしない)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      const handleAppStateChange = getAppStateChangeListener();

      act(() => {
        handleAppStateChange('background');
      });

      expect(result.current.isUnlocked).toBe(true);
    });

    it('does not lock the screen on an "inactive" transition (境界値: inactiveでは再ロックしない)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();

      act(() => {
        handleAppStateChange('inactive');
      });

      // 'inactive'は生体認証プロンプト表示中にも一時的に発生しうるため、ロックしない
      expect(result.current.isUnlocked).toBe(true);
    });

    it('removes the AppState subscription on unmount (境界値: アンマウント時のクリーンアップ)', async () => {
      const addEventListenerMock = AppState.addEventListener as jest.Mock;
      const { unmount } = renderHook(() => useAppLock(), { wrapper });
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

  describe('inactive遷移時のプライバシーオーバーレイ(#225)', () => {
    it('sets isInactiveOverlayVisible=true on an "inactive" transition while enabled (正常系: ONかつinactive遷移でオーバーレイ表示)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();

      act(() => {
        handleAppStateChange('inactive');
      });

      expect(result.current.isInactiveOverlayVisible).toBe(true);
    });

    it('resets isInactiveOverlayVisible to false once the app becomes "active" again (正常系: active復帰でオーバーレイ非表示)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();
      act(() => {
        handleAppStateChange('inactive');
      });
      expect(result.current.isInactiveOverlayVisible).toBe(true);

      act(() => {
        handleAppStateChange('active');
      });

      expect(result.current.isInactiveOverlayVisible).toBe(false);
    });

    it('does not show the overlay on an "inactive" transition while disabled (境界値: OFF時はinactive遷移してもオーバーレイを表示しない)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      const handleAppStateChange = getAppStateChangeListener();

      act(() => {
        handleAppStateChange('inactive');
      });

      expect(result.current.isInactiveOverlayVisible).toBe(false);
    });
  });

  describe('authenticate', () => {
    async function lockScreen(result: { current: ReturnType<typeof useAppLock> }) {
      await act(async () => {
        await result.current.setEnabled(true);
      });
      const handleAppStateChange = getAppStateChangeListener();
      act(() => {
        handleAppStateChange('background');
      });
    }

    it('unlocks the screen and returns true when authentication succeeds (正常系: 認証成功)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await lockScreen(result);
      mockedAuthenticationUtil.authenticateForAppLockAsync.mockResolvedValue(true);

      let authResult: boolean | undefined;
      await act(async () => {
        authResult = await result.current.authenticate();
      });

      expect(authResult).toBe(true);
      expect(result.current.isUnlocked).toBe(true);
    });

    it('keeps the screen locked and returns false when authentication fails (異常系: 認証失敗)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await lockScreen(result);
      mockedAuthenticationUtil.authenticateForAppLockAsync.mockResolvedValue(false);

      let authResult: boolean | undefined;
      await act(async () => {
        authResult = await result.current.authenticate();
      });

      expect(authResult).toBe(false);
      expect(result.current.isUnlocked).toBe(false);
    });

    it('keeps the screen locked and returns false without throwing when the underlying call rejects (異常系: 認証呼び出し自体の失敗)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await lockScreen(result);
      mockedAuthenticationUtil.authenticateForAppLockAsync.mockRejectedValue(
        new Error('native error'),
      );

      let authResult: boolean | undefined;
      await act(async () => {
        authResult = await result.current.authenticate();
      });

      expect(authResult).toBe(false);
      expect(result.current.isUnlocked).toBe(false);
    });

    it('ignores a duplicate call while a previous authenticate() is still in flight (境界値: 多重呼び出しの抑止)', async () => {
      const { result } = renderHook(() => useAppLock(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      await lockScreen(result);
      let resolveAuthentication: (success: boolean) => void = () => {};
      mockedAuthenticationUtil.authenticateForAppLockAsync.mockReturnValue(
        new Promise((resolve) => {
          resolveAuthentication = resolve;
        }),
      );

      let firstCallResult: Promise<boolean>;
      let secondCallResult: boolean | undefined;
      act(() => {
        firstCallResult = result.current.authenticate();
      });
      await act(async () => {
        secondCallResult = await result.current.authenticate();
      });

      expect(secondCallResult).toBe(false);
      expect(mockedAuthenticationUtil.authenticateForAppLockAsync).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveAuthentication(true);
        await firstCallResult;
      });
      expect(result.current.isUnlocked).toBe(true);
    });
  });

  describe('Provider外での利用(no-opフォールバック)', () => {
    it('returns the default disabled/unsupported/unlocked state when used outside of AppLockProvider (異常系/境界値: Provider外での利用)', () => {
      const { result } = renderHook(() => useAppLock());

      expect(result.current.enabled).toBe(false);
      expect(result.current.isSupported).toBe(false);
      expect(result.current.isUnlocked).toBe(true);
      // Provider外では読み込み待ちの概念自体が存在しないため、常に完了扱いとする
      expect(result.current.isReady).toBe(true);
    });

    it('does not throw and does not touch AsyncStorage when setEnabled is called outside of the Provider (境界値: Provider外でのsetEnabledはno-op)', async () => {
      const { result } = renderHook(() => useAppLock());

      await expect(result.current.setEnabled(true)).resolves.toBeUndefined();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('resolves to true without calling the native authentication module outside of the Provider (境界値: Provider外でのauthenticateはno-op)', async () => {
      const { result } = renderHook(() => useAppLock());

      await expect(result.current.authenticate()).resolves.toBe(true);
      expect(mockedAuthenticationUtil.authenticateForAppLockAsync).not.toHaveBeenCalled();
    });
  });
});
