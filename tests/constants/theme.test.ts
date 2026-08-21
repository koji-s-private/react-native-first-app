import { Colors } from '@/constants/theme';

// '#'に続き3桁または6桁の16進数からなるカラーコードかどうかを判定する
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

describe('Colors.error (Issue #58: エラーメッセージ色のテーマ定数化)', () => {
  it('defines a valid hex color for light mode', () => {
    expect(Colors.light.error).toMatch(HEX_COLOR_PATTERN);
  });

  it('defines a valid hex color for dark mode', () => {
    expect(Colors.dark.error).toMatch(HEX_COLOR_PATTERN);
  });

  it('uses a different value from light mode, so dark mode keeps sufficient contrast against its darker background', () => {
    expect(Colors.dark.error).not.toBe(Colors.light.error);
  });

  it('matches the specific values chosen for Issue #58', () => {
    expect(Colors.light.error).toBe('#d32f2f');
    expect(Colors.dark.error).toBe('#ff6b6b');
  });
});

describe('Colors.link (Issue #153: ダークモードでリンク色のコントラストが不足する問題の修正)', () => {
  it('defines a valid hex color for light mode', () => {
    expect(Colors.light.link).toMatch(HEX_COLOR_PATTERN);
  });

  it('defines a valid hex color for dark mode', () => {
    expect(Colors.dark.link).toMatch(HEX_COLOR_PATTERN);
  });

  it('uses a different value from light mode, so dark mode keeps sufficient contrast against its darker background', () => {
    expect(Colors.dark.link).not.toBe(Colors.light.link);
  });

  it('matches the specific values chosen for Issue #153', () => {
    expect(Colors.light.link).toBe('#0a7ea4');
    expect(Colors.dark.link).toBe('#5AC8FA');
  });
});
