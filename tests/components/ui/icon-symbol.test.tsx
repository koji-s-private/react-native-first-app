import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { IconSymbol } from '@/components/ui/icon-symbol';

// jest-expo(react-native)のhasteはデフォルトプラットフォームが'ios'のため、拡張子を指定しない
// `@/components/ui/icon-symbol`は`icon-symbol.ios.tsx`(expo-symbolsのSymbolViewをそのまま使う版)に
// 解決される。これはアプリ本体(app/(tabs)/index.tsxなど)が実際にimportしているのと同じ経路であり、
// tests/app/index.test.tsxのIconSymbol関連のアサーションもこちらを経由している
describe('IconSymbol (iOS版, expo-symbolsのSymbolViewを直接使う)', () => {
  it('passes the given name through to the native SF Symbol without any mapping', () => {
    render(<IconSymbol name="chevron.down" color="#000000" />);

    const [icon] = screen.UNSAFE_getAllByType(IconSymbol);
    expect(icon.props.name).toBe('chevron.down');
  });

  it.each(['chevron.left', 'chevron.right', 'house.fill', 'gearshape.fill'] as const)(
    'passes name="%s" through unchanged',
    (name) => {
      render(<IconSymbol name={name} color="#000000" />);

      const [icon] = screen.UNSAFE_getAllByType(IconSymbol);
      expect(icon.props.name).toBe(name);
    },
  );
});

// Android/Web用のフォールバック実装(icon-symbol.tsx、MaterialIconsへの手動マッピングを持つ)は、
// 上記iOS版とファイル名の拡張子(.tsx vs .ios.tsx)でしか区別されないため、hasteのプラットフォーム
// 解決を明示的に迂回して`.tsx`を直接requireする(静的importだと拡張子付き指定がTSエラーになるため
// `require`を使う)。またこのファイルは`@expo/vector-icons/MaterialIcons`経由でexpo-font/expo-asset
// 連鎖を読み込むが、`expo-asset`はこのプロジェクトの依存関係に含まれておらず解決に失敗するため、
// 実体を単純なモックに差し替えてからrequireする
jest.mock('@expo/vector-icons/MaterialIcons', () => 'MaterialIcons');

const { IconSymbol: IconSymbolFallback } =
  require('@/components/ui/icon-symbol.tsx') as typeof import('@/components/ui/icon-symbol'); // eslint-disable-line @typescript-eslint/no-require-imports -- 上記コメント参照

describe('IconSymbol (Android/Web版フォールバック, MaterialIconsへのマッピングを使う)', () => {
  it.each([
    ['chevron.left.forwardslash.chevron.right', 'code'],
    ['chevron.left', 'chevron-left'],
    ['chevron.right', 'chevron-right'],
    ['chevron.down', 'expand-more'],
    ['house.fill', 'home'],
    ['paperplane.fill', 'send'],
    ['gearshape.fill', 'settings'],
  ] as const)(
    'maps SF Symbol name "%s" to MaterialIcons name "%s"',
    (sfSymbolName, materialIconName) => {
      render(<IconSymbolFallback name={sfSymbolName} color="#000000" />);

      const materialIcon = screen.UNSAFE_root.findByProps({ name: materialIconName });
      expect(materialIcon).toBeTruthy();
    },
  );

  it('forwards the size and color props to the underlying MaterialIcons element', () => {
    render(<IconSymbolFallback name="chevron.down" color="#ff0000" size={32} />);

    const materialIcon = screen.UNSAFE_root.findByProps({ name: 'expand-more' });
    expect(materialIcon.props.size).toBe(32);
    expect(materialIcon.props.color).toBe('#ff0000');
  });

  it('defaults size to 24 when not specified (boundary)', () => {
    render(<IconSymbolFallback name="house.fill" color="#000000" />);

    const materialIcon = screen.UNSAFE_root.findByProps({ name: 'home' });
    expect(materialIcon.props.size).toBe(24);
  });
});
