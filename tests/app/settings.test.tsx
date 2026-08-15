import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { Alert, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '@/app/(tabs)/settings';
import { TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID } from '@/components/tab-screen-container';
import { SETTINGS_SECTIONS } from '@/constants/settings-menu';
import { Colors } from '@/constants/theme';
import {
  DIARY_REMINDER_STORAGE_KEY,
  DiaryReminderProvider,
} from '@/contexts/diary-reminder-context';
import {
  THEME_PREFERENCE_STORAGE_KEY,
  ThemePreferenceProvider,
} from '@/contexts/theme-preference-context';
import { DIARY_ENTRIES_STORAGE_KEY } from '@/utils/diary-storage';

// 実機では`expo-router`の`ExpoRoot`が自動的に`SafeAreaProvider`で全体をラップするが、
// このテストでは`SettingsScreen`を単体でレンダリングするため、そのラップが存在しない。
// `useSafeAreaInsets`(内部で`TabScreenContainer`が利用する)は`SafeAreaProvider`配下でないと
// エラーを投げるため、`tests/app/index.test.tsx`と同様にライブラリ公式のjestモック
// (常にゼロインセットを返す)に差し替える。
jest.mock(
  'react-native-safe-area-context',
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('react-native-safe-area-context/jest/mock').default,
);

// `settings.tsx`は削除ボタンから`clearAllDiaryEntries`(内部で`AsyncStorage.removeItem`を呼ぶ)を
// 利用するようになったため、ネイティブの`AsyncStorage`モジュールが存在しないJest環境では
// `NativeModule: AsyncStorage is null`エラーになる。`tests/app/index.test.tsx`と同様、
// パッケージ公式のインメモリモックに差し替える。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `app/(tabs)/settings.tsx`は「リマインダー」セクション(Issue #92)から
// `contexts/diary-reminder-context.tsx`経由で`utils/diary-reminder-notifications.ts`
// (expo-notificationsの薄いラッパー)を利用する。実際のネイティブ通知APIを呼ばずに
// 許可リクエスト・スケジュール登録/キャンセルの呼び出しを検証できるよう、ラッパーごとモック化する
// (tests/utils/diary-reminder-notifications.test.ts、tests/contexts/diary-reminder-context.test.tsx
// で個別に検証済みのものを、画面からの結線確認のためにここでも薄く検証する)。
jest.mock('@/utils/diary-reminder-notifications', () => ({
  getReminderPermissionStatusAsync: jest.fn(() => Promise.resolve('undetermined')),
  requestReminderPermissionAsync: jest.fn(() => Promise.resolve('undetermined')),
  scheduleDailyReminderAsync: jest.fn(() => Promise.resolve()),
  cancelDailyReminderAsync: jest.fn(() => Promise.resolve()),
}));

// `expo-file-system/legacy`はJest環境ではネイティブモジュールが存在せず、`cacheDirectory`は
// 常に`null`になる(実機のiOS/Androidではキャッシュディレクトリのパス文字列が入る)。
// エクスポート機能の正常系(ファイル書き出し→共有)を検証するため、固定のパスと
// 書き込み成功を返すモックに差し替える。
//
// `cacheDirectory`は一部のテストで`null`に上書きしたいが、`import * as FileSystem`は
// Babelのwildcard importヘルパー(`_interopRequireWildcard`)によりファイルごとに別の
// namespaceオブジェクトへコピーされるため、単純な文字列プロパティのままだと
// このテストファイル側での代入が`app/(tabs)/settings.tsx`側のコピーには反映されない
// (関数プロパティは参照コピーのため影響を受けないが、プリミティブ値は値コピーになるため)。
// get/setアクセサとして定義し、実体を外側のクロージャ変数に持たせることで、
// どちらのファイルのコピーを経由しても同じ実体を読み書きできるようにしている。
jest.mock('expo-file-system/legacy', () => {
  const state: { cacheDirectory: string | null } = { cacheDirectory: 'file:///mock-cache/' };
  return {
    get cacheDirectory() {
      return state.cacheDirectory;
    },
    set cacheDirectory(value: string | null) {
      state.cacheDirectory = value;
    },
    writeAsStringAsync: jest.fn(() => Promise.resolve()),
  };
});

// `expo-sharing`もJest環境ではネイティブモジュールが存在せず、`isAvailableAsync`が常に`false`を
// 返す(=共有不可)実際の挙動になってしまうため、共有可能なケースをテストできるよう明示的にモックする。
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  shareAsync: jest.fn(() => Promise.resolve()),
}));

// `ExternalLink`(内部で`expo-router`の`Link`を使う)や`Link`自体は、実機ではナビゲーション/
// ルーターのコンテキストを必要とするため、画面を単体でレンダリングするこのテストでは利用できない。
// 他のテスト(`tests/app/oss-licenses.test.tsx`等)と同じくパススルーのモックに差し替えるが、
// このテストでは各リンクの`href`が正しいことも検証したいため、`href`を`testID`として
// 可視化する薄いモックにしている。
jest.mock('expo-router', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
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

    // 直接ThemedTextを描画確認するSmokeテスト
    expect(screen.UNSAFE_getAllByType(Text).length).toBeGreaterThan(0);
  });

  // Issue #125: 設定タブがステータスバー/ノッチ領域と重なる不具合の回帰テスト。
  // セーフエリア対応は共通コンポーネント`TabScreenContainer`に委ねているため、
  // ここではその外側ラッパーに正しくインセットが伝播していることのみを検証する。
  describe('セーフエリア対応(Issue #125: ステータスバー/ノッチ領域との重なり防止)', () => {
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

describe('日記データを全件削除ボタン(Issue #103: データ管理セクション)', () => {
  const DELETE_BUTTON_LABEL = '日記データを全件削除';
  const CONFIRM_DIALOG_TITLE = '日記データを削除しますか?';
  const CONFIRM_DIALOG_MESSAGE =
    'この端末に保存されているすべての日記データが削除されます。この操作は取り消せません。';

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  // Alert.alertは実機ではネイティブダイアログを表示するが、テスト環境では
  // jest.spyOnでモック化した上で、直近の呼び出しに渡されたボタン定義から
  // 指定ラベルのonPressを直接呼び出すことで「ユーザーがそのボタンをタップした」ことを模倣する。
  // onPress自体が状態更新を伴う非同期処理(handleDelete)を呼び出すため、actで包んで
  // Reactのバッチ更新がテスト側に反映されるのを待つ。
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

    // ダイアログを表示しただけの段階では削除処理はまだ呼ばれていない
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('deletes nothing when the cancel button is pressed (キャンセル時は削除されない)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    await pressAlertButton('キャンセル');

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    // AsyncStorage上のデータもそのまま残っている
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBe(
      'encrypted:v1:dummy-payload',
    );
  });

  it('deletes all diary data from AsyncStorage and shows a completion alert once confirmed (正常系: 削除の実行と完了通知)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // 削除前に実際に日記データが保存されている状態を用意する
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, 'encrypted:v1:dummy-payload');
    render(<SettingsScreen />);

    fireEvent.press(screen.getByText(DELETE_BUTTON_LABEL));
    await pressAlertButton('削除する');

    await waitFor(() =>
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DIARY_ENTRIES_STORAGE_KEY),
    );
    // 受け入れ条件: 削除後、AsyncStorageから該当データが実際に消えていること
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

  // Issue #146: 削除ボタンの文字色が固定のライトモード用エラー色のままダークモードでも
  // 使われてしまっていた不具合の回帰テスト。app/(tabs)/index.tsxと同様に
  // useThemeColor({}, 'error')経由でライト/ダークそれぞれのテーマに応じた色が
  // 適用されることを確認する。
  describe('ダークモード対応(Issue #146: 削除ボタンの文字色)', () => {
    // 実機では`app/_layout.tsx`の`RootLayout`が全画面を`ThemePreferenceProvider`でラップするが、
    // このテストでは`SettingsScreen`を単体でレンダリングするため、そのラップが存在しない。
    // 配色の切り替えを検証するため、外観セクションのテストと同様に明示的にラップする。
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

describe('日記データをエクスポートボタン(Issue #51: データ管理セクション)', () => {
  const EXPORT_BUTTON_LABEL = '日記データをエクスポート';
  const sampleEntriesJson = JSON.stringify([
    { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
  ]);

  const originalPlatformOS = Platform.OS;

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    // 各テストごとにモックの既定挙動をリセットする(個別のテストで上書きするため)
    (FileSystem as unknown as { cacheDirectory: string | null }).cacheDirectory =
      'file:///mock-cache/';
    (FileSystem.writeAsStringAsync as jest.Mock).mockResolvedValue(undefined);
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
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
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

    await waitFor(() => expect(FileSystem.writeAsStringAsync).toHaveBeenCalledTimes(1));
    const [fileUri, content] = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0];
    expect(fileUri).toMatch(/^file:\/\/\/mock-cache\/diary-export-\d{8}-\d{6}\.json$/);
    expect(JSON.parse(content)).toEqual(JSON.parse(sampleEntriesJson));

    await waitFor(() => expect(Sharing.isAvailableAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(Sharing.shareAsync).toHaveBeenCalledWith(fileUri, {
      mimeType: 'application/json',
      dialogTitle: '日記データをエクスポート',
      UTI: 'public.json',
    });

    // 失敗系のAlertは呼ばれていないこと
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
    (FileSystem.writeAsStringAsync as jest.Mock).mockRejectedValue(new Error('disk full'));
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

  it('shows a failure alert when the cache directory is unavailable (境界値: FileSystem.cacheDirectoryがnull)', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.setItem(DIARY_ENTRIES_STORAGE_KEY, sampleEntriesJson);
    (FileSystem as unknown as { cacheDirectory: string | null }).cacheDirectory = null;
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
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  describe('Web版(Platform.OS === "web")', () => {
    // Webはexpo-file-system/expo-sharingの双方に対応していないため、実装はBlob + <a download>による
    // ブラウザ標準ダウンロードにフォールバックする。Jest環境(Node)には`document`が存在しないため、
    // `click`呼び出しを検証できる最小限のモックを用意する。
    // また、`URL.createObjectURL`/`revokeObjectURL`はexpoがJestにも登録するポリフィル
    // (expo/src/winter/url.ts)に差し替わっており、実機のネイティブ`BlobModule`を前提とするため
    // Jest環境でそのまま呼ぶと`Cannot read properties of undefined (reading 'BlobModule')`で
    // 例外になる。ブラウザの実際の挙動を模した最小限のモックに差し替える。
    let createdAnchor: { href: string; download: string; click: jest.Mock };
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    beforeEach(() => {
      Platform.OS = 'web';
      createdAnchor = { href: '', download: '', click: jest.fn() };
      (global as unknown as { document: Document }).document = {
        createElement: jest.fn(() => createdAnchor),
      } as unknown as Document;
      URL.createObjectURL = jest.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = jest.fn();
    });

    afterEach(() => {
      delete (global as unknown as { document?: Document }).document;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
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
      expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
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

describe('外観セクション(Issue #91: ライト/ダーク/端末に合わせるの切り替え)', () => {
  const APPEARANCE_SECTION_TITLE = '外観';
  const LIGHT_LABEL = 'ライト';
  const DARK_LABEL = 'ダーク';
  const SYSTEM_LABEL = '端末に合わせる';

  // 実機では`app/_layout.tsx`の`RootLayout`が全画面を`ThemePreferenceProvider`でラップするが、
  // このテストでは`SettingsScreen`を単体でレンダリングするため、そのラップが存在しない。
  // `useThemePreference()`は`Provider`配下でない場合`setPreference`がno-opにフォールバックする
  // 仕様(tests/contexts/theme-preference-context.test.tsx参照)のため、ここでは実機と同じ構成を
  // 再現するために明示的に`ThemePreferenceProvider`でラップする。
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

describe('リマインダーセクション(Issue #92: 日記を書く習慣化のためのリマインダー通知)', () => {
  const REMINDER_SECTION_TITLE = 'リマインダー';
  const REMINDER_TOGGLE_LABEL = '日記リマインダー通知';
  const HOUR_DECREASE_LABEL = '時を減らす';
  const HOUR_INCREASE_LABEL = '時を増やす';
  const MINUTE_DECREASE_LABEL = '分を減らす';
  const MINUTE_INCREASE_LABEL = '分を増やす';
  const FALLBACK_TEXT =
    '通知が許可されていないため、リマインダーを利用できません。端末の設定からこのアプリの通知を許可してください。';

  // 実機では`app/_layout.tsx`の`RootLayout`が全画面を`DiaryReminderProvider`でラップするが、
  // このテストでは`SettingsScreen`を単体でレンダリングするため、そのラップが存在しない。
  // `useDiaryReminder()`は`Provider`配下でない場合`setEnabled`/`setTime`がno-opにフォールバックする
  // 仕様(tests/contexts/diary-reminder-context.test.tsx参照)のため、ここでは実機と同じ構成を
  // 再現するために明示的に`DiaryReminderProvider`でラップする。
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

    // 実機の連続タップは別々の(同期)イベントとして届き、都度再描画が挟まるため、
    // それぞれを個別の`act`で包んで1回ずつ確実に反映させる
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

  // Issue #146: 通知未許可時のフォールバック文言の文字色も、削除ボタンと同様に
  // 固定のライトモード用エラー色ではなく、useThemeColor経由でライト/ダークそれぞれの
  // テーマに応じた色が適用されることを確認する回帰テスト。
  describe('ダークモード対応(Issue #146: フォールバック文言の文字色)', () => {
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
