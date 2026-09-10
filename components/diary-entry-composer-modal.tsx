import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useModalSlideTransition } from '@/hooks/use-modal-slide-transition';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { useThemeColor } from '@/hooks/use-theme-color';
import { formatDateHeading } from '@/utils/diary-date';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)。他画面の新規作成・編集下書きと合わせる
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

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
// `app/(tabs)/index.tsx`の「日記の無い日をタップして開く新規作成モーダル」と同じ入力体験を
// 複数画面(ホーム画面・日別一覧画面)から再利用するための共通コンポーネント
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
  // 下書き復元が完了したか。完了前に自動保存effectを動かすと、初期値(空文字列)で
  // 保存済みの下書きを誤って上書き・削除してしまうため、完了までは自動保存の対象外にする
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  // 保留中の下書き自動保存タイマーID。保存成功時・破棄確定時にAsyncStorageの下書きキーを
  // 削除する際、クリーンアップ(モーダルを閉じるタイミング)を待たずに明示的にキャンセルするために使う
  const draftAutoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isSaving, error, setError, save } = useSaveDiaryEntry();

  const transition = useModalSlideTransition(dateKey !== null);

  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  const draftKey = dateKey ? draftStorageKeyPrefix + dateKey : null;

  // モーダルを開いた際(dateKeyがセットされた際)、自動保存されていた下書きが残っていれば復元する。
  // 日付ごとにキーが分かれるため、対象日付が変わるたびにやり直す
  useEffect(() => {
    setIsDraftRestored(false);
    setDraft('');
    setError(null);
    if (!draftKey) {
      return;
    }
    let isCancelled = false;
    (async () => {
      try {
        const storedDraft = await AsyncStorage.getItem(draftKey);
        if (!isCancelled && storedDraft) {
          setDraft(truncateToBodyMaxLength(storedDraft));
        }
      } catch {
        // 復元を諦めるだけにとどめる。finallyでisDraftRestoredをtrueにするため、
        // 以降の自動保存が無効化されたままにはならない
      } finally {
        if (!isCancelled) {
          setIsDraftRestored(true);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [draftKey, setError]);

  // draftの変更をデバウンスし、入力が止まってからAsyncStorageへ自動保存する
  useEffect(() => {
    if (!isDraftRestored || !draftKey) {
      return;
    }
    const timer = setTimeout(() => {
      draftAutoSaveTimerRef.current = null;
      const persistDraft = draft
        ? AsyncStorage.setItem(draftKey, draft)
        : AsyncStorage.removeItem(draftKey);
      // 下書きの自動保存は補助的な処理のため、失敗しても静かに無視する(本保存の失敗はhandleSave側で伝える)
      persistDraft.catch(() => {});
    }, DRAFT_AUTO_SAVE_DEBOUNCE_MS);
    draftAutoSaveTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [draft, isDraftRestored, draftKey]);

  // 保留中の自動保存タイマーをキャンセルし、対象日付の下書きキーを削除する
  // (保存成功時・破棄確定時の両方で使う共通処理)
  const clearDraft = () => {
    if (draftAutoSaveTimerRef.current !== null) {
      clearTimeout(draftAutoSaveTimerRef.current);
      draftAutoSaveTimerRef.current = null;
    }
    if (draftKey) {
      AsyncStorage.removeItem(draftKey).catch(() => {});
    }
  };

  const handleChangeDraft = (text: string) => {
    setDraft(truncateToBodyMaxLength(text));
  };

  const handleCancel = () => {
    if (!draft.trim()) {
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
          clearDraft();
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
        clearDraft();
        onSaved();
      },
      onError: () => {
        onSaveError?.();
      },
      errorMessage: '保存に失敗しました。もう一度お試しください。',
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
                style={[
                  styles.modalContent,
                  { borderColor: iconColor, paddingBottom: contentBottomPadding },
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
                  style={[styles.input, { color: textColor, borderColor: tintColor }]}
                  placeholder="その日の出来事や気持ちを書いてみましょう"
                  placeholderTextColor={iconColor}
                  value={draft}
                  onChangeText={handleChangeDraft}
                  multiline
                  accessibilityLabel="日記本文"
                />
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
                    <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                      保存
                    </ThemedText>
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
    maxHeight: '70%',
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
    minHeight: 80,
    textAlignVertical: 'top',
    fontSize: 16,
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
  errorText: {
    fontSize: 14,
  },
});
