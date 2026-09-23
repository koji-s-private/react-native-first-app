import type { NavigationAction } from '@react-navigation/native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SaveToast } from '@/components/save-toast';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useDraftAutoSave } from '@/hooks/use-draft-auto-save';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { useThemeColor } from '@/hooks/use-theme-color';
import { DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX, loadDraftText } from '@/utils/diary-draft-storage';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';
import { getDiaryEntryById, saveDiaryEntry, type DiaryEntry } from '@/utils/diary-storage';

const SAVE_SUCCESS_MESSAGE = '保存しました';

// 保存成功のトーストを表示してから前の画面へ戻るまでの待ち時間(ミリ秒)。
// 遷移が早すぎると保存できたかを確認できないため、トーストを読める長さだけ画面に留める
const NAVIGATE_BACK_DELAY_AFTER_SAVE_MS = 1200;

// 日記1件を編集する専用画面。未保存の変更を持ったまま離れようとした場合の破棄確認は、
// ヘッダーの戻る操作・物理戻るボタン・スワイプのいずれでも検知できる`beforeRemove`イベントで実現する
export default function EditEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [isLoaded, setIsLoaded] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const { isSaving: isSavingEdit, error: editError, save: saveEdit } = useSaveDiaryEntry();
  // 下書き復元が完了したか。完了前に自動保存effectを動かすと、復元中の一時的な内容で
  // 保存済みの下書きを誤って上書き・削除してしまうため、完了までは自動保存の対象外にする
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  // 編集対象エントリ本体(createdAtを保存時にそのまま引き継ぐため保持する)
  const entryRef = useRef<DiaryEntry | null>(null);
  // 編集開始時点の本文。破棄確認の要否判定(editDraftとの比較)に使う
  const editOriginalTextRef = useRef('');
  // アンマウント後にstate更新を行わないようにするためのフラグ(データ読み込み・保存処理の
  // 完了を待つ間に画面がアンマウントされ得るため、各非同期処理から参照して安全性を確保する)
  const isMountedRef = useRef(true);
  // 保存処理中にbeforeRemoveでブロックされた離脱アクション。router.back()自体もbeforeRemoveを
  // 発火させ、保存完了前は自分自身のガードでブロックされてしまうため、保存成功後に再送する
  const pendingRemoveActionRef = useRef<NavigationAction | null>(null);
  // 直近の保存結果(成功/失敗)。isSavingEditのstate更新が反映される前の一瞬に離脱操作が
  // 発生しても正しい結果を判定できるよう、保存失敗時にブロック済みアクションを再送しない判定に使う
  const lastSaveSucceededRef = useRef(false);
  // 保存成功トースト表示中の待機をアンマウント時に打ち切るための関数
  const cancelNavigateBackDelayRef = useRef<(() => void) | null>(null);
  const [saveToastMessage, setSaveToastMessage] = useState<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelNavigateBackDelayRef.current?.();
    };
  }, []);

  const handleHideSaveToast = useCallback(() => {
    setSaveToastMessage(null);
  }, []);

  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  useEffect(() => {
    // idが変わって同effectが再実行される際、直前のidの非同期処理が後から解決しても
    // 新しいidの表示内容を上書きしないための、このeffect呼び出し専用の無効化フラグ
    let isCancelled = false;
    // idが変わる場合に備え、新しいエントリの下書き復元が終わるまで自動保存effectを止める
    setIsDraftRestored(false);
    (async () => {
      const found = id ? await getDiaryEntryById(id) : null;
      if (isCancelled || !isMountedRef.current) {
        return;
      }
      if (found) {
        entryRef.current = found;
        // インポート等で上限を超えるtextが紛れ込んでいた場合に備え、通常の入力と同様に
        // 切り詰めてからドラフトへセットする(切り詰めないと保存時のガードに無言で弾かれ続ける)
        const originalGraphemeCount = splitIntoGraphemes(found.text).length;
        const truncatedText = truncateToBodyMaxLength(found.text);
        // editOriginalTextRefは常に「保存済みの元の本文」を保持する(下書きの内容ではない)。
        // 下書きから変更していなくても元の本文と異なれば破棄確認が正しく発火する
        editOriginalTextRef.current = truncatedText;

        // 自動保存されていた編集下書きが残っていれば、元の本文より優先して復元する。
        // ただし下書きが元の本文と同一の場合はそのまま元の本文を使う(意味の無い復元を避ける)
        let textToShow = truncatedText;
        try {
          const storedDraft = await loadDraftText(DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + found.id);
          if (!isCancelled && isMountedRef.current && storedDraft !== null) {
            const truncatedDraft = truncateToBodyMaxLength(storedDraft);
            if (truncatedDraft !== truncatedText) {
              textToShow = truncatedDraft;
            }
          }
        } catch {
          // 下書きの復元に失敗しても、元の本文の表示は継続できるため無視する
        }
        if (isCancelled || !isMountedRef.current) {
          return;
        }
        setEditDraft(textToShow);

        // 切り詰めが発生した場合、日記本文の一部が失われたことにユーザーが気づけるよう
        // 一度きりの通知を出す(無編集のまま保存すると末尾が無言で失われてしまうため)
        if (originalGraphemeCount > BODY_MAX_LENGTH) {
          Alert.alert(
            '本文の一部が切り詰められました',
            `本文が文字数上限(${BODY_MAX_LENGTH}文字)を超えていたため、末尾の${originalGraphemeCount - BODY_MAX_LENGTH}文字を切り詰めました。`,
          );
        }
      }
      setIsLoaded(true);
      setIsDraftRestored(true);
    })();
    return () => {
      isCancelled = true;
    };
  }, [id]);

  const { clearDraft } = useDraftAutoSave({
    draftKey: id ? DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + id : null,
    draft: editDraft,
    isRestored: isDraftRestored,
  });

  const handleChangeEditDraft = useCallback((text: string) => {
    setEditDraft(truncateToBodyMaxLength(text));
  }, []);

  const handleSaveEdit = useCallback(async () => {
    const targetEntry = entryRef.current;
    if (!targetEntry) {
      return;
    }

    await saveEdit({
      text: editDraft,
      persist: (trimmed) => saveDiaryEntry({ ...targetEntry, text: trimmed }),
      onSuccess: async (trimmed) => {
        entryRef.current = { ...targetEntry, text: trimmed };
        // 保存成功後は「未保存の変更」ではなくなるため、破棄確認の基準(beforeRemoveの比較対象)を更新する
        editOriginalTextRef.current = trimmed;

        // 残したままだと次回この画面を開いた際に保存済みの内容を誤って復元してしまうため削除する
        await clearDraft();

        lastSaveSucceededRef.current = true;

        // 下書きキー削除のawait中にアンマウントされた場合、解除できないタイマーを作らない
        if (!isMountedRef.current) {
          return;
        }
        // 待機中も保存処理中(isSavingEdit)のままにすることで、保存ボタンの再押下と本文入力を防ぎ、
        // 戻る操作はbeforeRemoveでブロックされて待機完了後に再送される
        setSaveToastMessage(SAVE_SUCCESS_MESSAGE);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, NAVIGATE_BACK_DELAY_AFTER_SAVE_MS);
          cancelNavigateBackDelayRef.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelNavigateBackDelayRef.current = null;
        if (!isMountedRef.current) {
          return;
        }
        router.back();
      },
      onError: () => {
        // 失敗時は再送処理(isSavingEdit変化検知effect)でブロック済みの離脱アクションを送らせない。
        // 再送するとエラーメッセージや未保存の編集内容を確認する間もなく画面を離れてしまう
        lastSaveSucceededRef.current = false;
      },
      errorMessage: '更新に失敗しました。もう一度お試しください。',
      // 保存完了前にアンマウントされた場合の、アンマウント済みコンポーネントへのstate更新を避ける
      isMountedRef,
    });
  }, [editDraft, router, saveEdit, clearDraft]);

  // 画面を離れようとした際、未保存の変更がある場合のみ破棄確認ダイアログを挟む
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      // 保存処理中は、破棄確認ダイアログとhandleSaveEdit完了後のrouter.back()が競合するため
      // 離脱操作を一律ブロックする。ブロックしたアクションは保持しておき、保存完了後に再送する
      if (isSavingEdit) {
        event.preventDefault();
        pendingRemoveActionRef.current = event.data.action;
        return;
      }
      if (editDraft.trim() === editOriginalTextRef.current.trim()) {
        return;
      }
      event.preventDefault();
      Alert.alert('変更を破棄しますか?', '編集中の内容は保存されません。', [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '破棄',
          style: 'destructive',
          onPress: () => {
            navigation.dispatch(event.data.action);
            // 破棄が確定したら、残っている自動保存下書きも削除する
            void clearDraft();
          },
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, editDraft, isSavingEdit, clearDraft]);

  // 保存完了(isSavingEdit: true→false)を検知したら、保存中にブロックしていた離脱アクションを再送する。
  // 保存失敗時は再送せず画面に留まる(lastSaveSucceededRefで判定)
  useEffect(() => {
    if (isSavingEdit || pendingRemoveActionRef.current === null) {
      return;
    }
    const action = pendingRemoveActionRef.current;
    pendingRemoveActionRef.current = null;
    if (lastSaveSucceededRef.current) {
      navigation.dispatch(action);
    }
  }, [isSavingEdit, navigation]);

  const editDraftGraphemeCount = useMemo(() => splitIntoGraphemes(editDraft).length, [editDraft]);

  if (!isLoaded) {
    return (
      <ThemedView style={styles.loadingContainer}>
        <ActivityIndicator color={tintColor} />
      </ThemedView>
    );
  }

  if (!entryRef.current) {
    return (
      <ThemedView style={styles.loadingContainer}>
        <ThemedText>編集対象の日記が見つかりませんでした。</ThemedText>
      </ThemedView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ThemedView
        style={[styles.container, { paddingBottom: 16 + insets.bottom }]}
        testID="edit-entry-container"
      >
        <TextInput
          style={[styles.input, { color: textColor, borderColor: tintColor }]}
          value={editDraft}
          onChangeText={handleChangeEditDraft}
          multiline
          editable={!isSavingEdit}
          accessibilityLabel="日記本文"
          // 他の本文入力欄と同様、grapheme単位の切り詰めをonChangeText側で行うため
          // maxLength propはあえて指定しない
        />
        <ThemedView style={styles.footer}>
          <ThemedText
            style={[
              styles.charCount,
              editDraftGraphemeCount >= BODY_MAX_LENGTH
                ? { color: errorColor }
                : { color: iconColor },
            ]}
          >
            {editDraftGraphemeCount}/{BODY_MAX_LENGTH}
          </ThemedText>
          <Pressable
            style={[
              styles.saveButton,
              { backgroundColor: tintColor },
              { opacity: !editDraft.trim() || isSavingEdit ? 0.5 : 1 },
            ]}
            onPress={handleSaveEdit}
            disabled={!editDraft.trim() || isSavingEdit}
            accessibilityRole="button"
            accessibilityLabel="保存"
            accessibilityState={{ disabled: !editDraft.trim() || isSavingEdit }}
          >
            {isSavingEdit ? (
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
        </ThemedView>
        {editError ? (
          <ThemedText style={[styles.errorText, { color: errorColor }]}>{editError}</ThemedText>
        ) : null}
        {saveToastMessage ? (
          <SaveToast message={saveToastMessage} onHide={handleHideSaveToast} />
        ) : null}
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 16,
    gap: 8,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    textAlignVertical: 'top',
    fontSize: 16,
  },
  footer: {
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
