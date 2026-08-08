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

// `data/licenses.json` をライセンス一覧が0件の異常系(生成スクリプトが依存関係を
// 検出できなかった場合などを想定)として差し替える。
// `jest.mock`のファクトリ呼び出しはBabelによって自動的にimport文より前へ巻き上げられるため、
// このファイル内での記述位置に関わらず、上のimportより先に評価される。
jest.mock('@/data/licenses.json', () => []);

const DESCRIPTION_TEXT = 'このアプリは以下のオープンソースソフトウェア(OSS)を利用しています。';

describe('OssLicensesScreen (異常系: ライセンス一覧が空の場合)', () => {
  it('still shows the header description even when there are zero license entries', () => {
    render(<OssLicensesScreen />);

    expect(screen.getByText(DESCRIPTION_TEXT)).toBeTruthy();
  });

  it('renders no library name/version/license rows when the list is empty (boundary: 0 entries)', () => {
    render(<OssLicensesScreen />);

    // "v{version} ・ {license}" 形式のテキスト(各エントリの見出し直下に表示される)が
    // 1件も存在しないことで、リスト項目が描画されていないことを確認する。
    expect(screen.queryAllByText(/^v.+ ・ /)).toHaveLength(0);
  });
});
