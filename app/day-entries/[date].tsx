import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DiaryEntryComposerModal } from '@/components/diary-entry-composer-modal';
import { SaveToast } from '@/components/save-toast';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useThemeColor } from '@/hooks/use-theme-color';
import {
  buildCreatedAtForDateKeyAtTime,
  formatDateHeading,
  formatEntryDateTime,
  toDateKey,
} from '@/utils/diary-date';
import { DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX } from '@/utils/diary-draft-storage';
import {
  buildDiaryPartialCorruptionMessage,
  deleteDiaryEntry,
  DIARY_LOAD_ERROR_MESSAGE,
  getAllDiaryEntries,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

const COPY_SUCCESS_MESSAGE = 'コピーしました';
const EMPTY_STATE_MESSAGE = 'この日の日記はまだありません';
const DELETE_UNDO_DELAY_MS = 5000;

function sortEntriesByCreatedAt(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => {
    const timeDifference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return timeDifference !== 0 ? timeDifference : a.id.localeCompare(b.id);
  });
}

// 指定した日付('YYYY-MM-DD')の日記一覧を表示する専用画面。
// カレンダー画面のモーダルではなく独立した画面にすることで、削除時のフェードアウトや
// 編集画面への遷移を画面単位で扱えるようにしている。
export default function DayEntriesScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [hasLoadedEntries, setHasLoadedEntries] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [copyToastMessage, setCopyToastMessage] = useState<string | null>(null);
  const [corruptionToastMessage, setCorruptionToastMessage] = useState<string | null>(null);
  const [pendingDeletedEntries, setPendingDeletedEntries] = useState<DiaryEntry[]>([]);
  const [isRestoringDeletedEntries, setIsRestoringDeletedEntries] = useState(false);
  const [hasUndoError, setHasUndoError] = useState(false);
  const pendingDeletedEntriesRef = useRef<DiaryEntry[]>([]);
  const isRestoringDeletedEntriesRef = useRef(false);
  const isDeletingEntryRef = useRef(false);
  const isMountedRef = useRef(true);
  const activeDateRef = useRef(date);
  const previousDateRef = useRef(date);
  // loadEntriesの呼び出し順序を追跡し、後発の呼び出しより先に完了した古い呼び出しの結果で
  // stateを上書きしないようにする(日付切り替え・連続フォーカス時の競合対策)
  const loadRequestIdRef = useRef(0);
  activeDateRef.current = date;
  const [isComposerOpen, setIsComposerOpen] = useState(false);

  const tintColor = useThemeColor({}, 'tint');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');
  // この画面はタブバーを持たないため、セーフエリア下端ぶんのみモーダルコンテンツの下端に加算する
  const insets = useSafeAreaInsets();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousDateRef.current !== date) {
      pendingDeletedEntriesRef.current = [];
      setPendingDeletedEntries([]);
      setHasUndoError(false);
      previousDateRef.current = date;
    }
  }, [date]);

  const handleOpenComposer = useCallback(() => {
    setIsComposerOpen(true);
  }, []);

  // ルートごとの静的なタイトルしか設定できない`_layout.tsx`側の代わりに、
  // paramsに応じた動的なタイトル・ヘッダーボタンをここで設定する
  useEffect(() => {
    navigation.setOptions({
      title: date ? formatDateHeading(date) : '',
      headerRight: () => (
        <Pressable
          onPress={handleOpenComposer}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="この日の日記を新規作成"
        >
          <IconSymbol name="plus" size={24} color={tintColor} />
        </Pressable>
      ),
    });
  }, [navigation, date, tintColor, handleOpenComposer]);

  const loadEntries = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!date) {
      setEntries([]);
      setHasLoadError(false);
      setHasLoadedEntries(true);
      return;
    }
    let loadFailed = false;
    let partialCorruptionCount = 0;
    const allEntries = await getAllDiaryEntries({
      onError: () => {
        loadFailed = true;
      },
      onPartialCorruption: (invalidCount) => {
        partialCorruptionCount = invalidCount;
      },
    });
    // 完了時点で自分より新しいリクエストが既に発火していれば、この結果は古いため反映しない
    if (loadRequestIdRef.current !== requestId) {
      return;
    }
    setEntries(
      sortEntriesByCreatedAt(
        allEntries.filter((entry) => toDateKey(new Date(entry.createdAt)) === date),
      ),
    );
    setHasLoadError(loadFailed);
    setHasLoadedEntries(true);
    if (partialCorruptionCount > 0) {
      setCorruptionToastMessage(buildDiaryPartialCorruptionMessage(partialCorruptionCount));
    }
  }, [date]);

  // 編集画面から戻ってきた際にも最新の内容を反映できるよう、フォーカスが戻るたびに読み直す
  useFocusEffect(
    useCallback(() => {
      loadEntries();
    }, [loadEntries]),
  );

  const handleCloseComposer = useCallback(() => {
    setIsComposerOpen(false);
  }, []);

  // 新規作成モーダルの保存処理本体。createdAtの日付部分はこの画面が表示している日付に
  // 固定しつつ、時分秒は実際に保存した瞬間の時刻にする(buildCreatedAtForDateKeyAtTime)
  const handlePersistNewEntry = useCallback(
    async (trimmed: string) => {
      if (!date) {
        return;
      }
      const newEntry: DiaryEntry = {
        id: randomUUID(),
        text: trimmed,
        createdAt: buildCreatedAtForDateKeyAtTime(date),
      };
      // 体感速度を落とさないよう楽観的にUIを更新する(一覧は時刻昇順のため末尾に追加)
      setEntries((current) => [...current, newEntry]);
      try {
        await saveDiaryEntry(newEntry);
      } catch (err) {
        // 永続化に失敗した場合は楽観的に追加した分を取り除いてロールバックする
        setEntries((current) => current.filter((entry) => entry.id !== newEntry.id));
        throw err;
      }
    },
    [date],
  );

  const handleComposerSaved = useCallback(() => {
    setIsComposerOpen(false);
  }, []);

  const handleHideCopyToast = useCallback(() => {
    setCopyToastMessage(null);
  }, []);

  const handleHideCorruptionToast = useCallback(() => {
    setCorruptionToastMessage(null);
  }, []);

  const handleHideDeleteUndoToast = useCallback(() => {
    if (isRestoringDeletedEntriesRef.current) {
      return;
    }
    pendingDeletedEntriesRef.current = [];
    setPendingDeletedEntries([]);
    setHasUndoError(false);
  }, []);

  const handleCopyEntry = useCallback(async (entry: DiaryEntry) => {
    try {
      await Clipboard.setStringAsync(entry.text);
      setCopyToastMessage(COPY_SUCCESS_MESSAGE);
    } catch {
      Alert.alert('コピーに失敗しました', 'もう一度お試しください。');
    }
  }, []);

  const handleStartEdit = useCallback(
    (entry: DiaryEntry) => {
      router.push(`/edit-entry/${entry.id}`);
    },
    [router],
  );

  const handleUndoDelete = useCallback(async () => {
    if (isRestoringDeletedEntriesRef.current || pendingDeletedEntriesRef.current.length === 0) {
      return;
    }

    isRestoringDeletedEntriesRef.current = true;
    setIsRestoringDeletedEntries(true);
    setHasUndoError(false);
    const entriesToRestore = [...pendingDeletedEntriesRef.current];
    const restoreDate = activeDateRef.current;

    try {
      const results = await Promise.allSettled(entriesToRestore.map(saveDiaryEntry));
      const restoredEntries = entriesToRestore.filter(
        (_, index) => results[index].status === 'fulfilled',
      );
      const restoredIds = new Set(restoredEntries.map((entry) => entry.id));

      if (!isMountedRef.current || activeDateRef.current !== restoreDate) {
        return;
      }

      setEntries((current) =>
        sortEntriesByCreatedAt([
          ...current.filter((entry) => !restoredIds.has(entry.id)),
          ...restoredEntries,
        ]),
      );
      setPendingDeletedEntries((current) => {
        const remaining = current.filter((entry) => !restoredIds.has(entry.id));
        pendingDeletedEntriesRef.current = remaining;
        return remaining;
      });

      if (restoredEntries.length !== entriesToRestore.length) {
        setHasUndoError(true);
        Alert.alert(
          '復元に失敗しました',
          '復元できなかった日記があります。もう一度お試しください。',
        );
      }
    } finally {
      isRestoringDeletedEntriesRef.current = false;
      if (isMountedRef.current) {
        setIsRestoringDeletedEntries(false);
      }
    }
  }, []);

  const handleDeleteEntry = useCallback(
    async (entry: DiaryEntry) => {
      if (isDeletingEntryRef.current) {
        return;
      }
      isDeletingEntryRef.current = true;
      const deleteDate = date;
      setEntries((current) => current.filter((item) => item.id !== entry.id));

      try {
        await deleteDiaryEntry(entry.id);
        if (!isMountedRef.current || activeDateRef.current !== deleteDate) {
          return;
        }
        setPendingDeletedEntries((current) => {
          const next = [...current.filter((item) => item.id !== entry.id), entry];
          pendingDeletedEntriesRef.current = next;
          return next;
        });
        setHasUndoError(false);
      } catch {
        if (!isMountedRef.current || activeDateRef.current !== deleteDate) {
          return;
        }
        await loadEntries();
        if (isMountedRef.current) {
          Alert.alert('削除に失敗しました', 'もう一度お試しください。');
        }
      } finally {
        isDeletingEntryRef.current = false;
      }
    },
    [date, loadEntries],
  );

  const handleDeletePress = useCallback(
    (entry: DiaryEntry) => {
      Alert.alert(
        '日記を削除しますか?',
        `削除後、${DELETE_UNDO_DELAY_MS / 1000}秒間は元に戻せます。`,
        [
          { text: 'キャンセル', style: 'cancel' },
          { text: '削除', style: 'destructive', onPress: () => handleDeleteEntry(entry) },
        ],
      );
    },
    [handleDeleteEntry],
  );

  const renderEmptyEntries = useCallback(
    () =>
      hasLoadedEntries ? (
        <ThemedView style={styles.emptyState}>
          {hasLoadError ? (
            // emptyStateTextのopacityはコントラストを下げるため、エラー表示には適用しない
            <>
              <ThemedText style={[styles.emptyStateErrorText, { color: errorColor }]}>
                {DIARY_LOAD_ERROR_MESSAGE}
              </ThemedText>
              <Pressable
                onPress={loadEntries}
                style={[styles.retryButton, { borderColor: tintColor }]}
                accessibilityRole="button"
                accessibilityLabel="再試行"
              >
                <ThemedText style={[styles.retryButtonText, { color: tintColor }]}>
                  再試行
                </ThemedText>
              </Pressable>
            </>
          ) : (
            <ThemedText style={styles.emptyStateText}>{EMPTY_STATE_MESSAGE}</ThemedText>
          )}
        </ThemedView>
      ) : null,
    [hasLoadedEntries, hasLoadError, errorColor, tintColor, loadEntries],
  );

  return (
    <ThemedView style={styles.container}>
      {copyToastMessage ? (
        <SaveToast message={copyToastMessage} onHide={handleHideCopyToast} testID="copy-toast" />
      ) : null}
      {corruptionToastMessage ? (
        <SaveToast
          message={corruptionToastMessage}
          onHide={handleHideCorruptionToast}
          testID="data-integrity-toast"
          variant="warning"
        />
      ) : null}
      {pendingDeletedEntries.length > 0 ? (
        <SaveToast
          message={
            isRestoringDeletedEntries
              ? '日記を復元しています'
              : hasUndoError
                ? '復元できなかった日記があります'
                : pendingDeletedEntries.length === 1
                  ? '日記を削除しました'
                  : `${pendingDeletedEntries.length}件の日記を削除しました`
          }
          onHide={handleHideDeleteUndoToast}
          testID="delete-undo-toast"
          actionLabel={isRestoringDeletedEntries ? undefined : hasUndoError ? '再試行' : '元に戻す'}
          onAction={isRestoringDeletedEntries ? undefined : handleUndoDelete}
          autoHideDelayMs={isRestoringDeletedEntries ? null : DELETE_UNDO_DELAY_MS}
        />
      ) : null}
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={renderEmptyEntries}
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => (
          <ThemedView style={[styles.entry, { borderBottomColor: iconColor }]}>
            <View style={styles.entryHeader}>
              <ThemedText style={styles.entryDate}>
                {formatEntryDateTime(item.createdAt)}
              </ThemedText>
              <View style={styles.entryActions}>
                <Pressable
                  onPress={() => handleCopyEntry(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="日記本文をコピー"
                >
                  <ThemedText style={[styles.entryActionText, { color: tintColor }]}>
                    コピー
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => handleStartEdit(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="この日記を編集"
                >
                  <ThemedText style={[styles.entryActionText, { color: tintColor }]}>
                    編集
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => handleDeletePress(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="この日記を削除"
                >
                  <ThemedText style={[styles.entryActionText, { color: errorColor }]}>
                    削除
                  </ThemedText>
                </Pressable>
              </View>
            </View>
            <ThemedText>{item.text}</ThemedText>
          </ThemedView>
        )}
      />
      <DiaryEntryComposerModal
        dateKey={isComposerOpen ? (date ?? null) : null}
        draftStorageKeyPrefix={DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}
        contentBottomPadding={insets.bottom}
        persist={handlePersistNewEntry}
        onSaved={handleComposerSaved}
        onClose={handleCloseComposer}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    padding: 16,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  emptyStateText: {
    fontSize: 16,
    fontWeight: '600',
    opacity: 0.7,
    textAlign: 'center',
  },
  // エラー表示はコントラスト確保のためemptyStateTextのopacityを継承しない
  emptyStateErrorText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  retryButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  retryButtonText: {
    fontWeight: '600',
  },
  entry: {
    gap: 4,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  entryDate: {
    fontSize: 12,
    opacity: 0.6,
  },
  entryActions: {
    flexDirection: 'row',
    gap: 16,
  },
  entryActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
