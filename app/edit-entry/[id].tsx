import AsyncStorage from '@react-native-async-storage/async-storage';
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
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { useThemeColor } from '@/hooks/use-theme-color';
import {
  DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX,
  loadDraftText,
  saveDraftText,
} from '@/utils/diary-draft-storage';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';
import { getDiaryEntryById, saveDiaryEntry, type DiaryEntry } from '@/utils/diary-storage';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)。app/(tabs)/index.tsxの新規作成composerと合わせる
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

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
  // 下書き自動保存のデバウンスタイマーID。保存成功時・破棄確定時にAsyncStorageの下書きキーを
  // 削除する際、effectのクリーンアップ(=アンマウント)を待たずに明示的にキャンセルするために使う。
  // アンマウントは遷移アニメーション等の完了まで遅延しうるため、クリーンアップ任せだと
  // 削除後にタイマーが発火して下書きが復活してしまうrace conditionがある
  const draftAutoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 保存処理中にbeforeRemoveでブロックされた離脱アクション。router.back()自体もbeforeRemoveを
  // 発火させ、保存完了前(isSavingEdit === true)は自分自身のガードでブロックされてしまうため、
  // 保存成功後に再送して確実に画面を離れられるようにする
  const pendingRemoveActionRef = useRef<NavigationAction | null>(null);
  // 直近の保存結果(成功/失敗)。onSuccess/onErrorの実行タイミングはPromiseの解決に基づくため、
  // isSavingEditのstate更新(ひいてはbeforeRemoveリスナーの再登録)がまだ反映されていない
  // 一瞬の間に離脱操作が発生しても、この値は既に正しい結果を保持している。保存失敗時に
  // ブロック済みの離脱アクションを誤って再送しないための判定に使う
  const lastSaveSucceededRef = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  useEffect(() => {
    // idが変わる場合(通常は画面が都度pushされるため起こらないが、念のため)に備え、
    // 新しいエントリの下書き復元が終わるまで自動保存effectを止める
    setIsDraftRestored(false);
    (async () => {
      const found = id ? await getDiaryEntryById(id) : null;
      if (!isMountedRef.current) {
        return;
      }
      if (found) {
        entryRef.current = found;
        // インポート等で上限を超えるtextが紛れ込んでいた場合に備え、通常の入力と同様に
        // 切り詰めてからドラフトへセットする(切り詰めないと保存時のガードに無言で弾かれ続ける)
        const originalGraphemeCount = splitIntoGraphemes(found.text).length;
        const truncatedText = truncateToBodyMaxLength(found.text);
        // editOriginalTextRefには常に「保存済みの元の本文」を保持する(下書きの内容ではない)。
        // これにより、下書きを復元した内容から変更していなくても元の本文と異なれば
        // 破棄確認が正しく発火する
        editOriginalTextRef.current = truncatedText;

        // 自動保存されていた編集下書きが残っていれば、元の本文より優先して復元する。
        // ただし下書きが元の本文と同一の場合はそのまま元の本文を使う(意味の無い復元を避ける)
        let textToShow = truncatedText;
        try {
          const storedDraft = await loadDraftText(DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + found.id);
          if (isMountedRef.current && storedDraft !== null) {
            const truncatedDraft = truncateToBodyMaxLength(storedDraft);
            if (truncatedDraft !== truncatedText) {
              textToShow = truncatedDraft;
            }
          }
        } catch {
          // 下書きの復元に失敗しても、元の本文の表示は継続できるため無視する
        }
        if (!isMountedRef.current) {
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
  }, [id]);

  // editDraftの変更をデバウンスし、入力が止まってからAsyncStorageへ自動保存する
  // (app/(tabs)/index.tsxの新規作成composerと同じ方式。エントリIDごとにキーを分ける)
  useEffect(() => {
    // 復元完了前は、復元処理中の一時的な内容で保存済みの下書きを上書きしないよう何もしない
    if (!isDraftRestored || !id) {
      return;
    }
    const draftKey = DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + id;
    const timer = setTimeout(() => {
      draftAutoSaveTimerRef.current = null;
      const persist = editDraft
        ? saveDraftText(draftKey, editDraft)
        : AsyncStorage.removeItem(draftKey);
      // 下書きの自動保存は補助的な処理のため、失敗しても静かに無視する(本保存の失敗はhandleSaveEdit側で伝える)
      persist.catch(() => {});
    }, DRAFT_AUTO_SAVE_DEBOUNCE_MS);
    draftAutoSaveTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [editDraft, isDraftRestored, id]);

  // 編集用TextInputのonChangeText。truncateToBodyMaxLengthでgrapheme単位の切り詰めを行う
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
        // 保存成功後は「未保存の変更」ではなくなるため、破棄確認の基準を保存後の内容に更新してから戻る
        // (この後のnavigation.addListener('beforeRemove', ...)がeditDraftと比較する対象)
        editOriginalTextRef.current = trimmed;

        // 保存成功時は自動保存済みの下書きキーも削除する。残したままだと次回この画面を
        // 開いた際に、既に保存済みの内容を誤って復元してしまう。削除前に保留中のデバウンス
        // タイマーを明示的にキャンセルし、削除後にタイマーが発火して下書きが復活しないようにする
        try {
          if (draftAutoSaveTimerRef.current !== null) {
            clearTimeout(draftAutoSaveTimerRef.current);
            draftAutoSaveTimerRef.current = null;
          }
          await AsyncStorage.removeItem(DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + targetEntry.id);
        } catch {
          // 下書きキーのクリアに失敗しても、日記本体は既に保存済みで致命的ではないため無視する
        }

        lastSaveSucceededRef.current = true;
        router.back();
      },
      onError: () => {
        // 保存失敗時は、直後の再送処理(isSavingEdit変化を検知するeffect)で保存中に
        // ブロックしていた離脱アクションを送らせないようにする。再送してしまうと、
        // エラーメッセージや未保存の編集内容をユーザーが確認する間もなく画面を離れてしまう
        lastSaveSucceededRef.current = false;
      },
      errorMessage: '更新に失敗しました。もう一度お試しください。',
      // 保存完了前にアンマウントされていた場合、アンマウント済みコンポーネントへのstate更新
      // (Reactの警告の原因)を避けるため渡す
      isMountedRef,
    });
  }, [editDraft, router, saveEdit]);

  // 画面を離れようとした際(ヘッダーの戻る操作・Android物理戻るボタン・スワイプ戻る
  // ジェスチャーのいずれも対象になる)、未保存の変更がある場合のみ破棄確認ダイアログを挟む
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      // 保存処理の進行中は、破棄確認ダイアログとhandleSaveEdit完了後のrouter.back()が
      // 競合してしまうため、離脱操作自体を一律ブロックする。router.back()によるプログラム的な
      // 遷移もここで一旦ブロックされるため、そのアクションを保持しておき、保存完了後に
      // 再送することで画面を確実に離れられるようにする
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
            // 破棄が確定したら、残っている自動保存下書きも削除する。実際のアンマウント(effectの
            // クリーンアップによるclearTimeout)は遷移アニメーション等の完了まで遅延しうるため、
            // それを待たずここで明示的にタイマーをキャンセルしてから削除する。そうしないと、
            // 削除後に保留中のデバウンスタイマーが発火し、破棄したはずの内容が再度書き込まれてしまう
            if (draftAutoSaveTimerRef.current !== null) {
              clearTimeout(draftAutoSaveTimerRef.current);
              draftAutoSaveTimerRef.current = null;
            }
            // 失敗しても既に画面を離れる操作自体は成立しているため、致命的ではなく無視する
            if (id) {
              AsyncStorage.removeItem(DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX + id).catch(() => {});
            }
          },
        },
      ]);
    });
    return unsubscribe;
  }, [navigation, editDraft, isSavingEdit, id]);

  // 保存完了(isSavingEdit: true→false)を検知したら、保存中にブロックされていた離脱アクションを
  // 再送する。router.back()呼び出し自体は既に完了しているため、ここではnavigation.dispatchで
  // アクションを直接反映させる。保存失敗時は再送せず画面に留まる(lastSaveSucceededRefで判定)
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
