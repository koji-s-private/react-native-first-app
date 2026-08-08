import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { Alert, Text } from 'react-native';

import SettingsScreen from '@/app/(tabs)/settings';
import { SETTINGS_SECTIONS } from '@/constants/settings-menu';
import { DIARY_ENTRIES_STORAGE_KEY } from '@/utils/diary-storage';

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
    expect(await AsyncStorage.getItem(DIARY_ENTRIES_STORAGE_KEY)).toBe('encrypted:v1:dummy-payload');
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
      expect(Alert.alert).toHaveBeenLastCalledWith('削除に失敗しました', 'もう一度お試しください。'),
    );
  });
});
