import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { Alert, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '@/app/(tabs)/settings';
import { TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID } from '@/components/tab-screen-container';
import { SETTINGS_SECTIONS } from '@/constants/settings-menu';
import { Colors } from '@/constants/theme';
import { AppLockProvider } from '@/contexts/app-lock-context';
import {
  DIARY_REMINDER_STORAGE_KEY,
  DiaryReminderProvider,
} from '@/contexts/diary-reminder-context';
import {
  THEME_PREFERENCE_STORAGE_KEY,
  ThemePreferenceProvider,
} from '@/contexts/theme-preference-context';
import {
  buildDiaryEntryKey,
  DIARY_ENTRIES_STORAGE_KEY,
  getAllDiaryEntries,
} from '@/utils/diary-storage';

// 実機では`expo-router`の`ExpoRoot`が自動的に`SafeAreaProvider`で全体をラップするが、単体
// レンダリングではそのラップが無く`useSafeAreaInsets`がエラーを投げるため(`tests/app/index.test.tsx`
// と同様)、ライブラリ公式のjestモック(常にゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

// `settings.tsx`は削除ボタンから`clearAllDiaryEntries`(内部で`AsyncStorage.removeItem`)を利用する
// ため、ネイティブの`AsyncStorage`が存在しないJest環境では公式のインメモリモックに差し替える。
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// 「リマインダー」セクションが使う`utils/diary-reminder-notifications.ts`
// (expo-notificationsの薄いラッパー)を、実際のネイティブ通知APIを呼ばずに検証できるようモック化する
// (個別の挙動はtests/utils/diary-reminder-notifications.test.ts等で検証済み。ここでは結線確認のみ)。
jest.mock('@/utils/diary-reminder-notifications', () => ({
  getReminderPermissionStatusAsync: jest.fn(() => Promise.resolve('undetermined')),
  requestReminderPermissionAsync: jest.fn(() => Promise.resolve('undetermined')),
  scheduleDailyReminderAsync: jest.fn(() => Promise.resolve()),
  cancelDailyReminderAsync: jest.fn(() => Promise.resolve()),
}));

// 「アプリロック」セクションが使う`utils/app-lock-authentication.ts`
// (expo-local-authenticationの薄いラッパー)を、実際のネイティブ生体認証APIを呼ばずに検証できるよう
// モック化する(個別の挙動はtests/utils/app-lock-authentication.test.ts等で検証済み。ここでは結線確認のみ)。
jest.mock('@/utils/app-lock-authentication', () => ({
  isAppLockSupportedAsync: jest.fn(() => Promise.resolve(true)),
  authenticateForAppLockAsync: jest.fn(() => Promise.resolve(true)),
}));

// `expo-file-system`(新API)はJest環境ではネイティブモジュールが存在せず、`Paths.cache`の参照時点で
// 例外になるため、固定のURIを返す`Paths.cache`と書き込み内容を記録できる`File`のモックに差し替える。
// `Paths.cache`を「取得できない」状態に上書きできるよう外側のクロージャ変数(`state`)に持たせ、
// テストファイルと`app/(tabs)/settings.tsx`のどちらの`import`経由でも同じ実体を読み書きできるようにする。
jest.mock('expo-file-system', () => {
  const state: { cacheDirectoryUri: string | null } = { cacheDirectoryUri: 'file:///mock-cache/' };
  const write = jest.fn();
  // インポート機能が`new File(asset.uri).text()`で読み込む内容を差し替えるためのモック。
  // 既定ではテストごとに明示的に`mockResolvedValueOnce`等で設定する想定
  const text = jest.fn((_uri: string) => Promise.reject(new Error('text() is not mocked')));

  class MockFile {
    uri: string;

    // `ExportDiaryDataButton`は`new File(Paths.cache, fileName)`(2引数)で、
    // `ImportDiaryDataButton`は`new File(asset.uri)`(URI文字列1つ)でそれぞれ呼び出すため、
    // 両方の呼び出し方に対応できるようにする
    constructor(directoryOrUri: { uri: string } | string, fileName?: string) {
      this.uri =
        typeof directoryOrUri === 'string'
          ? directoryOrUri
          : `${directoryOrUri.uri}${fileName ?? ''}`;
    }

    write(content: string) {
      return write(this.uri, content);
    }

    text() {
      return text(this.uri);
    }
  }

  return {
    Paths: {
      get cache() {
        if (state.cacheDirectoryUri === null) {
          // 実機で`Paths.cache`(内部の`Directory`パス検証)が失敗する状況を模倣する
          throw new Error('キャッシュディレクトリを取得できませんでした');
        }
        return { uri: state.cacheDirectoryUri };
      },
    },
    File: MockFile,
    __mockState: state,
    __mockWrite: write,
    __mockText: text,
  };
});

// `expo-document-picker`もJest環境ではネイティブのファイル選択UIを表示できないため、
// テストごとに選択結果(選択されたファイル/キャンセル)を差し替えられるようモックする。
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

// `expo-sharing`もJest環境ではネイティブモジュールが存在せず、`isAvailableAsync`が常に`false`を
// 返す(=共有不可)実際の挙動になってしまうため、共有可能なケースをテストできるよう明示的にモックする。
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  shareAsync: jest.fn(() => Promise.resolve()),
}));

// `getAllDiaryEntries`はレガシー(平文)データの移行時も含め、常に個別キーへの暗号化書き込みで
// `getOrCreateEncryptionKey`(expo-crypto/expo-secure-store経由)を使うようになったため、
// `tests/app/index.test.tsx`と同じくNode標準の`crypto`モジュールで代替するモックが必要になる。
jest.mock('expo-crypto', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
    randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  };
});

// expo-secure-storeはjest-expoのオートモックだと`getItemAsync`が常に`undefined`を返し、
// 状態を永続化しない。`tests/app/index.test.tsx`と同様、インメモリでキーと値を保持する
// 独自モックに差し替える。
jest.mock('expo-secure-store', () => {
  let store: Record<string, string> = {};
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
    // テスト間で鍵の永続化状態を分離するためのヘルパー(実際のexpo-secure-storeには存在しない)
    __reset: () => {
      store = {};
    },
  };
});

// `ExternalLink`(内部で`expo-router`の`Link`を使う)や`Link`自体は、実機ではナビゲーション/
// ルーターのコンテキストを必要とするため、画面を単体でレンダリングするこのテストでは利用できない。
// 他のテスト(`tests/app/oss-licenses.test.tsx`等)と同じくパススルーのモックに差し替えるが、
// このテストでは各リンクの`href`が正しいことも検証したいため、`href`を`testID`として
// 可視化する薄いモックにしている。
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactForMock = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text: TextForMock } = require('react-native');

  function MockLink({
    href,
    children,
    ...rest
  }: PropsWithChildren<{ href: unknown } & Record<string, unknown>>) {
    return ReactForMock.createElement(
      TextForMock,
      { ...rest, testID: `link-${String(href)}` },
      children,
    );
  }

  return { Link: MockLink };
});

// jest.mockしたutils/diary-reminder-notifications.tsの各関数を、テストごとに呼び出し内容を
// 差し替え・検証するための参照(tests/contexts/diary-reminder-context.test.tsxと同じ方式)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedDiaryReminderNotifications = require('@/utils/diary-reminder-notifications') as {
  getReminderPermissionStatusAsync: jest.Mock;
  requestReminderPermissionAsync: jest.Mock;
  scheduleDailyReminderAsync: jest.Mock;
  cancelDailyReminderAsync: jest.Mock;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedAppLockAuthentication = require('@/utils/app-lock-authentication') as {
  isAppLockSupportedAsync: jest.Mock;
  authenticateForAppLockAsync: jest.Mock;
};

// テストごとに暗号鍵の永続化状態を分離するための参照(tests/app/index.test.tsxと同じ方式)
const secureStoreMock = SecureStore as unknown as { __reset: () => void };

// jest.mockした'expo-file-system'の内部状態(キャッシュディレクトリの有無)・書き込み呼び出しを
// テストごとに操作/検証するための参照
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockedFileSystem = require('expo-file-system') as {
  __mockState: { cacheDirectoryUri: string | null };
  __mockWrite: jest.Mock;
  __mockText: jest.Mock;
};

describe('SettingsScreen', () => {
  it('renders every section title defined in SETTINGS_SECTIONS', () => {
    render(<SettingsScreen />);

    for (const section of SETTINGS_SECTIONS) {
      expect(screen.getByText(section.title)).toBeTruthy();
    }
  });

  it('renders a link for every menu item with the correct label and href', () => {
    render(<SettingsScreen />);

    for (const section of SETTINGS_SECTIONS) {
      for (const item of section.items) {
        const link = screen.getByTestId(`link-${item.href}`);
        expect(within(link).getByText(item.label)).toBeTruthy();
      }
    }
  });

  it('links "プライバシーポリシー" and "利用規約" to https:// URLs (external links)', () => {
    render(<SettingsScreen />);

    const legalSection = SETTINGS_SECTIONS.find((section) => section.key === 'legal');
    expect(legalSection).toBeDefined();

    const privacyPolicy = legalSection?.items.find((item) => item.key === 'privacy-policy');
    const termsOfService = legalSection?.items.find((item) => item.key === 'terms-of-service');
    expect(privacyPolicy).toBeDefined();
    expect(termsOfService).toBeDefined();

    // `item.href`は`SettingsMenuItem`のユニオン型全体では`string | HrefObject`のため、
    // `.startsWith`を呼ぶには`type`で`'external'`に絞り込んでTypeScriptに文字列型だと
    // 認識させる必要がある(絞り込まずに呼ぶと`tsc --noEmit`がコンパイルエラーになる)。
    expect(privacyPolicy?.type).toBe('external');
    if (privacyPolicy?.type === 'external') {
      expect(privacyPolicy.href.startsWith('https://')).toBe(true);
    }
    expect(termsOfService?.type).toBe('external');
    if (termsOfService?.type === 'external') {
      expect(termsOfService.href.startsWith('https://')).toBe(true);
    }
  });

  it('links "OSSライセンス" to the in-app /oss-licenses route (internal navigation)', () => {
    render(<SettingsScreen />);

    const legalSection = SETTINGS_SECTIONS.find((section) => section.key === 'legal');
    const ossLicenses = legalSection?.items.find((item) => item.key === 'oss-licenses');
    expect(ossLicenses).toBeDefined();
    expect(ossLicenses?.type).toBe('internal');
    expect(ossLicenses?.href).toBe('/oss-licenses');

    expect(screen.getByTestId('link-/oss-licenses')).toBeTruthy();
  });

  it('links "お問い合わせ" to a mailto: address (opens the mail app)', () => {
    render(<SettingsScreen />);

    const supportSection = SETTINGS_SECTIONS.find((section) => section.key === 'support');
    const contact = supportSection?.items.find((item) => item.key === 'contact');
    expect(contact).toBeDefined();
    expect(contact?.type).toBe('mailto');
    if (contact?.type === 'mailto') {
      expect(contact.href.startsWith('mailto:')).toBe(true);
    }

    const link = screen.getByTestId(`link-${contact?.href}`);
    expect(within(link).getByText('お問い合わせ')).toBeTruthy();
  });

  it('renders the "設定" tab content without crashing when the ThemedText/ThemedView wrap each link (regression check)', () => {
    render(<SettingsScreen />);

    expect(screen.UNSAFE_getAllByType(Text).length).toBeGreaterThan(0);
  });

  // セーフエリア対応は共通コンポーネント`TabScreenContainer`に委ねているため、
  // ここではその外側ラッパーに正しくインセットが伝播していることのみを検証する。
  describe('セーフエリア対応(ステータスバー/ノッチ領域との重なり防止)', () => {
    it('does not add extra top padding via TabScreenContainer when the safe area top inset is zero', () => {
      render(<SettingsScreen />);

      const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
      const flattenedStyle = StyleSheet.flatten(safeAreaWrapper.props.style);

      expect(flattenedStyle.paddingTop).toBe(0);
    });

    it('adds the safe area top inset as paddingTop on TabScreenContainer so content does not overlap the status bar/notch/Dynamic Island', () => {
      // iPhone 14 Pro (Dynamic Island) 相当のトップインセットを想定
      render(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 393, height: 852 },
            insets: { top: 59, left: 0, right: 0, bottom: 34 },
          }}
        >
          <SettingsScreen />
        </SafeAreaProvider>,
      );

      const safeAreaWrapper = screen.getByTestId(TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID);
      const flattenedStyle = StyleSheet.flatten(safeAreaWrapper.props.style);

      expect(flattenedStyle.paddingTop).toBe(59);
    });
  });
});

describe('SETTINGS_SECTIONS data integrity (境界値・異常系)', () => {
  it('is not empty (boundary: at least 1 section must be defined)', () => {
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0);
  });

  it('has at least 1 item in every section (boundary: no empty section)', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('has non-empty required fields (key/label/href) on every item', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.key.length).toBeGreaterThan(0);
      expect(section.title.length).toBeGreaterThan(0);

      for (const item of section.items) {
        expect(item.key.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
        expect(String(item.href).length).toBeGreaterThan(0);
      }
    }
  });

  it('has unique section keys and unique item keys within each section (React key衝突の防止)', () => {
    // `section.key`/`item.key`はReactの`key` propとしてそのまま使われているため、
    // 重複すると意図しない再利用・警告が発生する。将来項目が追加された際の回帰を防ぐ。
    const sectionKeys = SETTINGS_SECTIONS.map((section) => section.key);
    expect(new Set(sectionKeys).size).toBe(sectionKeys.length);

    for (const section of SETTINGS_SECTIONS) {
      const itemKeys = section.items.map((item) => item.key);
      expect(new Set(itemKeys).size).toBe(itemKeys.length);
    }
  });
});

describe('日記データを全件削除ボタン(データ管理セクション)', () => {
  const DELETE_BUTTON_LABEL = '日記データを全件削除';
  const CONFIRM_DIALOG_TITLE = '日記データを削除しますか?';
  const CONFIRM_DIALOG_MESSAGE =
    'この端末に保存されているすべての日記データが削除されます。この操作は取り消せません。';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  // Alert.alertをモック化した上で、直近の呼び出しに渡されたボタン定義から指定ラベルのonPressを
  // 直接呼び出すことで「ユーザーがそのボタンをタップした」ことを模倣する。onPress自体が状態更新を
  // 伴う非同期処理(handleDelete)を呼び出すため、actで包んで反映を待つ。
  async function pressAlertButton(label: string) {
    const alertMock = Alert.alert as jest.Mock;
    const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
    const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
    const button = buttons.find((b) => b.text === label);
    expect(button).toBeDefined();
    await act(async () => {
      button?.onPress?.();
    });
  }

  it('renders a "データ管理" section containing the delete-all button (操作導線の存在確認)', () => {
    render(<SettingsScreen />);

    expect(screen.getByText('データ管理')).toBeTruthy();
    expect(screen.getByText(DELETE_BUTTON_LABEL)).toBeTruthy();
  });

  it('shows a confirmation dialog with cancel/delete options when pressed, and does not delete anything yet (確認ダイアログの表示)', () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe(CONFIRM_DIALOG_TITLE);
    expect(message).toBe(CONFIRM_DIALOG_MESSAGE);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({ text: 'キャンセル', style: 'cancel' });
    expect(buttons[1]).toMatchObject({ text: '削除する', style: 'destructive' });

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('deletes nothing when the cancel button is pressed (キャンセル時は削除されない)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    await pressAlertButton('キャンセル');

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBe(
      'encrypted:v1:dummy-payload',
    );
  });

  it('deletes all diary data from AsyncStorage and shows a completion alert once confirmed (正常系: 削除の実行と完了通知)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    await pressAlertButton('削除する');

    await waitFor(() =>
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DIARY_ENTRIES_STORAGE_KEY),
    );
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBeNull();

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenLastCalledWith(
        '削除が完了しました',
        '保存されていた日記データをすべて削除しました。',
      ),
    );
  });

  it('shows a failure alert (and does not crash) when AsyncStorage.removeItem rejects (異常系: 削除失敗時のフィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('delete failed'));
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    await pressAlertButton('削除する');

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenLastCalledWith(
        '削除に失敗しました',
        'もう一度お試しください。',
      ),
    );
  });

  // 削除処理中(isDeleting === true)は誤って連続タップされないよう、ボタンを
  // 半透明化(opacity: 0.5)しaccessibilityState.disabledをtrueにする。完了後は元に戻る。
  it('dims the button (opacity 0.5) and sets accessibilityState.disabled to true while deleting, then restores both once finished (処理中の視覚的フィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // AsyncStorage.removeItemが完了するまで解決しないPromiseにして、処理中の一瞬の状態を検証する
    let resolveRemoveItem: () => void = () => {};
    jest.spyOn(AsyncStorage, 'removeItem').mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRemoveItem = resolve;
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    const alertMock = Alert.alert as jest.Mock;
    const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
    const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
    const confirmDeleteButton = buttons.find((b) => b.text === '削除する');

    act(() => {
      confirmDeleteButton?.onPress?.();
    });

    const buttonWhileDeleting = screen.getByRole('button', { name: DELETE_BUTTON_LABEL });
    expect(StyleSheet.flatten(buttonWhileDeleting.props.style).opacity).toBe(0.5);
    expect(buttonWhileDeleting.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );

    resolveRemoveItem();

    await waitFor(() => {
      const buttonAfterDeleting = screen.getByRole('button', { name: DELETE_BUTTON_LABEL });
      expect(StyleSheet.flatten(buttonAfterDeleting.props.style).opacity).toBe(1);
    });
    expect(
      screen.getByRole('button', { name: DELETE_BUTTON_LABEL }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  // 削除ボタンの文字色が固定のライトモード用エラー色のままダークモードでも
  // 使われてしまっていた不具合の回帰テスト。
  describe('ダークモード対応(削除ボタンの文字色)', () => {
    // 単体レンダリングでは実機の`RootLayout`によるラップが無いため、配色切り替えを検証するには
    // 外観セクションのテストと同様に明示的に`ThemePreferenceProvider`でラップする必要がある。
    function renderSettingsScreen() {
      return render(
        <ThemePreferenceProvider>
          <SettingsScreen />
        </ThemePreferenceProvider>,
      );
    }

    it('uses the light theme error color (not a hardcoded value) when the theme preference is light (正常系: ライトモード)', async () => {
      await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'light');
      renderSettingsScreen();

      await waitFor(() => {
        const flattenedStyle = StyleSheet.flatten(
          screen.getByText(DELETE_BUTTON_LABEL).props.style,
        );
        expect(flattenedStyle.color).toBe(Colors.light.error);
      });
    });

    it('uses the dark theme error color (not the light-mode hardcoded value) when the theme preference is dark (正常系: ダークモード)', async () => {
      await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'dark');
      renderSettingsScreen();

      await waitFor(() => {
        const flattenedStyle = StyleSheet.flatten(
          screen.getByText(DELETE_BUTTON_LABEL).props.style,
        );
        expect(flattenedStyle.color).toBe(Colors.dark.error);
      });
      // ライトモード用の固定色が使われていないことも明示的に確認する
      const flattenedStyle = StyleSheet.flatten(screen.getByText(DELETE_BUTTON_LABEL).props.style);
      expect(flattenedStyle.color).not.toBe(Colors.light.error);
    });
  });
});

describe('日記データをエクスポートボタン(データ管理セクション)', () => {
  const EXPORT_BUTTON_LABEL = '日記データをエクスポート';
  // getAllDiaryEntriesはcreatedAtの降順(新しい順)で返すため、あらかじめその順序で定義しておく
  const sampleEntriesJson = JSON.stringify([
    { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);

  const originalPlatformOS = Platform.OS;

  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
    // 各テストごとにモックの既定挙動をリセットする(個別のテストで上書きするため)
    mockedFileSystem.__mockState.cacheDirectoryUri = 'file:///mock-cache/';
    mockedFileSystem.__mockWrite.mockReturnValue(undefined);
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
    (Sharing.shareAsync as jest.Mock).mockResolvedValue(undefined);
    Platform.OS = originalPlatformOS;
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
  });

  it('renders the export button inside the "データ管理" section (操作導線の存在確認)', () => {
    render(<SettingsScreen />);

    expect(screen.getByText('データ管理')).toBeTruthy();
    expect(screen.getByText(EXPORT_BUTTON_LABEL)).toBeTruthy();
  });

  it('shows an alert and does not touch the file system/sharing APIs when there are 0 diary entries (境界値: 0件)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'エクスポートできる日記データがありません',
        '日記を書いてからもう一度お試しください。',
      ),
    );
    expect(mockedFileSystem.__mockWrite).not.toHaveBeenCalled();
    expect(Sharing.isAvailableAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('writes the JSON file to the cache directory and opens the native share sheet when there is data (正常系)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // 暗号化対応前の平文JSON形式でも読み込めることを兼ねて確認するため、そのまま保存する
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() => expect(mockedFileSystem.__mockWrite).toHaveBeenCalledTimes(1));
    const [fileUri, writtenContent] = mockedFileSystem.__mockWrite.mock.calls[0];
    expect(fileUri).toMatch(/^file:\/\/\/mock-cache\/diary-export-\d{8}-\d{6}\.json$/);
    expect(JSON.parse(writtenContent)).toEqual(JSON.parse(sampleEntriesJson));

    await waitFor(() => expect(Sharing.isAvailableAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(Sharing.shareAsync).toHaveBeenCalledWith(fileUri, {
      mimeType: 'application/json',
      dialogTitle: '日記データをエクスポート',
      UTI: 'public.json',
    });

    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('shows an alert and does not call shareAsync when sharing is unavailable on the device (異常系)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(false);
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        '共有機能を利用できません',
        'この端末では共有機能を利用できないため、エクスポートを完了できませんでした。',
      ),
    );
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('shows a failure alert when writing the export file fails (異常系: ファイル書き込み失敗)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    mockedFileSystem.__mockWrite.mockImplementation(() => {
      throw new Error('disk full');
    });
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'エクスポートに失敗しました',
        'もう一度お試しください。',
      ),
    );
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('shows a failure alert when the share sheet itself fails (異常系: 共有失敗)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    (Sharing.shareAsync as jest.Mock).mockRejectedValue(new Error('share cancelled'));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'エクスポートに失敗しました',
        'もう一度お試しください。',
      ),
    );
  });

  // エクスポート処理中(isExporting === true)は誤って連続タップされないよう、ボタンを
  // 半透明化(opacity: 0.5)しaccessibilityState.disabledをtrueにする。完了後は元に戻る。
  it('dims the button (opacity 0.5) and sets accessibilityState.disabled to true while exporting, then restores both once finished (処理中の視覚的フィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    // `file.write()`は同期メソッドのため書き込み自体は即座に終わる。代わりに書き込み後に呼ばれる
    // `Sharing.isAvailableAsync`が完了するまで解決しないPromiseにして、処理中の状態を検証する。
    let resolveIsAvailable: (value: boolean) => void = () => {};
    (Sharing.isAvailableAsync as jest.Mock).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveIsAvailable = resolve;
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));

    const buttonWhileExporting = screen.getByRole('button', { name: EXPORT_BUTTON_LABEL });
    expect(StyleSheet.flatten(buttonWhileExporting.props.style).opacity).toBe(0.5);
    expect(buttonWhileExporting.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );

    // この時点で書き込み自体はすでに完了していること(同期メソッドのため)も合わせて確認する
    await waitFor(() => expect(mockedFileSystem.__mockWrite).toHaveBeenCalledTimes(1));
    resolveIsAvailable(true);

    await waitFor(() => {
      const buttonAfterExporting = screen.getByRole('button', { name: EXPORT_BUTTON_LABEL });
      expect(StyleSheet.flatten(buttonAfterExporting.props.style).opacity).toBe(1);
    });
    expect(
      screen.getByRole('button', { name: EXPORT_BUTTON_LABEL }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('shows a failure alert when the cache directory is unavailable (境界値: Paths.cacheが取得できない場合)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    mockedFileSystem.__mockState.cacheDirectoryUri = null;
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'エクスポートに失敗しました',
        'もう一度お試しください。',
      ),
    );
    expect(mockedFileSystem.__mockWrite).not.toHaveBeenCalled();
  });

  describe('Web版(Platform.OS === "web")', () => {
    // Webはexpo-file-system/expo-sharingに対応していないため、実装はBlob + <a download>による
    // ブラウザ標準ダウンロードにフォールバックする。Jest環境(Node)には`document`が存在しないため
    // `click`呼び出しを検証できる最小限のモックを用意する。`URL.createObjectURL`/`revokeObjectURL`も
    // expoのポリフィルのままだと実機のネイティブ`BlobModule`前提で例外になるため差し替える。
    let createdAnchor: { href: string; download: string; click: jest.Mock };
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let localStorageStore: Record<string, string>;

    beforeEach(() => {
      Platform.OS = 'web';
      createdAnchor = { href: '', download: '', click: jest.fn() };
      (global as unknown as { document: Document }).document = {
        createElement: jest.fn(() => createdAnchor),
      } as unknown as Document;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();
      // Web版では暗号鍵の保存先がexpo-secure-storeではなくlocalStorageになる
      // (utils/diary-encryption.ts参照)。テスト実行環境(Node)にはlocalStorageが存在しないため、
      // `tests/utils/diary-encryption.test.ts`と同じ最小限のインメモリ実装を用意しておかないと、
      // getAllDiaryEntries内で毎回異なる鍵が生成されてしまい復号に失敗する
      localStorageStore = {};
      (global as unknown as { localStorage: Storage }).localStorage = {
        getItem: jest.fn((key: string) => localStorageStore[key] ?? null),
        setItem: jest.fn((key: string, value: string) => {
          localStorageStore[key] = value;
        }),
        removeItem: jest.fn((key: string) => {
          delete localStorageStore[key];
        }),
        clear: jest.fn(() => {
          localStorageStore = {};
        }),
        key: jest.fn(() => null),
        length: 0,
      } as unknown as Storage;
    });

    afterEach(() => {
      delete (global as unknown as { document?: Document }).document;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      delete (global as unknown as { localStorage?: Storage }).localStorage;
    });

    it('triggers a browser download instead of calling expo-file-system/expo-sharing (正常系: Webフォールバック)', async () => {
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
      render(<SettingsScreen />);

      await act(async () => {
        fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
      });

      await waitFor(() => expect(createdAnchor.click).toHaveBeenCalledTimes(1));
      expect(createdAnchor.download).toMatch(/^diary-export-\d{8}-\d{6}\.json$/);
      expect(mockedFileSystem.__mockWrite).not.toHaveBeenCalled();
      expect(Sharing.isAvailableAsync).not.toHaveBeenCalled();
      expect(Sharing.shareAsync).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it('shows the empty-data alert without touching the DOM when there are 0 entries (境界値: Web版0件)', async () => {
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      render(<SettingsScreen />);

      await act(async () => {
        fireEvent.press(screen.getByText(EXPORT_BUTTON_LABEL));
      });

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith(
          'エクスポートできる日記データがありません',
          '日記を書いてからもう一度お試しください。',
        ),
      );
      expect(createdAnchor.click).not.toHaveBeenCalled();
    });
  });
});

describe('日記データをインポートボタン(データ管理セクション)', () => {
  const IMPORT_BUTTON_LABEL = '日記データをインポート';
  const CONFIRM_DIALOG_TITLE = '日記データをインポートしますか?';
  const IMPORT_FAILURE_ALERT = [
    'インポートに失敗しました',
    '選択したファイルを読み込めませんでした。ファイルの形式を確認してもう一度お試しください。',
  ] as const;

  const pickedAsset = {
    uri: 'file:///picked/diary-export.json',
    name: 'diary-export.json',
    mimeType: 'application/json',
    lastModified: 0,
  };

  const originalPlatformOS = Platform.OS;

  // Alert.alertをモック化した上で、直近の呼び出しに渡されたボタン定義から指定ラベルのonPressを
  // 直接呼び出すことで「ユーザーがそのボタンをタップした」ことを模倣する
  // (削除ボタンのテストにある`pressAlertButton`と同じ方式)。
  async function pressAlertButtonByLabel(label: string) {
    const alertMock = Alert.alert as jest.Mock;
    const lastCall = alertMock.mock.calls[alertMock.mock.calls.length - 1];
    const buttons = lastCall[2] as { text: string; onPress?: () => void }[];
    const button = buttons.find((b) => b.text === label);
    expect(button).toBeDefined();
    await act(async () => {
      button?.onPress?.();
    });
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
    (DocumentPicker.getDocumentAsync as jest.Mock).mockReset();
    Platform.OS = originalPlatformOS;
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
  });

  it('renders the import button inside the "データ管理" section (操作導線の存在確認)', () => {
    render(<SettingsScreen />);

    expect(screen.getByText('データ管理')).toBeTruthy();
    expect(screen.getByText(IMPORT_BUTTON_LABEL)).toBeTruthy();
  });

  it('does nothing when the user cancels the document picker (キャンセル時は何もしない)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: true,
      assets: null,
    });
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('shows a confirmation dialog with the entry count before saving anything (確認ダイアログの表示)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce(
      JSON.stringify([{ id: '1', text: '取り込む日記', createdAt: '2026-02-01T00:00:00.000Z' }]),
    );
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe(CONFIRM_DIALOG_TITLE);
    expect(message).toContain('1件');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({ text: 'キャンセル', style: 'cancel' });
    expect(buttons[1]).toMatchObject({ text: '取り込む' });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('saves nothing when the confirmation dialog is cancelled (キャンセル時は保存しない)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce(
      JSON.stringify([{ id: '1', text: '取り込む日記', createdAt: '2026-02-01T00:00:00.000Z' }]),
    );
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    await pressAlertButtonByLabel('キャンセル');

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('saves the imported entries and shows a completion alert once confirmed, adding to existing data without deleting it (正常系: 追記マージ)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const existingEntry = {
      id: 'existing',
      text: '既存の日記',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await AsyncStorage.setItem(buildDiaryEntryKey('existing'), JSON.stringify(existingEntry));
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    const importedEntry = {
      id: 'imported',
      text: '取り込んだ日記',
      createdAt: '2026-02-01T00:00:00.000Z',
    };
    mockedFileSystem.__mockText.mockResolvedValueOnce(JSON.stringify([importedEntry]));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    await pressAlertButtonByLabel('取り込む');

    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        buildDiaryEntryKey('imported'),
        expect.any(String),
      ),
    );
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenLastCalledWith(
        'インポートが完了しました',
        '1件の日記データを取り込みました。',
      ),
    );

    const allEntries = await getAllDiaryEntries();
    expect(allEntries.map((entry) => entry.id).sort()).toEqual(['existing', 'imported']);
  });

  it('overwrites an existing entry with the imported content when ids collide (id重複時はインポート側の内容で上書き)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(
      buildDiaryEntryKey('1'),
      JSON.stringify({ id: '1', text: '元のテキスト', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    const updatedEntry = {
      id: '1',
      text: '更新後のテキスト',
      createdAt: '2026-01-05T00:00:00.000Z',
    };
    mockedFileSystem.__mockText.mockResolvedValueOnce(JSON.stringify([updatedEntry]));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    await pressAlertButtonByLabel('取り込む');

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
    const allEntries = await getAllDiaryEntries();
    expect(allEntries).toEqual([updatedEntry]);
  });

  it('shows an alert and does not open the confirmation dialog when the file has no valid entries (境界値: 有効なエントリが0件)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce('[]');
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'インポートできる日記データがありません',
        '選択したファイルに有効な日記データが含まれていませんでした。',
      ),
    );
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('skips invalid elements in the array but still imports the valid ones, logging a warning (異常系: 一部エントリのスキーマ不整合)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    const validEntry = { id: '1', text: '有効な日記', createdAt: '2026-01-01T00:00:00.000Z' };
    mockedFileSystem.__mockText.mockResolvedValueOnce(
      JSON.stringify([validEntry, { id: '2', text: '壊れたデータ' }]),
    );
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await pressAlertButtonByLabel('取り込む');

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalled());
    const allEntries = await getAllDiaryEntries();
    expect(allEntries).toEqual([validEntry]);
    warnSpy.mockRestore();
  });

  it('shows an error alert when the selected file is not valid JSON (異常系: パース失敗)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce('not-valid-json{{{');
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(...IMPORT_FAILURE_ALERT));
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('shows an error alert when the top-level JSON value is not an array (異常系: 配列でない)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce(JSON.stringify({ not: 'an array' }));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(...IMPORT_FAILURE_ALERT));
  });

  it('shows a failure alert when reading the picked file rejects (異常系: ファイル読み込み失敗)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockRejectedValueOnce(new Error('read error'));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(...IMPORT_FAILURE_ALERT));
  });

  it('shows a failure alert when saving an imported entry fails (異常系: 保存失敗)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce(
      JSON.stringify([{ id: '1', text: '取り込む日記', createdAt: '2026-02-01T00:00:00.000Z' }]),
    );
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('write error'));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    await pressAlertButtonByLabel('取り込む');

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenLastCalledWith(
        'インポートに失敗しました',
        'もう一度お試しください。',
      ),
    );
  });

  // reviewerからの指摘(PR #222): 暗号鍵が未生成の状態(=まさにバックアップ復元時に起きる状況)で
  // 複数件を並列(Promise.all)保存すると、各保存処理が同時に鍵の生成・書き込みを行い、
  // 最後に勝った鍵以外で暗号化されたエントリが復号不能になり消失していた。逐次保存への
  // 修正(for...of)によりこれが起きないことを回帰テストとして固定する。
  it('saves every imported entry so that all of them are decryptable afterwards, even from a fresh (not-yet-generated) encryption key state (回帰: 暗号鍵レースコンディションによるデータ消失防止)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // secureStoreMock.__reset()により暗号鍵が未生成の状態から始まる(beforeEachで実施済み)
    const importedEntries = Array.from({ length: 10 }, (_, i) => ({
      id: `entry-${i}`,
      text: `取り込む日記 ${i}`,
      createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [pickedAsset],
    });
    mockedFileSystem.__mockText.mockResolvedValueOnce(JSON.stringify(importedEntries));
    render(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    await pressAlertButtonByLabel('取り込む');

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenLastCalledWith(
        'インポートが完了しました',
        `${importedEntries.length}件の日記データを取り込みました。`,
      ),
    );

    const allEntries = await getAllDiaryEntries();
    expect(allEntries.map((entry) => entry.id).sort()).toEqual(
      importedEntries.map((entry) => entry.id).sort(),
    );
  });

  // 他の操作導線(削除/エクスポート)に導入された、処理中の連続タップ防止のための
  // 視覚的フィードバックをインポートボタンにも合わせる。
  it('dims the button and disables it while picking a file, then restores both once finished (処理中の視覚的フィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    let resolvePick: (value: DocumentPicker.DocumentPickerResult) => void = () => {};
    (DocumentPicker.getDocumentAsync as jest.Mock).mockReturnValue(
      new Promise<DocumentPicker.DocumentPickerResult>((resolve) => {
        resolvePick = resolve;
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));

    const buttonWhileImporting = screen.getByRole('button', { name: IMPORT_BUTTON_LABEL });
    expect(StyleSheet.flatten(buttonWhileImporting.props.style).opacity).toBe(0.5);
    expect(buttonWhileImporting.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );

    await act(async () => {
      resolvePick({ canceled: true, assets: null });
    });

    await waitFor(() => {
      const buttonAfterImporting = screen.getByRole('button', { name: IMPORT_BUTTON_LABEL });
      expect(StyleSheet.flatten(buttonAfterImporting.props.style).opacity).toBe(1);
    });
    expect(
      screen.getByRole('button', { name: IMPORT_BUTTON_LABEL }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  describe('Web版(Platform.OS === "web")', () => {
    beforeEach(() => {
      Platform.OS = 'web';
    });

    it('reads the file content from the browser File object instead of expo-file-system (正常系: Web版)', async () => {
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const webFileText = jest
        .fn()
        .mockResolvedValue(
          JSON.stringify([
            { id: '1', text: '取り込む日記', createdAt: '2026-02-01T00:00:00.000Z' },
          ]),
        );
      (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
        canceled: false,
        assets: [{ ...pickedAsset, file: { text: webFileText } }],
      });
      render(<SettingsScreen />);

      await act(async () => {
        fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
      });

      await waitFor(() => expect(webFileText).toHaveBeenCalledTimes(1));
      expect(mockedFileSystem.__mockText).not.toHaveBeenCalled();
      await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    });

    it('shows a failure alert when the browser File object is missing from the picked asset (境界値: asset.fileが無い場合)', async () => {
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
        canceled: false,
        assets: [pickedAsset],
      });
      render(<SettingsScreen />);

      await act(async () => {
        fireEvent.press(screen.getByText(IMPORT_BUTTON_LABEL));
      });

      await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(...IMPORT_FAILURE_ALERT));
    });
  });
});

describe('外観セクション(ライト/ダーク/端末に合わせるの切り替え)', () => {
  const APPEARANCE_SECTION_TITLE = '外観';
  const LIGHT_LABEL = 'ライト';
  const DARK_LABEL = 'ダーク';
  const SYSTEM_LABEL = '端末に合わせる';

  // `useThemePreference()`は`Provider`配下でない場合`setPreference`がno-opにフォールバックする
  // 仕様(tests/contexts/theme-preference-context.test.tsx参照)のため、実機と同じ構成を再現するために
  // 明示的に`ThemePreferenceProvider`でラップする。
  function renderSettingsScreen() {
    return render(
      <ThemePreferenceProvider>
        <SettingsScreen />
      </ThemePreferenceProvider>,
    );
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('renders the "外観" section with all 3 choices (ライト/ダーク/端末に合わせる) (操作導線の存在確認)', () => {
    renderSettingsScreen();

    expect(screen.getByText(APPEARANCE_SECTION_TITLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: LIGHT_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: DARK_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: SYSTEM_LABEL })).toBeTruthy();
  });

  it('selects "端末に合わせる" by default when nothing has been saved yet (正常系: 既定の選択状態)', () => {
    renderSettingsScreen();

    expect(screen.getByRole('button', { name: SYSTEM_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole('button', { name: LIGHT_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(screen.getByRole('button', { name: DARK_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('calls setPreference("light") (persists to AsyncStorage) and marks "ライト" as selected when pressed (正常系)', async () => {
    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: LIGHT_LABEL }));
    });

    expect(screen.getByRole('button', { name: LIGHT_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole('button', { name: DARK_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(screen.getByRole('button', { name: SYSTEM_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_STORAGE_KEY, 'light'),
    );
  });

  it('calls setPreference("dark") (persists to AsyncStorage) and marks "ダーク" as selected when pressed (正常系)', async () => {
    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: DARK_LABEL }));
    });

    expect(screen.getByRole('button', { name: DARK_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole('button', { name: LIGHT_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_STORAGE_KEY, 'dark'),
    );
  });

  it('switches selection back to "端末に合わせる" (system) when pressed after choosing an explicit theme (正常系: 端末に合わせるへの再切り替え)', async () => {
    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: LIGHT_LABEL }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: SYSTEM_LABEL }));
    });

    expect(screen.getByRole('button', { name: SYSTEM_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByRole('button', { name: LIGHT_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_STORAGE_KEY, 'system'),
    );
  });

  it('reflects a preference that was already saved in AsyncStorage as the selected choice on mount (正常系: 起動時の復元)', async () => {
    await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'dark');

    renderSettingsScreen();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: DARK_LABEL }).props.accessibilityState).toEqual(
        expect.objectContaining({ selected: true }),
      ),
    );
    expect(screen.getByRole('button', { name: SYSTEM_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('ignores an invalid value stored in AsyncStorage and keeps the default "端末に合わせる" selected (境界値: 不正な保存値)', async () => {
    await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'not-a-valid-preference');

    renderSettingsScreen();

    // 不正値のため読み込みが完了しても既定値のままである(意図的にawaitで少し待ってから確認する)
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: SYSTEM_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });

  it('keeps "ライト" selected in the UI (does not crash) even when AsyncStorage.setItem rejects (異常系: 保存失敗)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));

    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: LIGHT_LABEL }));
    });

    // 保存(永続化)に失敗しても、目の前の選択状態(見た目)は更新されたまま
    expect(screen.getByRole('button', { name: LIGHT_LABEL }).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });
});

describe('リマインダーセクション(日記を書く習慣化のためのリマインダー通知)', () => {
  const REMINDER_SECTION_TITLE = 'リマインダー';
  const REMINDER_TOGGLE_LABEL = '日記リマインダー通知';
  const HOUR_DECREASE_LABEL = '時を減らす';
  const HOUR_INCREASE_LABEL = '時を増やす';
  const MINUTE_DECREASE_LABEL = '分を減らす';
  const MINUTE_INCREASE_LABEL = '分を増やす';
  const FALLBACK_TEXT =
    '通知が許可されていないため、リマインダーを利用できません。端末の設定からこのアプリの通知を許可してください。';

  // `useDiaryReminder()`は`Provider`配下でない場合`setEnabled`/`setTime`がno-opにフォールバックする
  // 仕様(tests/contexts/diary-reminder-context.test.tsx参照)のため、実機と同じ構成を再現するために
  // 明示的に`DiaryReminderProvider`でラップする。
  function renderSettingsScreen() {
    return render(
      <DiaryReminderProvider>
        <SettingsScreen />
      </DiaryReminderProvider>,
    );
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue(
      'undetermined',
    );
    mockedDiaryReminderNotifications.requestReminderPermissionAsync.mockResolvedValue(
      'undetermined',
    );
    mockedDiaryReminderNotifications.scheduleDailyReminderAsync.mockResolvedValue(undefined);
    mockedDiaryReminderNotifications.cancelDailyReminderAsync.mockResolvedValue(undefined);
  });

  it('renders the "リマインダー" section with the toggle switch and time stepper, defaulting to OFF/21:00 (操作導線の存在確認・初期値)', () => {
    renderSettingsScreen();

    expect(screen.getByText(REMINDER_SECTION_TITLE)).toBeTruthy();
    const toggle = screen.getByLabelText(REMINDER_TOGGLE_LABEL);
    expect(toggle.props.value).toBe(false);
    expect(screen.getByText('21')).toBeTruthy();
    expect(screen.getByText('00')).toBeTruthy();
  });

  it('requests OS permission, turns ON, and schedules the reminder when the toggle is pressed while permission is undetermined and the user grants it (正常系: 未確認から許可)', async () => {
    mockedDiaryReminderNotifications.requestReminderPermissionAsync.mockResolvedValue('granted');
    renderSettingsScreen();

    await act(async () => {
      fireEvent(screen.getByLabelText(REMINDER_TOGGLE_LABEL), 'valueChange', true);
    });

    expect(mockedDiaryReminderNotifications.requestReminderPermissionAsync).toHaveBeenCalledTimes(
      1,
    );
    await waitFor(() =>
      expect(mockedDiaryReminderNotifications.scheduleDailyReminderAsync).toHaveBeenCalledWith(
        21,
        0,
      ),
    );
    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(true);
    expect(screen.queryByText(FALLBACK_TEXT)).toBeNull();
  });

  it('shows the fallback message and keeps the toggle OFF when the user denies the permission request (異常系: 未確認から拒否)', async () => {
    mockedDiaryReminderNotifications.requestReminderPermissionAsync.mockResolvedValue('denied');
    renderSettingsScreen();

    await act(async () => {
      fireEvent(screen.getByLabelText(REMINDER_TOGGLE_LABEL), 'valueChange', true);
    });

    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(false);
    await waitFor(() => expect(screen.getByText(FALLBACK_TEXT)).toBeTruthy());
    expect(mockedDiaryReminderNotifications.scheduleDailyReminderAsync).not.toHaveBeenCalled();
  });

  it('shows the fallback message on mount when the permission is already denied at the OS level (正常系: 起動時点で拒否済み)', async () => {
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('denied');
    renderSettingsScreen();

    await waitFor(() => expect(screen.getByText(FALLBACK_TEXT)).toBeTruthy());
  });

  it('does not show the fallback message when permission is undetermined or granted (境界値: フォールバック非表示のケース)', async () => {
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('granted');
    renderSettingsScreen();

    await waitFor(() =>
      expect(mockedDiaryReminderNotifications.getReminderPermissionStatusAsync).toHaveBeenCalled(),
    );
    expect(screen.queryByText(FALLBACK_TEXT)).toBeNull();
  });

  it('cancels the schedule and turns OFF when the toggle is pressed while ON (正常系: ON→OFF)', async () => {
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('granted');
    await AsyncStorage.setItem(
      DIARY_REMINDER_STORAGE_KEY,
      JSON.stringify({ enabled: true, hour: 21, minute: 0 }),
    );
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(true),
    );

    await act(async () => {
      fireEvent(screen.getByLabelText(REMINDER_TOGGLE_LABEL), 'valueChange', false);
    });

    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(false);
    await waitFor(() =>
      expect(mockedDiaryReminderNotifications.cancelDailyReminderAsync).toHaveBeenCalledTimes(1),
    );
  });

  it('increases/decreases the hour by 1 via the time stepper, wrapping around 0-23 (正常系・境界値: 時のステッパー)', async () => {
    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(HOUR_INCREASE_LABEL));
    });
    expect(screen.getByText('22')).toBeTruthy();

    // 実機の連続タップは別々の(同期)イベントとして届き、都度再描画が挟まるため、
    // それぞれを個別の`act`で包んで1回ずつ確実に反映させる
    await act(async () => {
      fireEvent.press(screen.getByLabelText(HOUR_DECREASE_LABEL));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText(HOUR_DECREASE_LABEL));
    });
    expect(screen.getByText('20')).toBeTruthy();
  });

  it('wraps the hour from 23 to 0 when increased past the maximum (境界値: 時の繰り上がり)', async () => {
    renderSettingsScreen();

    // 21時(既定値)から+3時間で0時に繰り上がることを確認する(21 -> 22 -> 23 -> 0)
    await act(async () => {
      fireEvent.press(screen.getByLabelText(HOUR_INCREASE_LABEL));
      fireEvent.press(screen.getByLabelText(HOUR_INCREASE_LABEL));
      fireEvent.press(screen.getByLabelText(HOUR_INCREASE_LABEL));
    });

    expect(screen.getByText('00')).toBeTruthy();
  });

  it('wraps the hour from 0 to 23 when decreased past the minimum (境界値: 時の繰り下がり)', async () => {
    renderSettingsScreen();

    // 21時(既定値)から-21時間で0時、さらに-1でと23時に繰り下がることを確認する
    for (let i = 0; i < 22; i += 1) {
      await act(async () => {
        fireEvent.press(screen.getByLabelText(HOUR_DECREASE_LABEL));
      });
    }

    expect(screen.getByText('23')).toBeTruthy();
  });

  it('increases/decreases the minute by 5 via the time stepper, wrapping around 0-59 (正常系・境界値: 分のステッパー)', async () => {
    renderSettingsScreen();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(MINUTE_INCREASE_LABEL));
    });
    expect(screen.getByText('05')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(MINUTE_DECREASE_LABEL));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText(MINUTE_DECREASE_LABEL));
    });
    // 0分から-5分で55分に繰り下がる
    expect(screen.getByText('55')).toBeTruthy();
  });

  it('re-schedules the reminder with the new time via AsyncStorage persistence when ON and permission is granted (正常系: 通知許可済みでの時刻変更)', async () => {
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('granted');
    await AsyncStorage.setItem(
      DIARY_REMINDER_STORAGE_KEY,
      JSON.stringify({ enabled: true, hour: 21, minute: 0 }),
    );
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(true),
    );
    jest.clearAllMocks();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(HOUR_INCREASE_LABEL));
    });

    await waitFor(() =>
      expect(mockedDiaryReminderNotifications.scheduleDailyReminderAsync).toHaveBeenCalledWith(
        22,
        0,
      ),
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DIARY_REMINDER_STORAGE_KEY,
        JSON.stringify({ enabled: true, hour: 22, minute: 0 }),
      ),
    );
  });

  it('disables the toggle and time steppers while the ON/OFF switch is being processed, to prevent duplicate taps (境界値: 連続タップ防止)', async () => {
    // `setEnabled`が完了するまで解決しないPromiseにして、処理中の一瞬の状態を検証する
    let resolveRequestPermission: (status: string) => void = () => {};
    mockedDiaryReminderNotifications.requestReminderPermissionAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveRequestPermission = resolve;
      }),
    );
    renderSettingsScreen();

    act(() => {
      fireEvent(screen.getByLabelText(REMINDER_TOGGLE_LABEL), 'valueChange', true);
    });

    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.disabled).toBe(true);
    // Switch(RCTSwitch)は`disabled`propをそのまま持つが、`Pressable`ベースのステッパーボタンは
    // `accessibilityState.disabled`として反映される
    expect(screen.getByLabelText(HOUR_INCREASE_LABEL).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText(MINUTE_INCREASE_LABEL).props.accessibilityState.disabled).toBe(
      true,
    );

    await act(async () => {
      resolveRequestPermission('granted');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.disabled).toBe(false);
    expect(screen.getByLabelText(HOUR_INCREASE_LABEL).props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it('shows a failure alert and reverts the toggle to OFF when scheduling the reminder fails even though permission is granted (異常系: 通知登録失敗時のフィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockedDiaryReminderNotifications.requestReminderPermissionAsync.mockResolvedValue('granted');
    mockedDiaryReminderNotifications.scheduleDailyReminderAsync.mockRejectedValue(
      new Error('schedule error'),
    );
    renderSettingsScreen();

    await act(async () => {
      fireEvent(screen.getByLabelText(REMINDER_TOGGLE_LABEL), 'valueChange', true);
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'リマインダーの設定に失敗しました',
        '通知を設定できませんでした。もう一度お試しください。',
      ),
    );
    // 通知の登録に失敗しているため、見た目上もONに確定させずOFFへ戻す
    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(false);
    // 連続タップ防止用の無効化状態も、失敗を経て正しく解除されている
    expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.disabled).toBe(false);
  });

  it('restores a previously saved ON/time setting from AsyncStorage on mount (正常系: 起動時の復元)', async () => {
    mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('granted');
    await AsyncStorage.setItem(
      DIARY_REMINDER_STORAGE_KEY,
      JSON.stringify({ enabled: true, hour: 6, minute: 30 }),
    );

    renderSettingsScreen();

    await waitFor(() =>
      expect(screen.getByLabelText(REMINDER_TOGGLE_LABEL).props.value).toBe(true),
    );
    expect(screen.getByText('06')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
  });

  // 通知未許可時のフォールバック文言の文字色も、削除ボタンと同様に
  // 固定のライトモード用エラー色ではなく、useThemeColor経由でライト/ダークそれぞれの
  // テーマに応じた色が適用されることを確認する回帰テスト。
  describe('ダークモード対応(フォールバック文言の文字色)', () => {
    // このブロックだけは配色切り替えの検証も必要なため、`DiaryReminderProvider`に加えて
    // `ThemePreferenceProvider`でもラップする(実機では`app/_layout.tsx`の`RootLayout`が
    // 両方でラップしている)。
    function renderSettingsScreenWithThemePreference() {
      return render(
        <ThemePreferenceProvider>
          <DiaryReminderProvider>
            <SettingsScreen />
          </DiaryReminderProvider>
        </ThemePreferenceProvider>,
      );
    }

    it('uses the light theme error color (not a hardcoded value) when the theme preference is light (正常系: ライトモード)', async () => {
      mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('denied');
      await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'light');
      renderSettingsScreenWithThemePreference();

      await waitFor(() => {
        const flattenedStyle = StyleSheet.flatten(screen.getByText(FALLBACK_TEXT).props.style);
        expect(flattenedStyle.color).toBe(Colors.light.error);
      });
    });

    it('uses the dark theme error color (not the light-mode hardcoded value) when the theme preference is dark (正常系: ダークモード)', async () => {
      mockedDiaryReminderNotifications.getReminderPermissionStatusAsync.mockResolvedValue('denied');
      await AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'dark');
      renderSettingsScreenWithThemePreference();

      await waitFor(() => {
        const flattenedStyle = StyleSheet.flatten(screen.getByText(FALLBACK_TEXT).props.style);
        expect(flattenedStyle.color).toBe(Colors.dark.error);
      });
      // ライトモード用の固定色が使われていないことも明示的に確認する
      const flattenedStyle = StyleSheet.flatten(screen.getByText(FALLBACK_TEXT).props.style);
      expect(flattenedStyle.color).not.toBe(Colors.light.error);
    });
  });
});

describe('アプリロックセクション(生体認証によるアプリロック #155)', () => {
  const APP_LOCK_SECTION_TITLE = 'アプリロック';
  const APP_LOCK_TOGGLE_LABEL = 'アプリロック';
  const UNSUPPORTED_TEXT =
    'この端末では生体認証・パスコードが設定されていないため、アプリロックを利用できません。';

  // `useAppLock()`は`Provider`配下でない場合`setEnabled`がno-opにフォールバックする仕様
  // (tests/contexts/app-lock-context.test.tsx参照)のため、実機と同じ構成を再現するために
  // 明示的に`AppLockProvider`でラップする。
  function renderSettingsScreen() {
    return render(
      <AppLockProvider>
        <SettingsScreen />
      </AppLockProvider>,
    );
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedAppLockAuthentication.isAppLockSupportedAsync.mockResolvedValue(true);
    mockedAppLockAuthentication.authenticateForAppLockAsync.mockResolvedValue(true);
  });

  it('renders the "アプリロック" section with the toggle, defaulting to OFF (操作導線の存在確認・初期値)', async () => {
    renderSettingsScreen();

    expect(screen.getByText(APP_LOCK_SECTION_TITLE)).toBeTruthy();
    const toggle = screen.getByLabelText(APP_LOCK_TOGGLE_LABEL);
    expect(toggle.props.value).toBe(false);
    // 対応端末かどうかの判定が完了するまでは無効化されているため、明示的に待つ
    await waitFor(() => expect(toggle.props.disabled).toBe(false));
  });

  it('persists ON via AsyncStorage when the toggle is pressed on a supported device (正常系: ON)', async () => {
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(false),
    );

    await act(async () => {
      fireEvent(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL), 'valueChange', true);
    });

    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.value).toBe(true);
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith('app-lock-enabled', 'true'),
    );
  });

  it('persists OFF via AsyncStorage when the toggle is pressed while ON (正常系: ON→OFF)', async () => {
    await AsyncStorage.setItem('app-lock-enabled', 'true');
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.value).toBe(true),
    );

    await act(async () => {
      fireEvent(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL), 'valueChange', false);
    });

    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.value).toBe(false);
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenLastCalledWith('app-lock-enabled', 'false'),
    );
  });

  it('disables the toggle and shows the unsupported message when the device has no biometrics/passcode enrolled (異常系: 非対応端末)', async () => {
    mockedAppLockAuthentication.isAppLockSupportedAsync.mockResolvedValue(false);
    renderSettingsScreen();

    await waitFor(() => expect(screen.getByText(UNSUPPORTED_TEXT)).toBeTruthy());
    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(true);
  });

  it('does not show the unsupported message on a supported device (境界値: 対応端末では非表示)', async () => {
    renderSettingsScreen();

    await waitFor(() =>
      expect(mockedAppLockAuthentication.isAppLockSupportedAsync).toHaveBeenCalled(),
    );
    expect(screen.queryByText(UNSUPPORTED_TEXT)).toBeNull();
  });

  it('disables the toggle while the ON/OFF switch is being persisted, to prevent duplicate taps (境界値: 連続タップ防止)', async () => {
    let resolveSetItem: () => void = () => {};
    // `mockReturnValue`(永続的な上書き)ではなく`mockReturnValueOnce`を使う。前者だと
    // `jest.clearAllMocks()`(呼び出し履歴のクリアのみで実装はクリアされない)では戻らず、
    // 後続テストにまで「setItemが永遠に解決しないPromise」が漏れてしまう
    // (tests/contexts/diary-reminder-context.test.tsxの同種の注意書きを参照)。
    jest.spyOn(AsyncStorage, 'setItem').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSetItem = () => resolve(undefined);
      }),
    );
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(false),
    );

    act(() => {
      fireEvent(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL), 'valueChange', true);
    });

    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(true);

    await act(async () => {
      resolveSetItem();
      await Promise.resolve();
    });

    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(false);
  });

  it('restores a previously saved ON setting from AsyncStorage on mount (正常系: 起動時の復元)', async () => {
    await AsyncStorage.setItem('app-lock-enabled', 'true');

    renderSettingsScreen();

    await waitFor(() =>
      expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.value).toBe(true),
    );
  });

  // Issue #230: 永続化失敗時にスイッチの表示がONのまま(実際には保存されていない)になり、
  // かつ未処理のPromise rejectionが発生していた不具合の回帰テスト。
  // リマインダーセクションの同種テスト(異常系: 通知登録失敗時のフィードバック)と
  // 同じパターン・粒度で検証する。
  it('shows a failure alert and reverts the toggle to OFF when AsyncStorage.setItem fails (異常系: 永続化失敗時のロールバック・フィードバック)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage write error'));
    renderSettingsScreen();
    await waitFor(() =>
      expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(false),
    );

    await act(async () => {
      fireEvent(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL), 'valueChange', true);
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'アプリロックの設定に失敗しました',
        '設定を保存できませんでした。もう一度お試しください。',
      ),
    );
    // 永続化に失敗しているため、見た目上もONに確定させず呼び出し前のOFFへ戻す
    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.value).toBe(false);
    // 連続タップ防止用の無効化状態も、失敗を経て正しく解除されている
    expect(screen.getByLabelText(APP_LOCK_TOGGLE_LABEL).props.disabled).toBe(false);
  });
});
