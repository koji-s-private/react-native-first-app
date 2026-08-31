import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { SaveToast } from '@/components/save-toast';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import { formatDateHeading, formatEntryDateTime, toDateKey } from '@/utils/diary-date';
import { deleteDiaryEntry, getAllDiaryEntries, type DiaryEntry } from '@/utils/diary-storage';

// コピー成功時に一時的に表示するトーストのメッセージ
const COPY_SUCCESS_MESSAGE = 'コピーしました';
const EMPTY_STATE_MESSAGE = 'この日の日記はまだありません';

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

  const tintColor = useThemeColor({}, 'tint');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  // ヘッダーのタイトルを対象日付の見出し('YYYY年M月D日')にする。カレンダー画面側の
  // `_layout.tsx`にはルートごとの静的なタイトルしか設定できないため、paramsに応じた
  // 動的なタイトルはここでnavigation.setOptionsを使って設定する
  useEffect(() => {
    navigation.setOptions({ title: date ? formatDateHeading(date) : '' });
  }, [navigation, date]);

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
                <Pressable onPress={() => handleStartEdit(item)} hitSlop={8}>
                  <ThemedText style={[styles.entryActionText, { color: tintColor }]}>
                    編集
                  </ThemedText>
                </Pressable>
                <Pressable onPress={() => handleDeletePress(item)} hitSlop={8}>
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
