import {
  ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH,
  BODY_MAX_LENGTH,
  splitIntoGraphemes,
  truncateForAccessibilityLabel,
  truncateToBodyMaxLength,
} from '@/utils/diary-text';

describe('splitIntoGraphemes', () => {
  it('splits plain ASCII text into one grapheme per character (正常系)', () => {
    expect(splitIntoGraphemes('abc')).toEqual(['a', 'b', 'c']);
  });

  it('counts a ZWJ-joined family emoji as a single grapheme, not by UTF-16 code units (境界値)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    // UTF-16コードユニット単位では11だが、grapheme単位では1文字
    expect(familyEmoji.length).toBe(11);
    expect(splitIntoGraphemes(familyEmoji)).toHaveLength(1);
  });

  it('counts a surrogate-pair emoji as a single grapheme (境界値)', () => {
    const simpleEmoji = '😀';
    expect(simpleEmoji.length).toBe(2);
    expect(splitIntoGraphemes(simpleEmoji)).toHaveLength(1);
  });
});

describe('truncateToBodyMaxLength', () => {
  it('returns the text unchanged when it is within the limit (正常系)', () => {
    expect(truncateToBodyMaxLength('短い本文')).toBe('短い本文');
  });

  it('truncates text exceeding BODY_MAX_LENGTH to exactly the limit, grapheme-based (境界値)', () => {
    const overLimitText = 'あ'.repeat(BODY_MAX_LENGTH + 1);
    const truncated = truncateToBodyMaxLength(overLimitText);
    expect(splitIntoGraphemes(truncated)).toHaveLength(BODY_MAX_LENGTH);
    expect(truncated).toBe('あ'.repeat(BODY_MAX_LENGTH));
  });

  it('does not truncate text that is exactly at the limit (境界値)', () => {
    const exactlyMaxLength = 'あ'.repeat(BODY_MAX_LENGTH);
    expect(truncateToBodyMaxLength(exactlyMaxLength)).toBe(exactlyMaxLength);
  });

  it('does not split a ZWJ-joined family emoji in the middle when truncating (regression)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    const overLimitText = `${'あ'.repeat(BODY_MAX_LENGTH - 1)}${familyEmoji}${'あ'.repeat(10)}`;
    const truncated = truncateToBodyMaxLength(overLimitText);
    expect(truncated).toBe(`${'あ'.repeat(BODY_MAX_LENGTH - 1)}${familyEmoji}`);
  });
});

describe('truncateForAccessibilityLabel', () => {
  it('returns short text unchanged (正常系)', () => {
    expect(truncateForAccessibilityLabel('今日の出来事')).toBe('今日の出来事');
  });

  it('returns an empty string unchanged (境界値)', () => {
    expect(truncateForAccessibilityLabel('')).toBe('');
  });

  it('does not truncate text that is exactly at the limit (境界値)', () => {
    const exactlyMaxLength = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(truncateForAccessibilityLabel(exactlyMaxLength)).toBe(exactlyMaxLength);
  });

  it('truncates text one grapheme over the limit and appends an ellipsis (境界値)', () => {
    const overLimitText = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH + 1);
    expect(truncateForAccessibilityLabel(overLimitText)).toBe(
      `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH)}…`,
    );
  });

  it('counts by grapheme, so emoji-heavy text within the limit is not truncated even if its UTF-16 length exceeds the limit (境界値)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    const emojiText = familyEmoji.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(emojiText.length).toBeGreaterThan(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(truncateForAccessibilityLabel(emojiText)).toBe(emojiText);
  });

  it('does not split a ZWJ-joined family emoji in the middle when truncating (regression)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    const overLimitText = `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1)}${familyEmoji}${'あ'.repeat(10)}`;
    expect(truncateForAccessibilityLabel(overLimitText)).toBe(
      `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1)}${familyEmoji}…`,
    );
  });

  it('keeps whitespace-only text within the limit unchanged and truncates a longer one by grapheme count (境界値)', () => {
    const shortBlank = ' '.repeat(10);
    expect(truncateForAccessibilityLabel(shortBlank)).toBe(shortBlank);

    const longBlank = ' '.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH + 5);
    expect(truncateForAccessibilityLabel(longBlank)).toBe(
      `${' '.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH)}…`,
    );
  });

  it('preserves newlines within the limit and counts CRLF as a single grapheme (境界値)', () => {
    const multiLine = '一行目\n二行目\n三行目';
    expect(truncateForAccessibilityLabel(multiLine)).toBe(multiLine);

    // CRLFはコードユニットでは2だが書記素では1のため、50個並べても切り詰められない
    const crlfText = '\r\n'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(crlfText.length).toBeGreaterThan(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(truncateForAccessibilityLabel(crlfText)).toBe(crlfText);
  });

  it('truncates multi-line text exceeding the limit and keeps the newline characters before the cut (境界値)', () => {
    const line = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1);
    const text = `${line}\n${'い'.repeat(10)}`;
    expect(truncateForAccessibilityLabel(text)).toBe(`${line}\n…`);
  });

  it('does not split a regional-indicator flag emoji at the limit (境界値)', () => {
    const flag = '🇯🇵';
    expect(flag.length).toBe(4);
    const text = `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1)}${flag}${'あ'.repeat(5)}`;
    expect(truncateForAccessibilityLabel(text)).toBe(
      `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1)}${flag}…`,
    );
  });

  it('does not split an emoji with a variation selector or skin-tone modifier at the limit (境界値)', () => {
    const heart = '\u2764\uFE0F';
    const thumbsUp = '👍🏽';
    const prefix = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1);
    expect(truncateForAccessibilityLabel(`${prefix}${heart}あああ`)).toBe(`${prefix}${heart}…`);
    expect(truncateForAccessibilityLabel(`${prefix}${thumbsUp}あああ`)).toBe(
      `${prefix}${thumbsUp}…`,
    );
  });

  it('does not separate a combining voiced-sound mark from its base character at the limit (境界値)', () => {
    const decomposedGa = 'か\u3099';
    const prefix = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1);
    expect(truncateForAccessibilityLabel(`${prefix}${decomposedGa}あああ`)).toBe(
      `${prefix}${decomposedGa}…`,
    );
  });

  it('does not split a surrogate pair at the limit (境界値)', () => {
    const emoji = '😀';
    const prefix = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1);
    expect(truncateForAccessibilityLabel(`${prefix}${emoji}あああ`)).toBe(`${prefix}${emoji}…`);
  });

  it('does not truncate text whose grapheme count equals the limit even when it ends with a multi-code-unit grapheme (境界値)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    const text = `${'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1)}${familyEmoji}`;
    expect(text.length).toBeGreaterThan(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
    expect(truncateForAccessibilityLabel(text)).toBe(text);
  });

  describe('when Intl.Segmenter is unavailable', () => {
    const originalSegmenter = Intl.Segmenter;

    beforeEach(() => {
      Object.defineProperty(Intl, 'Segmenter', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(Intl, 'Segmenter', {
        value: originalSegmenter,
        configurable: true,
        writable: true,
      });
    });

    it('falls back to code point splitting so surrogate pairs are not broken (異常系: 環境依存)', () => {
      expect(typeof Intl.Segmenter).toBe('undefined');
      const emoji = '😀';
      const prefix = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH - 1);
      expect(truncateForAccessibilityLabel(`${prefix}${emoji}あああ`)).toBe(`${prefix}${emoji}…`);
    });

    it('still truncates plain text at the limit and leaves text at the limit unchanged (境界値)', () => {
      const exact = 'あ'.repeat(ACCESSIBILITY_LABEL_TEXT_MAX_LENGTH);
      expect(truncateForAccessibilityLabel(exact)).toBe(exact);
      expect(truncateForAccessibilityLabel(`${exact}あ`)).toBe(`${exact}…`);
    });
  });
});
