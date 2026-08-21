import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Link } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { TabScreenContainer } from '@/components/tab-screen-container';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SETTINGS_SECTIONS, type SettingsMenuItem } from '@/constants/settings-menu';
import { useDiaryReminder } from '@/contexts/diary-reminder-context';
import { useThemePreference, type ThemePreference } from '@/contexts/theme-preference-context';
import { useThemeColor } from '@/hooks/use-theme-color';
import { buildDiaryExportFileName, serializeDiaryEntriesForExport } from '@/utils/diary-export';
import { parseDiaryEntriesForImport } from '@/utils/diary-import';
import {
  clearAllDiaryEntries,
  getAllDiaryEntries,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

// 「外観」セクションで選べる配色設定の選択肢。表示順もこの配列の並び順に従う
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: '端末に合わせる' },
];

// アプリ内で配色(ライト/ダーク/端末に合わせる)を選択する操作導線(Issue #91)。
// OSの設定に関わらずアプリ内だけで見た目を固定したい、というニーズに対応する。
function AppearanceSection() {
  const { preference, setPreference } = useThemePreference();
  const tintColor = useThemeColor({}, 'tint');
  // 選択中のボタンはtintColorを背景に敷くため、文字色は背景色(ライト/ダークで反転する色)を使い
  // コントラストを確保する
  const selectedTextColor = useThemeColor({}, 'background');

  return (
    <ThemedView style={styles.section}>
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        外観
      </ThemedText>
      <ThemedView style={styles.themeOptionsRow}>
        {THEME_OPTIONS.map((option) => {
          const isSelected = preference === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setPreference(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              style={[
                styles.themeOptionButton,
                { borderColor: tintColor },
                isSelected && { backgroundColor: tintColor },
              ]}
            >
              <ThemedText
                style={[
                  styles.themeOptionText,
                  isSelected ? { color: selectedTextColor } : { color: tintColor },
                ]}
              >
                {option.label}
              </ThemedText>
            </Pressable>
          );
        })}
      </ThemedView>
    </ThemedView>
  );
}

// 時刻の「時」「分」を1つずつ調整するためのステッパー(−/+ボタン)。
// 端末に標準搭載のネイティブなタイムピッカーは使わず、外部ライブラリを追加せずに実装するため、
// シンプルな増減ボタンで時刻を選べるようにしている
function TimeStepper({
  label,
  value,
  onDecrease,
  onIncrease,
  disabled,
}: {
  label: string;
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
  disabled: boolean;
}) {
  const tintColor = useThemeColor({}, 'tint');
  const formattedValue = String(value).padStart(2, '0');

  return (
    <ThemedView style={styles.reminderStepperGroup}>
      <ThemedText style={styles.reminderStepperLabel}>{label}</ThemedText>
      <Pressable
        onPress={onDecrease}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を減らす`}
        style={[styles.reminderStepButton, { borderColor: tintColor }]}
      >
        <ThemedText style={[styles.reminderStepButtonText, { color: tintColor }]}>−</ThemedText>
      </Pressable>
      <ThemedText style={styles.reminderStepperValue}>{formattedValue}</ThemedText>
      <Pressable
        onPress={onIncrease}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を増やす`}
        style={[styles.reminderStepButton, { borderColor: tintColor }]}
      >
        <ThemedText style={[styles.reminderStepButtonText, { color: tintColor }]}>+</ThemedText>
      </Pressable>
    </ThemedView>
  );
}

// 分は1分刻みで細かく調整できてもあまり意味がないため、5分刻みで調整できるようにする
const REMINDER_MINUTE_STEP = 5;

// 日記を書き忘れないよう、毎日決まった時刻に端末通知でリマインドする機能の設定導線(Issue #92)。
// 外部のPush通知サービスは使わず、expo-notificationsによる端末内のローカル通知スケジューリングのみで
// 完結させている。通知が許可されていない場合は、その旨をこの画面内で案内する(フォールバック表示)。
function DiaryReminderSection() {
  const { enabled, hour, minute, permissionStatus, setEnabled, setTime } = useDiaryReminder();
  // ON/OFF切り替え(通知許可のリクエストを伴う非同期処理)が完了するまで、
  // 誤って連続でタップされないようにするための状態
  const [isTogglePending, setIsTogglePending] = useState(false);
  // 破壊的な操作・警告であることを示す強調色(テーマに応じてconstants/theme.tsから取得)
  const errorColor = useThemeColor({}, 'error');

  const handleToggle = useCallback(
    (value: boolean) => {
      setIsTogglePending(true);
      setEnabled(value)
        .catch(() => {
          // setEnabledがONへの通知スケジュール登録失敗時に例外を投げ直す(enabled自体は
          // OFFへ戻される)ため、ここで必ず捕捉してユーザーへ失敗を案内する。
          // 捕捉しないと未処理のPromise rejectionになってしまう
          Alert.alert(
            'リマインダーの設定に失敗しました',
            '通知を設定できませんでした。もう一度お試しください。',
          );
        })
        .finally(() => setIsTogglePending(false));
    },
    [setEnabled],
  );

  const handleHourChange = useCallback(
    (delta: number) => {
      setTime((hour + delta + 24) % 24, minute);
    },
    [hour, minute, setTime],
  );

  const handleMinuteChange = useCallback(
    (delta: number) => {
      setTime(hour, (minute + delta + 60) % 60);
    },
    [hour, minute, setTime],
  );

  return (
    <ThemedView style={styles.section}>
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        リマインダー
      </ThemedText>
      <ThemedView style={styles.reminderToggleRow}>
        <ThemedText style={styles.reminderToggleLabel}>
          毎日決まった時刻に日記を書くお知らせをする
        </ThemedText>
        <Switch
          value={enabled}
          onValueChange={handleToggle}
          disabled={isTogglePending}
          accessibilityLabel="日記リマインダー通知"
        />
      </ThemedView>
      <ThemedView style={styles.reminderTimeRow}>
        <ThemedText style={styles.reminderTimeRowLabel}>通知時刻</ThemedText>
        <TimeStepper
          label="時"
          value={hour}
          onDecrease={() => handleHourChange(-1)}
          onIncrease={() => handleHourChange(1)}
          disabled={isTogglePending}
        />
        <ThemedText style={styles.reminderTimeSeparator}>:</ThemedText>
        <TimeStepper
          label="分"
          value={minute}
          onDecrease={() => handleMinuteChange(-REMINDER_MINUTE_STEP)}
          onIncrease={() => handleMinuteChange(REMINDER_MINUTE_STEP)}
          disabled={isTogglePending}
        />
      </ThemedView>
      {permissionStatus === 'denied' && (
        <ThemedText style={[styles.reminderFallbackText, { color: errorColor }]}>
          通知が許可されていないため、リマインダーを利用できません。端末の設定からこのアプリの通知を許可してください。
        </ThemedText>
      )}
    </ThemedView>
  );
}

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
  // 破壊的な操作(データ削除)であることを示す強調色(テーマに応じてconstants/theme.tsから取得)
  const errorColor = useThemeColor({}, 'error');

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await clearAllDiaryEntries();
      Alert.alert('削除が完了しました', '保存されていた日記データをすべて削除しました。');
    } catch {
      Alert.alert('削除に失敗しました', 'もう一度お試しください。');
    } finally {
      setIsDeleting(false);
    }
  }, []);

  const handlePress = useCallback(() => {
    // 誤操作による日記データの消失を防ぐため、削除前に必ず確認ダイアログを挟む
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
      accessibilityState={{ disabled: isDeleting }}
      style={[styles.dangerButton, { opacity: isDeleting ? 0.5 : 1 }]}
    >
      <ThemedText style={[styles.dangerButtonText, { color: errorColor }]}>
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
      // OS標準の共有シートでそのファイルを共有する。
      // キャッシュディレクトリが取得できない場合はPaths.cache/Fileのコンストラクタが例外を
      // 送出するため、この関数を囲むtry-catchでまとめて捕捉される
      const file = new File(Paths.cache, fileName);
      file.write(content);
      const fileUri = file.uri;

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
      accessibilityState={{ disabled: isExporting }}
      style={[styles.exportButton, { opacity: isExporting ? 0.5 : 1 }]}
    >
      <ThemedText type="link">日記データをエクスポート</ThemedText>
    </Pressable>
  );
}

// ネイティブ(iOS/Android)は選択されたファイルのURIをexpo-file-systemの`File`で読み込むが、
// Webはexpo-file-systemのファイルシステムAPIに対応していないため、
// DocumentPickerAssetがブラウザ標準の`File`オブジェクトとして返す`asset.file`から直接読み込む
// (`downloadOnWeb`と同様、Web版だけ別経路になる)。
async function readPickedFileContent(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  if (Platform.OS === 'web') {
    if (!asset.file) {
      throw new Error('選択したファイルを読み込めませんでした');
    }
    return asset.file.text();
  }
  return new File(asset.uri).text();
}

// ExportDiaryDataButtonで書き出したJSONファイルを選択し、日記データとして取り込む操作導線(Issue #154)。
// 端末紛失・機種変更時のバックアップ復元や、他の端末でエクスポートしたデータの持ち込みに対応する。
//
// マージ方針: 既存データは削除せず、インポートしたエントリを追加する。idが重複する場合は
// インポートするファイル側の内容で上書きする(バックアップ復元時、最新のエクスポート内容を
// 反映したいというユースケースを優先し、全置換は行わない)。`saveDiaryEntry`がエントリのidを
// キーに個別保存するため、この上書き挙動は特別な実装をせずとも自然に実現できる。
function ImportDiaryDataButton() {
  const [isImporting, setIsImporting] = useState(false);

  const importEntries = useCallback(async (entries: DiaryEntry[]) => {
    try {
      // 暗号鍵未生成の状態で並列保存すると、各呼び出しが別々の鍵を生成し合って
      // 書き込みを取り合い、データが消失し得るため、あえて逐次保存にしている
      for (const entry of entries) {
        await saveDiaryEntry(entry);
      }
      Alert.alert('インポートが完了しました', `${entries.length}件の日記データを取り込みました。`);
    } catch {
      Alert.alert('インポートに失敗しました', 'もう一度お試しください。');
    } finally {
      setIsImporting(false);
    }
  }, []);

  const confirmImport = useCallback(
    (entries: DiaryEntry[]) => {
      // 誤操作による意図しない上書きを防ぐため、取り込み前に件数を示して確認する
      Alert.alert(
        '日記データをインポートしますか?',
        `${entries.length}件の日記データを取り込みます。同じ日記が既にある場合は、ファイルの内容で上書きされます。`,
        [
          { text: 'キャンセル', style: 'cancel', onPress: () => setIsImporting(false) },
          { text: '取り込む', onPress: () => importEntries(entries) },
        ],
      );
    },
    [importEntries],
  );

  const handlePress = useCallback(async () => {
    setIsImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
      if (result.canceled || result.assets.length === 0) {
        setIsImporting(false);
        return;
      }

      const content = await readPickedFileContent(result.assets[0]);
      const { validEntries, invalidCount } = parseDiaryEntriesForImport(content);

      if (invalidCount > 0) {
        // サイレントにスキップするとデータ欠落に誰も気づけないため、開発者向けにログを残す
        // (getAllDiaryEntriesの壊れたエントリ対応と同じ方針)
        console.warn(`ImportDiaryDataButton: ${invalidCount}件の不正なエントリをスキップしました`);
      }

      if (validEntries.length === 0) {
        Alert.alert(
          'インポートできる日記データがありません',
          '選択したファイルに有効な日記データが含まれていませんでした。',
        );
        setIsImporting(false);
        return;
      }

      confirmImport(validEntries);
    } catch {
      Alert.alert(
        'インポートに失敗しました',
        '選択したファイルを読み込めませんでした。ファイルの形式を確認してもう一度お試しください。',
      );
      setIsImporting(false);
    }
  }, [confirmImport]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={isImporting}
      accessibilityRole="button"
      accessibilityState={{ disabled: isImporting }}
      style={[styles.exportButton, { opacity: isImporting ? 0.5 : 1 }]}
    >
      <ThemedText type="link">日記データをインポート</ThemedText>
    </Pressable>
  );
}

export default function SettingsScreen() {
  return (
    // ステータスバー/ノッチ領域とコンテンツが重ならないよう、TabScreenContainerで
    // セーフエリア上端インセットぶんの余白を自動的に加算する(Issue #125)
    <TabScreenContainer style={styles.container}>
      <AppearanceSection />
      <DiaryReminderSection />

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
          <ImportDiaryDataButton />
        </ThemedView>
        <ThemedView style={styles.item}>
          <DeleteAllDiaryDataButton />
        </ThemedView>
      </ThemedView>
    </TabScreenContainer>
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
  themeOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  themeOptionButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  themeOptionText: {
    fontWeight: '600',
  },
  reminderToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  reminderToggleLabel: {
    flex: 1,
  },
  reminderTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  reminderTimeRowLabel: {
    marginRight: 4,
  },
  reminderTimeSeparator: {
    fontWeight: '600',
  },
  reminderStepperGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reminderStepperLabel: {
    fontSize: 13,
  },
  reminderStepperValue: {
    minWidth: 28,
    textAlign: 'center',
    fontWeight: '600',
  },
  reminderStepButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderStepButtonText: {
    fontWeight: '600',
  },
  reminderFallbackText: {
    marginTop: 12,
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
