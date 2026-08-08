import * as FileSystem from 'expo-file-system/legacy';
import { Link } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SETTINGS_SECTIONS, type SettingsMenuItem } from '@/constants/settings-menu';
import { buildDiaryExportFileName, serializeDiaryEntriesForExport } from '@/utils/diary-export';
import { clearAllDiaryEntries, getAllDiaryEntries } from '@/utils/diary-storage';

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

// Web(ブラウザ)ではexpo-file-system/expo-sharingの双方が端末ネイティブのファイルシステム・
// 共有シートを持たないため利用できない(FileSystem.cacheDirectoryはnull、Sharing.isAvailableAsync()も
// navigator.shareが無い一般的なデスクトップブラウザではfalseを返す)。その代わりに、ブラウザ標準の
// Blob + <a download>によるファイルダウンロードでエクスポートを実現する。
function downloadOnWeb(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 保存済みの日記データ(復号済み)をJSON形式のファイルに書き出し、OS標準の共有シート経由で
// 保存・共有できるようにする操作導線。端末紛失・機種変更・アプリ再インストール・ストレージ
// クリア時にAsyncStorageのデータが失われる問題への対策(Issue #51)。
function ExportDiaryDataButton() {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const entries = await getAllDiaryEntries();
      if (entries.length === 0) {
        // 空の状態で共有シートを開いても意味が無いため、その旨を伝えて終了する
        Alert.alert(
          'エクスポートできる日記データがありません',
          '日記を書いてからもう一度お試しください。',
        );
        return;
      }

      const fileName = buildDiaryExportFileName();
      const content = serializeDiaryEntriesForExport(entries);

      if (Platform.OS === 'web') {
        downloadOnWeb(fileName, content);
        return;
      }

      // ネイティブ(iOS/Android)は一旦キャッシュディレクトリにJSONファイルを書き出してから、
      // OS標準の共有シートでそのファイルを共有する
      if (!FileSystem.cacheDirectory) {
        // 型上はnullを許容するが、iOS/Androidの実機・シミュレーターでnullになることは想定しない
        throw new Error('キャッシュディレクトリを取得できませんでした');
      }
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, content);

      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (!isSharingAvailable) {
        Alert.alert(
          '共有機能を利用できません',
          'この端末では共有機能を利用できないため、エクスポートを完了できませんでした。',
        );
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: 'application/json',
        dialogTitle: '日記データをエクスポート',
        UTI: 'public.json',
      });
    } catch {
      Alert.alert('エクスポートに失敗しました', 'もう一度お試しください。');
    } finally {
      setIsExporting(false);
    }
  }, []);

  return (
    <Pressable
      onPress={handleExport}
      disabled={isExporting}
      accessibilityRole="button"
      style={styles.exportButton}
    >
      <ThemedText type="link">日記データをエクスポート</ThemedText>
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
          <ExportDiaryDataButton />
        </ThemedView>
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
  exportButton: {
    alignSelf: 'flex-start',
  },
  dangerButton: {
    alignSelf: 'flex-start',
  },
  dangerButtonText: {
    fontWeight: '600',
  },
});
