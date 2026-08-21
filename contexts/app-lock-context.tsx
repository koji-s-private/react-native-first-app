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
  authenticateForAppLockAsync,
  isAppLockSupportedAsync,
} from '@/utils/app-lock-authentication';

/**
 * アプリロック(#155)のON/OFF設定をAsyncStorageに保存する際のキー。
 * `contexts/app-lock-context.tsx`(読み書き)からのみ参照する想定。
 */
export const APP_LOCK_ENABLED_STORAGE_KEY = 'app-lock-enabled';

type AppLockContextValue = {
  /** アプリロック機能がONになっているか(既定値はfalse。オプトイン方式) */
  enabled: boolean;
  /** この端末で生体認証・パスコードのいずれかが利用可能か。falseの場合はONにできない */
  isSupported: boolean;
  /** 現在ロック画面を表示すべきでないか。enabledがfalseの間は常にtrue */
  isUnlocked: boolean;
  /**
   * AsyncStorageからのロック設定(enabled)の読み込みが完了したか。falseの間はenabled/isUnlockedが
   * まだ暫定値であり、ONだったことを見落として日記データを描画してしまわないよう、呼び出し側
   * (app/_layout.tsx)はこの間コンテンツ全体を覆い隠す必要がある
   */
  isReady: boolean;
  /** アプリロックのON/OFFを切り替え、AsyncStorageへ永続化する */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** 生体認証(またはOS標準パスコード)を実行し、成功していればロックを解除する */
  authenticate: () => Promise<boolean>;
};

const AppLockContext = createContext<AppLockContextValue | null>(null);

export function AppLockProvider({ children }: PropsWithChildren) {
  const [enabled, setEnabledState] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  // デフォルトOFF(既存ユーザーの体験を変えないオプトイン方式)のため、AsyncStorageの読み込みが
  // 終わるまではtrue(未ロック)で開始する(components/onboarding.tsxの表示要否判定と同じ方針)。
  // ONだった場合のみ、読み込み完了後にロック画面へ切り替わる
  const [isUnlocked, setIsUnlocked] = useState(true);
  // ロック設定の読み込みが完了するまではisUnlocked=trueが暫定値(実際にONかどうか未確定)であり、
  // これをそのまま「未ロック」として扱うと、ONを復元する前提のケースでその間だけ日記データが
  // 描画されてしまう(#155)。読み込み完了を明示的なstateとして持ち、完了するまでは
  // app/_layout.tsx側でコンテンツ全体を覆い隠す
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(APP_LOCK_ENABLED_STORAGE_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        const isEnabled = value === 'true';
        setEnabledState(isEnabled);
        // OFFであれば(あるいは読み込み失敗時の既定値でも)ロック画面を表示する必要はない
        setIsUnlocked(!isEnabled);
      })
      .catch(() => {
        // 読み込みに失敗した場合はOFF相当として扱い、ロック画面で日記データへのアクセスを
        // 妨げないことを優先する(致命的な不具合にはならない)
        setIsUnlocked(true);
      })
      .finally(() => {
        if (isMounted) {
          setIsReady(true);
        }
      });

    isAppLockSupportedAsync()
      .then((supported) => {
        if (isMounted) {
          setIsSupported(supported);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsSupported(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // AppStateのリスナー(マウント時に一度だけ登録する)から常に最新のenabledを参照したいが、
  // リスナー自体を都度re-subscribeするのは避けたいため、依存配列に含めずrefで最新値を追う
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // バックグラウンドへ完全に遷移したタイミングでロックし直す。'inactive'は生体認証プロンプトの
  // 表示中にも一時的に発生する状態のため、これを含めると認証ダイアログを開いた瞬間に
  // 再ロックされてしまう。完全にバックグラウンドへ退避した('background')場合のみロックする
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'background' && enabledRef.current) {
        setIsUnlocked(false);
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, []);

  const setEnabled = useCallback(async (nextEnabled: boolean) => {
    setEnabledState(nextEnabled);
    if (!nextEnabled) {
      // OFFにした場合、以降ロック画面を表示する必要はない
      setIsUnlocked(true);
    }
    await AsyncStorage.setItem(APP_LOCK_ENABLED_STORAGE_KEY, nextEnabled ? 'true' : 'false');
  }, []);

  // authenticateAsyncを多重に呼び出すと(例: ロック画面表示時の自動起動とユーザーによる
  // 再試行ボタン押下が重なった場合)ネイティブ側で意図しない挙動になり得るため、
  // 実行中は追加の呼び出しを無視する
  const isAuthenticatingRef = useRef(false);

  const authenticate = useCallback(async () => {
    if (isAuthenticatingRef.current) {
      return false;
    }
    isAuthenticatingRef.current = true;
    try {
      const success = await authenticateForAppLockAsync();
      if (success) {
        setIsUnlocked(true);
      }
      return success;
    } catch {
      return false;
    } finally {
      isAuthenticatingRef.current = false;
    }
  }, []);

  const value = useMemo<AppLockContextValue>(
    () => ({ enabled, isSupported, isUnlocked, isReady, setEnabled, authenticate }),
    [enabled, isSupported, isUnlocked, isReady, setEnabled, authenticate],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}

/**
 * アプリロックの設定・状態を取得・変更するフック。
 * `AppLockProvider`配下でない場合(単体テストなど)は、常にロック画面を表示しない
 * 読み取り専用相当のフォールバック値を返す。読み込み待ちの概念自体が存在しないため
 * isReadyは常にtrue。
 */
export function useAppLock(): AppLockContextValue {
  const context = useContext(AppLockContext);

  if (context) {
    return context;
  }

  return {
    enabled: false,
    isSupported: false,
    isUnlocked: true,
    isReady: true,
    setEnabled: async () => {},
    authenticate: async () => true,
  };
}
