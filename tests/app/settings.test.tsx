import { render, screen, within } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { Text } from 'react-native';

import SettingsScreen from '@/app/(tabs)/settings';
import { SETTINGS_SECTIONS } from '@/constants/settings-menu';

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
