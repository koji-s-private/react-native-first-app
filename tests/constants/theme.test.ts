import { Colors } from '@/constants/theme';

// '#'に続き3桁または6桁の16進数からなるカラーコードかどうかを判定する
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// WCAG 2.x で定義された相対輝度・コントラスト比の計算式。
// https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
function hexToRgb(hex: string): [number, number, number] {
  const normalized =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return [r, g, b];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

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

  it('meets the WCAG AA contrast ratio (4.5:1) against the light mode background', () => {
    expect(contrastRatio(Colors.light.link, Colors.light.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('meets the WCAG AA contrast ratio (4.5:1) against the dark mode background (Issue #153の主眼)', () => {
    expect(contrastRatio(Colors.dark.link, Colors.dark.background)).toBeGreaterThanOrEqual(4.5);
  });
});
