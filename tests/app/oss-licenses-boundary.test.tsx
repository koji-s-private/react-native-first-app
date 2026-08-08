import { render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';

import OssLicensesScreen from '@/app/oss-licenses';

// `expo-router`'s `Link` を他のテストファイルと同じ薄いモックに差し替える。
jest.mock('expo-router', () => {
  const PassThrough = ({ children }: PropsWithChildren) => children;

  const Link = PassThrough as unknown as typeof PassThrough & {
    Trigger: typeof PassThrough;
    Preview: () => null;
    Menu: typeof PassThrough;
    MenuAction: () => null;
  };
  function LinkPreview() {
    return null;
  }

  function LinkMenuAction() {
    return null;
  }

  Link.Trigger = PassThrough;
  Link.Preview = LinkPreview;
  Link.Menu = PassThrough;
  Link.MenuAction = LinkMenuAction;

  return { Link };
});

// `data/licenses.json` を境界値・異常系の検証用に少数のエントリへ差し替える。
// `jest.mock`のファクトリ呼び出しはBabelによって自動的にimport文より前へ巻き上げられるため、
// このファイル内での記述位置に関わらず、上のimportより先に評価される。
jest.mock('@/data/licenses.json', () => [
  // 通常のエントリ(リポジトリURLあり)。最小構成(1件のみ)の境界値も兼ねる。
  {
    name: 'single-lib',
    version: '1.0.0',
    license: 'MIT',
    repository: 'https://example.com/single-lib',
  },
  // `repository` フィールドが無いエントリ(異常系: 生成スクリプトがリポジトリ情報を
  // 取得できなかった場合を想定)。
  { name: 'no-repo-lib', version: '2.0.0', license: 'Apache-2.0' },
  // 別のエントリと同じライセンス種別を持つエントリ(名前・バージョンの取り違えが無いことの確認用)。
  {
    name: 'shared-license-lib',
    version: '3.0.0',
    license: 'MIT',
    repository: 'https://example.com/shared',
  },
]);

describe('OssLicensesScreen (境界値・異常系: モックデータ)', () => {
  it('renders a normal entry (with a repository link) correctly', () => {
    render(<OssLicensesScreen />);

    expect(screen.getByText('single-lib')).toBeTruthy();
    expect(screen.getByText('v1.0.0 ・ MIT')).toBeTruthy();
    expect(screen.getByText('https://example.com/single-lib')).toBeTruthy();
  });

  it('renders an entry without a repository field without crashing and without showing a link for it', () => {
    render(<OssLicensesScreen />);

    expect(screen.getByText('no-repo-lib')).toBeTruthy();
    expect(screen.getByText('v2.0.0 ・ Apache-2.0')).toBeTruthy();
    // repositoryが無いエントリにはExternalLink自体が描画されない
    expect(screen.queryByText('https://example.com/no-repo-lib')).toBeNull();
  });

  it('does not mix up names/versions between entries that share the same license type', () => {
    render(<OssLicensesScreen />);

    expect(screen.getByText('shared-license-lib')).toBeTruthy();
    expect(screen.getByText('v3.0.0 ・ MIT')).toBeTruthy();
    // "single-lib"(同じMITライセンス)と "shared-license-lib" のバージョン表示が
    // それぞれ独立して正しく紐づいている(取り違えていない)ことを確認する
    expect(screen.getByText('v1.0.0 ・ MIT')).toBeTruthy();
  });

  it('renders exactly as many repository links as entries that actually have a repository field (2 out of 3)', () => {
    render(<OssLicensesScreen />);

    expect(screen.queryAllByText(/^https:\/\/example\.com\//)).toHaveLength(2);
  });
});
