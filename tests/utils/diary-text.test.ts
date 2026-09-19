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
});
