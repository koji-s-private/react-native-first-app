import { Link } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SETTINGS_SECTIONS, type SettingsMenuItem } from '@/constants/settings-menu';
import { clearAllDiaryEntries } from '@/utils/diary-storage';

// 破壊的な操作(データ削除)であることを示す強調色。app/(tabs)/index.tsxのerrorTextと同じ色を使い、
// アプリ内での「注意喚起色」の表現を統一する
const DANGER_COLOR = '#d32f2f';

// メニュー項目の種類に応じて、外部ブラウザ/アプリ内遷移/メールアプリのいずれかで開くリンクを描画する
function SettingsMenuLink({ item }: { item: SettingsMenuItem }) {
  if (item.type === 'internal') {
    return (
      <Link href={item.href}>
        <ThemedText type="link">{item.label}</ThemedText>
      </Link>
    );
  }

  if (item.type === 'mailto') {
    // mailto:リンクはアプリ内ブラウザで開く対象ではないため、
    // ExternalLinkではなくexpo-routerのLinkでそのままメールアプリに委譲する
    return (
      <Link href={item.href}>
        <ThemedText type="link">{item.label}</ThemedText>
      </Link>
    );
  }

  return (
    <ExternalLink href={item.href}>
      <ThemedText type="link">{item.label}</ThemedText>
    </ExternalLink>
  );
}

// 保存済みの日記データ(AsyncStorage上の全件)を削除する操作導線。
// Google Play/Apple双方のストア審査で求められる「ユーザーによるデータ削除手段」に対応するため、
// 設定画面から誤操作しにくい形(確認ダイアログ経由)で削除できるようにする。
function DeleteAllDiaryDataButton() {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await clearAllDiaryEntries();
      // 削除が完了したことをユーザーに伝える(既存のAlertベースの確認フローに合わせたフィードバック)
      Alert.alert('削除が完了しました', '保存されていた日記データをすべて削除しました。');
    } catch {
      Alert.alert('削除に失敗しました', 'もう一度お試しください。');
    } finally {
      setIsDeleting(false);
    }
  }, []);

  const handlePress = useCallback(() => {
    // 誤操作による日記データの消失を防ぐため、削除前に必ず確認ダイアログを挟む
    // (キャンセルすると何も削除されない)
    Alert.alert(
      '日記データを削除しますか?',
      'この端末に保存されているすべての日記データが削除されます。この操作は取り消せません。',
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: '削除する', style: 'destructive', onPress: handleDelete },
      ],
    );
  }, [handleDelete]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDeleting}
      accessibilityRole="button"
      style={styles.dangerButton}
    >
      <ThemedText style={[styles.dangerButtonText, { color: DANGER_COLOR }]}>
        日記データを全件削除
      </ThemedText>
    </Pressable>
  );
}

export default function SettingsScreen() {
  return (
    <ThemedView style={styles.container}>
      {SETTINGS_SECTIONS.map((section) => (
        <ThemedView key={section.key} style={styles.section}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>
            {section.title}
          </ThemedText>
          {section.items.map((item) => (
            <ThemedView key={item.key} style={styles.item}>
              <SettingsMenuLink item={item} />
            </ThemedView>
          ))}
        </ThemedView>
      ))}

      <ThemedView style={styles.section}>
        <ThemedText type="subtitle" style={styles.sectionTitle}>
          データ管理
        </ThemedText>
        <ThemedView style={styles.item}>
          <DeleteAllDiaryDataButton />
        </ThemedView>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    marginBottom: 8,
  },
  item: {
    marginBottom: 12,
  },
  dangerButton: {
    alignSelf: 'flex-start',
  },
  dangerButtonText: {
    fontWeight: '600',
  },
});
