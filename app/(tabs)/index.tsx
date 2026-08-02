import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';

const STORAGE_KEY = 'diary-entries';

type DiaryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // ノッチ/Dynamic Island・ステータスバーとタイトルが重ならないよう、上端のセーフエリアインセットを取得する
  const insets = useSafeAreaInsets();
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored) {
          setEntries(JSON.parse(stored) as DiaryEntry[]);
        }
      } catch {
        // ストレージが壊れている・スキーマ不整合の場合は空の状態から始める
        setEntries([]);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }

    const newEntry: DiaryEntry = {
      // Date.now().toString() は同一ミリ秒での衝突リスクがあるため、
      // 衝突しにくいUUID v4を生成するexpo-cryptoのrandomUUID()を使用する
      id: randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const previousEntries = entries;
    const previousDraft = draft;
    const nextEntries = [newEntry, ...entries];

    setEntries(nextEntries);
    setDraft('');
    setSaveError(null);

    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries));
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、ユーザーにエラーを伝える
      setEntries(previousEntries);
      setDraft(previousDraft);
      setSaveError('保存に失敗しました。もう一度お試しください。');
    }
  }, [draft, entries]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={[styles.title, { marginTop: insets.top + 8 }]}>
          日記
        </ThemedText>

        <ThemedView style={styles.composer}>
          <TextInput
            style={[styles.input, { color: textColor, borderColor: tintColor }]}
            placeholder="今日の出来事や気持ちを書いてみましょう"
            placeholderTextColor={iconColor}
            value={draft}
            onChangeText={setDraft}
            multiline
          />
          <Pressable
            style={[styles.saveButton, { backgroundColor: tintColor }]}
            onPress={handleSave}
            disabled={!draft.trim()}
          >
            <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
              保存
            </ThemedText>
          </Pressable>
          {saveError ? <ThemedText style={styles.errorText}>{saveError}</ThemedText> : null}
        </ThemedView>

        {entries.length === 0 ? (
          <ThemedView style={styles.emptyState}>
            <ThemedText>まだ日記がありません。最初の日記を書いてみましょう。</ThemedText>
          </ThemedView>
        ) : (
          <FlatList
            style={styles.list}
            data={entries}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <ThemedView style={[styles.entry, { borderBottomColor: iconColor }]}>
                <ThemedText style={styles.entryDate}>
                  {new Date(item.createdAt).toLocaleString()}
                </ThemedText>
                <ThemedText>{item.text}</ThemedText>
              </ThemedView>
            )}
          />
        )}
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
    gap: 16,
  },
  title: {
    // 実際のmarginTopはセーフエリアの上端インセットを加算してインライン指定するため、
    // ここでの値はセーフエリア情報が取得できない場合のフォールバック用のベース余白
    marginTop: 8,
  },
  composer: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    fontSize: 16,
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
    color: '#d32f2f',
    fontSize: 14,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    flex: 1,
  },
  entry: {
    gap: 4,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  entryDate: {
    fontSize: 12,
    opacity: 0.6,
  },
});
