import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useDraftAutoSave } from '@/hooks/use-draft-auto-save';
import { useDraftRestore } from '@/hooks/use-draft-restore';
import { useModalSlideTransition } from '@/hooks/use-modal-slide-transition';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { useThemeColor } from '@/hooks/use-theme-color';
import { formatDateHeading } from '@/utils/diary-date';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';

const MODAL_MAX_HEIGHT_RATIO = 0.7;
const INPUT_MIN_HEIGHT = 80;
const INPUT_MAX_HEIGHT_RATIO = 0.35;

export type DiaryEntryComposerModalProps = {
  /** 対象日付('YYYY-MM-DD')。nullの間はモーダルを閉じた状態にする */
  dateKey: string | null;
  /** 下書き自動保存のAsyncStorageキー接頭辞(実際のキーはこれ+対象日付)。
   * 同一日付でも呼び出し画面ごとに下書きが混ざらないよう、画面ごとに別の接頭辞を渡す */
  draftStorageKeyPrefix: string;
  /** モーダルコンテンツ下端のpaddingBottom。タブバーの有無など呼び出し画面によって必要な余白が異なる */
  contentBottomPadding: number;
  /** 保存本体。trim済みの本文を受け取り、DiaryEntryの組み立てと永続化・状態更新を呼び出し側で行う */
  persist: (trimmedText: string) => Promise<void>;
  /** 保存成功時に呼ばれる(下書きの自動保存キーは本コンポーネント側で削除済み) */
  onSaved: () => void;
  /** 保存失敗時に呼ばれる(楽観的更新のロールバック等) */
  onSaveError?: () => void;
  /** モーダルを閉じる(キャンセル確定・保存成功後の両方で呼ぶ)。対象日付をnullに戻すのは呼び出し側の責務 */
  onClose: () => void;
};

// 対象日付の日記を新規登録するモーダル(アニメーション・下書き自動保存・文字数上限つき)。
// ホーム画面・日別一覧画面で同じ入力体験を共有するための共通コンポーネント
export function DiaryEntryComposerModal({
  dateKey,
  draftStorageKeyPrefix,
  contentBottomPadding,
  persist,
  onSaved,
  onSaveError,
  onClose,
}: DiaryEntryComposerModalProps) {
  const [draft, setDraft] = useState('');
  const [inputContentHeight, setInputContentHeight] = useState(0);
  const draftEditRevisionRef = useRef(0);
  // アンマウント後にstate更新を行わないようにするためのフラグ。保存処理の完了を待つ間に
  // 呼び出し画面側の遷移でアンマウントされ得るため、useSaveDiaryEntryへ渡して安全性を確保する
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const { isSaving, error, setError, save } = useSaveDiaryEntry();

  const transition = useModalSlideTransition(dateKey !== null);
  const { height: windowHeight } = useWindowDimensions();

  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  const draftKey = dateKey ? draftStorageKeyPrefix + dateKey : null;
  const inputMaxHeight = Math.max(INPUT_MIN_HEIGHT, windowHeight * INPUT_MAX_HEIGHT_RATIO);
  const isInputScrollable = inputContentHeight > inputMaxHeight;

  // 対象日付が変わるたびに入力内容とエラー表示を初期化する
  useEffect(() => {
    setDraft('');
    setInputContentHeight(0);
    setError(null);
  }, [draftKey, setError]);

  // 自動保存されていた下書きが残っていれば、モーダルを開いた際(dateKeyがセットされた際)に復元する
  const handleRestoreDraft = useCallback((storedDraft: string) => {
    setDraft(truncateToBodyMaxLength(storedDraft));
  }, []);
  const isDraftRestored = useDraftRestore({
    draftKey,
    onRestore: handleRestoreDraft,
    editRevisionRef: draftEditRevisionRef,
  });
  const { clearDraft } = useDraftAutoSave({ draftKey, draft, isRestored: isDraftRestored });

  const handleChangeDraft = (text: string) => {
    draftEditRevisionRef.current += 1;
    setDraft(truncateToBodyMaxLength(text));
  };

  const handleCancel = () => {
    if (!draft.trim()) {
      // 復元前に消すと、まだ読み込んでいない保存済みの下書きまで失われる
      if (isDraftRestored) {
        void clearDraft();
      }
      onClose();
      return;
    }
    // 入力途中の内容がある場合のみ、誤って入力内容を失わないよう確認ダイアログを挟む
    Alert.alert('変更を破棄しますか?', '入力中の内容は保存されません。', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '破棄',
        style: 'destructive',
        onPress: () => {
          void clearDraft();
          onClose();
        },
      },
    ]);
  };

  const handleSave = async () => {
    await save({
      text: draft,
      persist,
      onSuccess: async () => {
        // 保存成功時は自動保存済みの下書きキーも削除する。残したままだと次回同じ日付で
        // モーダルを開いた際に、既に保存済みの内容を誤って復元してしまう
        void clearDraft();
        onSaved();
      },
      onError: () => {
        onSaveError?.();
      },
      errorMessage: '保存に失敗しました。もう一度お試しください。',
      isMountedRef,
    });
  };

  // 文字数カウンター表示用に、grapheme単位で数え直す(絵文字などでUTF-16の.lengthとずれるため)
  const draftGraphemeCount = useMemo(() => splitIntoGraphemes(draft).length, [draft]);

  return (
    <Modal
      visible={transition.isMounted}
      animationType="none"
      transparent
      onRequestClose={handleCancel}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* Modalは親のKeyboardAvoidingViewの効果を受けないため、モーダル内にも別途配置する */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる(他のモーダルと同じパターン) */}
        <Pressable
          style={styles.modalOverlay}
          onPress={handleCancel}
          testID="modal-overlay-pressable"
        >
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.modalOverlayBackground,
              { opacity: transition.overlayOpacity },
            ]}
          />
          <Animated.View style={{ transform: [{ translateY: transition.contentTranslateY }] }}>
            {/* オーバーレイ側へのタップ伝播で意図せず閉じないよう、modalContentをPressableで包んで止める */}
            <Pressable onPress={() => {}}>
              <ThemedView
                testID="diary-entry-composer-content"
                style={[
                  styles.modalContent,
                  {
                    borderColor: iconColor,
                    paddingBottom: contentBottomPadding,
                    maxHeight: windowHeight * MODAL_MAX_HEIGHT_RATIO,
                  },
                ]}
              >
                <View style={styles.modalHeader}>
                  <ThemedText type="subtitle">
                    {dateKey ? formatDateHeading(dateKey) : ''}の日記を書く
                  </ThemedText>
                  <Pressable
                    onPress={handleCancel}
                    accessibilityRole="button"
                    accessibilityLabel="閉じる"
                  >
                    <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                      閉じる
                    </ThemedText>
                  </Pressable>
                </View>
                <TextInput
                  style={[
                    styles.input,
                    { color: textColor, borderColor: tintColor },
                    { maxHeight: inputMaxHeight },
                  ]}
                  placeholder="その日の出来事や気持ちを書いてみましょう"
                  placeholderTextColor={iconColor}
                  value={draft}
                  onChangeText={handleChangeDraft}
                  onContentSizeChange={(event) =>
                    setInputContentHeight(event.nativeEvent.contentSize.height)
                  }
                  multiline
                  scrollEnabled
                  accessibilityLabel="日記本文"
                  accessibilityHint="長文は入力欄内でスクロールできます"
                />
                {isInputScrollable ? (
                  <ThemedText style={[styles.scrollHint, { color: iconColor }]}>
                    入力欄内をスクロールできます
                  </ThemedText>
                ) : null}
                <View style={styles.composerFooter}>
                  <ThemedText
                    style={[
                      styles.charCount,
                      draftGraphemeCount >= BODY_MAX_LENGTH
                        ? { color: errorColor }
                        : { color: iconColor },
                    ]}
                  >
                    {draftGraphemeCount}/{BODY_MAX_LENGTH}
                  </ThemedText>
                  <Pressable
                    style={[
                      styles.saveButton,
                      { backgroundColor: tintColor },
                      // 押せない状態であることが見た目でも分かるよう、無効時は半透明にする
                      { opacity: !draft.trim() || isSaving ? 0.5 : 1 },
                    ]}
                    onPress={handleSave}
                    disabled={!draft.trim() || isSaving}
                    accessibilityRole="button"
                    accessibilityLabel="保存"
                    accessibilityState={{ disabled: !draft.trim() || isSaving }}
                  >
                    {isSaving ? (
                      <View style={styles.saveButtonContent}>
                        <ActivityIndicator size="small" color={backgroundColor} />
                        <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                          保存中...
                        </ThemedText>
                      </View>
                    ) : (
                      <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                        保存
                      </ThemedText>
                    )}
                  </Pressable>
                </View>
                {error ? (
                  <ThemedText style={[styles.errorText, { color: errorColor }]}>{error}</ThemedText>
                ) : null}
              </ThemedView>
            </Pressable>
          </Animated.View>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // 背景の暗さを別レイヤーにし、opacityフェードをコンテンツのスライドから独立させる
  modalOverlayBackground: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  modalContent: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalCloseText: {
    fontSize: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: INPUT_MIN_HEIGHT,
    textAlignVertical: 'top',
    fontSize: 16,
  },
  scrollHint: {
    fontSize: 12,
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  charCount: {
    fontSize: 12,
  },
  saveButton: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  saveButtonText: {
    fontWeight: '600',
  },
  saveButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  errorText: {
    fontSize: 14,
  },
});
