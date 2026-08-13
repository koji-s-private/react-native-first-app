import { useColorScheme as useRNColorScheme } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

// ネイティブ(iOS/Android)向けの`useColorScheme`はreact-native標準のフックをそのまま
// re-exportしているだけであることを確認する(独自ロジックは持たない)
describe('useColorScheme (native)', () => {
  it('is the exact same function as react-native useColorScheme (plain re-export, no wrapping)', () => {
    expect(useColorScheme).toBe(useRNColorScheme);
  });
});
