import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DiaryEntryComposerModal } from '@/components/diary-entry-composer-modal';
import { SaveToast } from '@/components/save-toast';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useThemeColor } from '@/hooks/use-theme-color';
import {
  buildCreatedAtForDateKey,
  formatDateHeading,
  formatEntryDateTime,
  toDateKey,
} from '@/utils/diary-date';
import {
  deleteDiaryEntry,
  getAllDiaryEntries,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

// コピー成功時に一時的に表示するトーストのメッセージ
const COPY_SUCCESS_MESSAGE = 'コピーしました';
const EMPTY_STATE_MESSAGE = 'この日の日記はまだありません';

// この画面の新規作成モーダルの下書き自動保存に使うAsyncStorageキーの接頭辞。
// ホーム画面(app/(tabs)/index.tsx)の新規作成モーダルと同じ日付でも下書きが混ざらないよう、
// 画面ごとに別の接頭辞にしている
const DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX = 'diary-day-entries-new-entry-draft-';

// 指定した日付('YYYY-MM-DD')の日記一覧を表示する専用画面(Issue #221)。
// 従来はカレンダー画面(`app/(tabs)/index.tsx`)にモーダル(ドロワー)として重ねて
// 表示していたが、削除時のフェードアウトが途中で止まる不具合の温床になっていたことに加え、
// 編集も専用画面へ遷移させる方針に合わせ、この一覧自体も独立した画面として切り出している。
export default function DayEntriesScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [hasLoadedEntries, setHasLoadedEntries] = useState(false);
  // コピー成功時に一時的に表示するトーストのメッセージ。nullの間は非表示
  const [copyToastMessage, setCopyToastMessage] = useState<string | null>(null);
  // この日の新規作成モーダルを開いているか
  const [isComposerOpen, setIsComposerOpen] = useState(false);

  const tintColor = useThemeColor({}, 'tint');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');
  // このスタック画面はタブバーを持たないため、セーフエリア下端(ホームインジケータ等)ぶんのみ
  // モーダルコンテンツの下端に加算すればよい(タブバー分の加算はapp/(tabs)/index.tsx側のみ必要)
  const insets = useSafeAreaInsets();

  const handleOpenComposer = useCallback(() => {
    setIsComposerOpen(true);
  }, []);

  // ヘッダーのタイトルを対象日付の見出し('YYYY年M月D日')にし、右側に新規作成ボタンを配置する。
  // カレンダー画面側の`_layout.tsx`にはルートごとの静的なタイトルしか設定できないため、
  // paramsに応じた動的なタイトル・アクションはここでnavigation.setOptionsを使って設定する
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
    if (!date) {
      setEntries([]);
      setHasLoadedEntries(true);
      return;
    }
    const allEntries = await getAllDiaryEntries();
    setEntries(
      allEntries
        .filter((entry) => toDateKey(new Date(entry.createdAt)) === date)
        // 各日付内は書かれた時刻の昇順に揃える(カレンダー画面の一覧表示と同じ並び順)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    );
    setHasLoadedEntries(true);
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

  // 新規作成モーダルの保存処理本体。createdAtはその瞬間ではなく、この画面が表示している
  // 日付基準(buildCreatedAtForDateKey)にする(app/(tabs)/index.tsxのhandleSaveNewEntryと同じ方針)
  const handlePersistNewEntry = useCallback(
    async (trimmed: string) => {
      if (!date) {
        return;
      }
      const newEntry: DiaryEntry = {
        id: randomUUID(),
        text: trimmed,
        createdAt: buildCreatedAtForDateKey(date),
      };
      // 体感速度を落とさないよう、即座に現在のstateから計算した内容で楽観的にUIを更新する
      // (この画面の一覧は時刻の昇順のため、末尾に追加する)
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

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      setEntries((current) => current.filter((entry) => entry.id !== entryId));

      try {
        await deleteDiaryEntry(entryId);
      } catch {
        // 永続化に失敗した場合は最新の内容で読み直し、削除前の状態に戻す
        await loadEntries();
        Alert.alert('削除に失敗しました', 'もう一度お試しください。');
      }
    },
    [loadEntries],
  );

  const handleDeletePress = useCallback(
    (entry: DiaryEntry) => {
      Alert.alert('日記を削除しますか?', 'この操作は取り消せません。', [
        { text: 'キャンセル', style: 'cancel' },
        { text: '削除', style: 'destructive', onPress: () => handleDeleteEntry(entry.id) },
      ]);
    },
    [handleDeleteEntry],
  );

  const renderEmptyEntries = useCallback(
    () =>
      hasLoadedEntries ? (
        <ThemedView style={styles.emptyState}>
          <ThemedText style={styles.emptyStateText}>{EMPTY_STATE_MESSAGE}</ThemedText>
        </ThemedView>
      ) : null,
    [hasLoadedEntries],
  );

  return (
    <ThemedView style={styles.container}>
      {copyToastMessage ? (
        <SaveToast message={copyToastMessage} onHide={handleHideCopyToast} testID="copy-toast" />
      ) : null}
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={renderEmptyEntries}
        // 一覧をスクロールした際にもキーボードを閉じられるようにする(他画面のFlatListと同じ方針)
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
        draftStorageKeyPrefix={DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}
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
  },
  emptyStateText: {
    fontSize: 16,
    fontWeight: '600',
    opacity: 0.7,
    textAlign: 'center',
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
