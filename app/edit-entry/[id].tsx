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
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';
import { getDiaryEntryById, saveDiaryEntry, type DiaryEntry } from '@/utils/diary-storage';

// 日記1件を編集する専用画面(Issue #221)。従来はカレンダー画面
// (`app/(tabs)/index.tsx`)の日付一覧モーダルの上にさらに重ねて表示する編集モーダルだったが、
// 編集専用の画面へ遷移する方式に置き換えている。未保存の変更を持ったまま画面を離れようとした
// 場合の破棄確認は、ヘッダーの戻る操作・Android物理戻るボタン・スワイプ戻るジェスチャーの
// いずれでも一律に検知できる`navigation.addListener('beforeRemove', ...)`で実現する
// (Reactナビゲーションの標準的な「離脱確認」の実装パターン)。
export default function EditEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();

  const [isLoaded, setIsLoaded] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  // 編集対象エントリ本体(createdAtを保存時にそのまま引き継ぐため保持する)
  const entryRef = useRef<DiaryEntry | null>(null);
  // 編集開始時点の本文。破棄確認の要否判定(editDraftとの比較)に使う
  const editOriginalTextRef = useRef('');

  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  useEffect(() => {
    let isCancelled = false;
    (async () => {
      const found = id ? await getDiaryEntryById(id) : null;
      if (isCancelled) {
        return;
      }
      if (found) {
        entryRef.current = found;
        // インポート等で上限を超えるtextが紛れ込んでいた場合に備え、通常の入力と同様に
        // 切り詰めてからドラフトへセットする(切り詰めないと保存時のガードに無言で弾かれ続ける)
        const truncatedText = truncateToBodyMaxLength(found.text);
        setEditDraft(truncatedText);
        editOriginalTextRef.current = truncatedText;
      }
      setIsLoaded(true);
    })();
    return () => {
      isCancelled = true;
    };
  }, [id]);

  // 編集用TextInputのonChangeText。truncateToBodyMaxLengthでgrapheme単位の切り詰めを行う
  const handleChangeEditDraft = useCallback((text: string) => {
    setEditDraft(truncateToBodyMaxLength(text));
  }, []);

  const handleSaveEdit = useCallback(async () => {
    // 既に更新処理が進行中であれば、連打による重複更新を防ぐため何もしない
    if (isSavingEdit) {
      return;
    }

    const trimmed = editDraft.trim();
    const targetEntry = entryRef.current;
    if (!targetEntry || !trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
      return;
    }

    const updatedEntry: DiaryEntry = { ...targetEntry, text: trimmed };
    setIsSavingEdit(true);
    setEditError(null);

    try {
      await saveDiaryEntry(updatedEntry);
      entryRef.current = updatedEntry;
      // 保存成功後は「未保存の変更」ではなくなるため、破棄確認の基準を保存後の内容に更新してから戻る
      // (この後のnavigation.addListener('beforeRemove', ...)がeditDraftと比較する対象)
      editOriginalTextRef.current = trimmed;
      router.back();
    } catch {
      setEditError('更新に失敗しました。もう一度お試しください。');
    } finally {
      setIsSavingEdit(false);
    }
  }, [editDraft, isSavingEdit, router]);

  // 画面を離れようとした際(ヘッダーの戻る操作・Android物理戻るボタン・スワイプ戻る
  // ジェスチャーのいずれも対象になる)、未保存の変更がある場合のみ破棄確認ダイアログを挟む
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (editDraft.trim() === editOriginalTextRef.current.trim()) {
        return;
      }
      event.preventDefault();
      Alert.alert('変更を破棄しますか?', '編集中の内容は保存されません。', [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '破棄',
          style: 'destructive',
          onPress: () => navigation.dispatch(event.data.action),
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, editDraft]);

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
      <ThemedView style={styles.container}>
        <TextInput
          style={[styles.input, { color: textColor, borderColor: tintColor }]}
          value={editDraft}
          onChangeText={handleChangeEditDraft}
          multiline
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
            <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
              保存
            </ThemedText>
          </Pressable>
        </ThemedView>
        {editError ? (
          <ThemedText style={[styles.errorText, { color: errorColor }]}>{editError}</ThemedText>
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
  errorText: {
    fontSize: 14,
  },
});
