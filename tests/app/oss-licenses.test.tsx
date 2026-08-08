import { render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import React from 'react';
import { FlatList } from 'react-native';

import OssLicensesScreen from '@/app/oss-licenses';
import licenses from '@/data/licenses.json';

type LicenseEntry = {
  name: string;
  version: string;
  license: string;
  repository?: string;
};

const licenseEntries = licenses as LicenseEntry[];

// `expo-router`'s `Link` (with its `Trigger`/`Preview`/`Menu` compound API) requires a
// navigation/router context that isn't set up when rendering the screen in isolation.
// We stub it out with simple pass-through components so the screen's own content can be
// asserted without pulling in the whole router (他のテストファイルと同じパターン)。
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

const DESCRIPTION_TEXT = 'このアプリは以下のオープンソースソフトウェア(OSS)を利用しています。';

describe('OssLicensesScreen (実データ: data/licenses.json)', () => {
  it('renders the header description explaining the screen purpose', () => {
    render(<OssLicensesScreen />);

    expect(screen.getByText(DESCRIPTION_TEXT)).toBeTruthy();
  });

  it('renders the first entries of the (alphabetically sorted) license list, including "expo" itself, with name/version/license and a repository link', () => {
    render(<OssLicensesScreen />);

    // FlatListは既定でinitialNumToRender(10件程度)分しか初期描画しないため、
    // 先頭付近(アルファベット順で早い)のエントリだけを対象に検証する。
    // "expo"自体は実データ内で7番目のため、初期描画に含まれる。
    const expoEntry = licenseEntries.find((entry) => entry.name === 'expo');
    expect(expoEntry).toBeDefined();

    expect(screen.getByText('expo')).toBeTruthy();
    expect(screen.getByText(`v${expoEntry?.version} ・ ${expoEntry?.license}`)).toBeTruthy();
    // 複数のexpo系パッケージが同じリポジトリURL(https://github.com/expo/expo)を
    // 共有しているため、一意性を求めるgetByTextではなく「少なくとも1件表示されている」ことを確認する
    expect(screen.queryAllByText(expoEntry?.repository ?? '').length).toBeGreaterThan(0);
  });

  it('passes every license entry to the FlatList as data, so items outside the initial render window (e.g. "react-native") are not silently dropped', () => {
    render(<OssLicensesScreen />);

    const list = screen.UNSAFE_getByType(FlatList);
    // 初期描画には含まれないエントリ(例: react-native)も含めて、
    // FlatListのdataプロパティ自体には全件が渡っていることを確認する。
    expect(list.props.data).toEqual(licenseEntries);

    const reactNativeEntry = licenseEntries.find((entry) => entry.name === 'react-native');
    expect(reactNativeEntry).toBeDefined();
  });

  it("correctly renders the off-screen \"react-native\" entry's name/version/license/repository link via the FlatList's own renderItem (independent of FlatList's virtualization window)", () => {
    render(<OssLicensesScreen />);

    const list = screen.UNSAFE_getByType(FlatList);
    const reactNativeEntry = licenseEntries.find((entry) => entry.name === 'react-native');
    expect(reactNativeEntry).toBeDefined();

    // renderItemを直接呼び出し、実際にリストへ渡されている関数がreact-nativeの
    // エントリを正しくレンダリングできることを検証する。
    // (テスト環境ではFlatListの仮想化がonLayout/onScroll等のネイティブイベントに
    // 依存しており、スクロールのシミュレートでは後方の項目を決定的に描画できないため、
    // この方法を採用している)
    render(list.props.renderItem({ item: reactNativeEntry, index: 0, separators: {} } as never));

    expect(screen.getByText('react-native')).toBeTruthy();
    expect(
      screen.getByText(`v${reactNativeEntry?.version} ・ ${reactNativeEntry?.license}`),
    ).toBeTruthy();
    expect(screen.getByText(reactNativeEntry?.repository ?? '')).toBeTruthy();
  });

  it('includes the major dependency libraries (accept criteria: expo/react-native関連等のライセンスが表示される) with required fields populated', () => {
    for (const entry of licenseEntries) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.license.length).toBeGreaterThan(0);
    }

    const names = licenseEntries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['expo', 'react', 'react-native', 'expo-router']));
  });
});
