import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';

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
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        setEntries(JSON.parse(stored) as DiaryEntry[]);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }

    const newEntry: DiaryEntry = {
      id: Date.now().toString(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const nextEntries = [newEntry, ...entries];

    setEntries(nextEntries);
    setDraft('');
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries));
  }, [draft, entries]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={styles.title}>
          日記
        </ThemedText>

        <ThemedView style={styles.composer}>
          <TextInput
            style={[styles.input, { color: textColor, borderColor: tintColor }]}
            placeholder="今日の出来事や気持ちを書いてみましょう"
            placeholderTextColor="#687076"
            value={draft}
            onChangeText={setDraft}
            multiline
          />
          <Pressable
            style={[styles.saveButton, { backgroundColor: tintColor }]}
            onPress={handleSave}
            disabled={!draft.trim()}>
            <ThemedText style={styles.saveButtonText}>保存</ThemedText>
          </Pressable>
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
              <ThemedView style={styles.entry}>
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
    color: '#fff',
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
    borderBottomColor: '#687076',
  },
  entryDate: {
    fontSize: 12,
    opacity: 0.6,
  },
});
