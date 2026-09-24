import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Link } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ExternalLink } from '@/components/external-link';
import { SegmentedOptionSelector } from '@/components/segmented-option-selector';
import { TabScreenContainer } from '@/components/tab-screen-container';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SETTINGS_SECTIONS, type SettingsMenuItem } from '@/constants/settings-menu';
import { useAppLock } from '@/contexts/app-lock-context';
import {
  useCalendarLayoutPreference,
  type CalendarLayoutPreference,
} from '@/contexts/calendar-layout-preference-context';
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

// タブバー(デフォルト、セーフエリア分は含まない)のおおよそのコンテンツ高さ。ScrollView最下部が
// タブバーと重ならないよう、insets.bottomと合わせてpaddingBottomに加算する
const BOTTOM_TAB_BAR_CONTENT_HEIGHT = 49;

// 「外観」セクションで選べる配色設定の選択肢。表示順もこの配列の並び順に従う
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: '端末に合わせる' },
];

// アプリ内で配色(ライト/ダーク/端末に合わせる)を選択する操作導線。
// OSの設定に関わらずアプリ内だけで見た目を固定したい、というニーズに対応する。
function AppearanceSection() {
  const { preference, setPreference } = useThemePreference();

  return (
    <ThemedView style={styles.section}>
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        外観
      </ThemedText>
      <SegmentedOptionSelector
        options={THEME_OPTIONS}
        selectedValue={preference}
        onChange={setPreference}
      />
    </ThemedView>
  );
}

// ホーム画面のカレンダー部分で選べる表示レイアウトの選択肢。表示順もこの配列の並び順に従う
const CALENDAR_LAYOUT_OPTIONS: { value: CalendarLayoutPreference; label: string }[] = [
  { value: 'month', label: '月表示' },
  { value: 'week', label: '週表示' },
];

// ホーム画面のカレンダー部分を1ヶ月分まとめて表示するか、1週間分のみ表示するかを選ぶ操作導線。
// 無料ユーザーも利用可能(Pro限定にはしない)
function CalendarLayoutSection() {
  const { layout, setLayout } = useCalendarLayoutPreference();

  return (
    <ThemedView style={styles.section}>
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        カレンダー表示レイアウト
      </ThemedText>
      <SegmentedOptionSelector
        options={CALENDAR_LAYOUT_OPTIONS}
        selectedValue={layout}
        onChange={setLayout}
      />
    </ThemedView>
  );
}

// 長押しでのオートリピート開始までの遅延(ms)。単発タップと区別できる程度の間を持たせる
const STEPPER_REPEAT_START_DELAY_MS = 500;
// オートリピート中に値を増減する間隔(ms)
const STEPPER_REPEAT_INTERVAL_MS = 120;

// TimeStepperの−/+ボタン長押し中に一定間隔で値を増減し続けるオートリピートを実装するフック。
// PressableのonLongPressは単発でしか発火しないためsetIntervalで明示的に反復させる。
// onChange/disabledは再レンダリングで変わりうるため、実行中のタイマーが最新の値を参照できるようrefで保持する
function useStepperAutoRepeat(onChange: () => void, disabled: boolean) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 長押しによるオートリピートが発火済みかどうか。発火済みの場合、指を離した際に届くonPressで
  // さらに1回増減してしまう(単発タップとの二重発火)のを防ぐために使う
  const didRepeatRef = useRef(false);

  const stopRepeating = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // アンマウント時にタイマーが残らないようにする
  useEffect(() => stopRepeating, [stopRepeating]);

  // 非同期処理(通知の再スケジュール登録)が完了するまでは値を進めない。既存のisTimePending等に
  // よる連打防止と同じ方針を、長押し中の連続発火にも適用する
  const fireIfEnabled = useCallback(() => {
    if (!disabledRef.current) {
      onChangeRef.current();
    }
  }, []);

  const handlePressIn = useCallback(() => {
    didRepeatRef.current = false;
    timeoutRef.current = setTimeout(() => {
      didRepeatRef.current = true;
      fireIfEnabled();
      intervalRef.current = setInterval(fireIfEnabled, STEPPER_REPEAT_INTERVAL_MS);
    }, STEPPER_REPEAT_START_DELAY_MS);
  }, [fireIfEnabled]);

  const handlePress = useCallback(() => {
    if (didRepeatRef.current) {
      didRepeatRef.current = false;
      return;
    }
    onChangeRef.current();
  }, []);

  return { onPressIn: handlePressIn, onPressOut: stopRepeating, onPress: handlePress };
}

// 時刻の「時」「分」を1つずつ調整するためのステッパー(−/+ボタン)。
// 外部ライブラリを追加せずに実装するため、ネイティブのタイムピッカーではなく増減ボタン方式にしている
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
  const previousValueRef = useRef(value);
  const shouldAnnounceValueChangeRef = useRef(false);
  const handleDecrease = useCallback(() => {
    shouldAnnounceValueChangeRef.current = true;
    onDecrease();
  }, [onDecrease]);
  const handleIncrease = useCallback(() => {
    shouldAnnounceValueChangeRef.current = true;
    onIncrease();
  }, [onIncrease]);
  const decreaseAutoRepeat = useStepperAutoRepeat(handleDecrease, disabled);
  const increaseAutoRepeat = useStepperAutoRepeat(handleIncrease, disabled);

  useEffect(() => {
    if (
      previousValueRef.current !== value &&
      shouldAnnounceValueChangeRef.current &&
      Platform.OS === 'ios'
    ) {
      AccessibilityInfo.announceForAccessibility(`${label} ${formattedValue}`);
    }
    shouldAnnounceValueChangeRef.current = false;
    previousValueRef.current = value;
  }, [formattedValue, label, value]);

  return (
    <ThemedView style={styles.reminderStepperGroup}>
      <ThemedText style={styles.reminderStepperLabel}>{label}</ThemedText>
      <Pressable
        onPress={decreaseAutoRepeat.onPress}
        onPressIn={decreaseAutoRepeat.onPressIn}
        onPressOut={decreaseAutoRepeat.onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を減らす`}
        accessibilityState={{ disabled }}
        style={[styles.reminderStepButton, { borderColor: tintColor, opacity: disabled ? 0.4 : 1 }]}
      >
        <ThemedText style={[styles.reminderStepButtonText, { color: tintColor }]}>−</ThemedText>
      </Pressable>
      <ThemedText
        accessibilityLabel={`${label} ${formattedValue}`}
        accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
        style={[styles.reminderStepperValue, { opacity: disabled ? 0.4 : 1 }]}
      >
        {formattedValue}
      </ThemedText>
      <Pressable
        onPress={increaseAutoRepeat.onPress}
        onPressIn={increaseAutoRepeat.onPressIn}
        onPressOut={increaseAutoRepeat.onPressOut}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を増やす`}
        accessibilityState={{ disabled }}
        style={[styles.reminderStepButton, { borderColor: tintColor, opacity: disabled ? 0.4 : 1 }]}
      >
        <ThemedText style={[styles.reminderStepButtonText, { color: tintColor }]}>+</ThemedText>
      </Pressable>
    </ThemedView>
  );
}

// 分は1分刻みで細かく調整できてもあまり意味がないため、5分刻みで調整できるようにする
const REMINDER_MINUTE_STEP = 5;

// 日記を書き忘れないよう、毎日決まった時刻に端末通知でリマインドする機能の設定導線。
// 外部のPush通知サービスは使わず、expo-notificationsによる端末内のローカル通知スケジューリングのみで完結させる
function DiaryReminderSection() {
  const { enabled, hour, minute, permissionStatus, isLoaded, setEnabled, setTime } =
    useDiaryReminder();
  // ON/OFF切り替え(通知許可のリクエストを伴う非同期処理)完了まで連続タップを防ぐ
  const [isTogglePending, setIsTogglePending] = useState(false);
  // 時刻変更(通知の再スケジュール登録を伴う非同期処理)完了までTimeStepperの連続タップを防ぐ
  const [isTimePending, setIsTimePending] = useState(false);
  const errorColor = useThemeColor({}, 'error');

  const handleToggle = useCallback(
    (value: boolean) => {
      setIsTogglePending(true);
      setEnabled(value)
        .catch(() => {
          // setEnabledは通知スケジュール登録失敗時に例外を投げ直す(enabled自体はOFFへ戻る)ため、
          // 捕捉してユーザーに案内しないと未処理のPromise rejectionになる
          Alert.alert(
            'リマインダーの設定に失敗しました',
            '通知を設定できませんでした。もう一度お試しください。',
          );
        })
        .finally(() => setIsTogglePending(false));
    },
    [setEnabled],
  );

  const handleScheduleFailure = useCallback(() => {
    // setTimeが再スケジュール失敗時に例外を投げ直す(enabled自体はOFFへ戻される)ため、
    // ここで必ず捕捉してユーザーへ失敗を案内する。捕捉しないと未処理のPromise rejectionになる
    Alert.alert(
      'リマインダー時刻の変更に失敗しました',
      '新しい時刻を通知に反映できませんでした。もう一度お試しください。',
    );
  }, []);

  const handleHourChange = useCallback(
    (delta: number) => {
      setIsTimePending(true);
      setTime((hour + delta + 24) % 24, minute)
        .catch(handleScheduleFailure)
        .finally(() => setIsTimePending(false));
    },
    [hour, minute, setTime, handleScheduleFailure],
  );

  const handleMinuteChange = useCallback(
    (delta: number) => {
      setIsTimePending(true);
      setTime(hour, (minute + delta + 60) % 60)
        .catch(handleScheduleFailure)
        .finally(() => setIsTimePending(false));
    },
    [hour, minute, setTime, handleScheduleFailure],
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
          disabled={isTogglePending || isTimePending || permissionStatus === 'denied'}
        />
        <ThemedText style={styles.reminderTimeSeparator}>:</ThemedText>
        <TimeStepper
          label="分"
          value={minute}
          onDecrease={() => handleMinuteChange(-REMINDER_MINUTE_STEP)}
          onIncrease={() => handleMinuteChange(REMINDER_MINUTE_STEP)}
          disabled={isTogglePending || isTimePending || permissionStatus === 'denied'}
        />
      </ThemedView>
      {permissionStatus === 'denied' && (
        <ThemedText style={[styles.reminderFallbackText, { color: errorColor }]}>
          通知が許可されていないため、リマインダーを利用できません。端末の設定からこのアプリの通知を許可してください。
        </ThemedText>
      )}
      {isLoaded && !enabled && permissionStatus !== 'denied' && (
        // OFFのうちに時刻を決めてからONにできるよう操作は無効化せず、通知に反映されない旨だけ案内する
        <ThemedText style={styles.reminderHintText}>
          リマインダーがOFFのため通知は届きません。ここで設定した時刻は、ONにしたときの通知時刻になります。
        </ThemedText>
      )}
    </ThemedView>
  );
}

// アプリ起動時・バックグラウンドから復帰した際に生体認証(またはOS標準パスコード)でロックする機能。
// 端末を家族・同僚と共有・一時的に貸す際の覗き見を防ぐ。既存ユーザーの体験を変えないよう既定値はOFF(オプトイン)
function AppLockSection() {
  const { enabled, isSupported, setEnabled } = useAppLock();
  // ON/OFF切り替え(AsyncStorageへの永続化を伴う非同期処理)完了までの連続タップを防ぐ
  const [isTogglePending, setIsTogglePending] = useState(false);
  const errorColor = useThemeColor({}, 'error');

  const handleToggle = useCallback(
    (value: boolean) => {
      setIsTogglePending(true);
      setEnabled(value)
        .catch(() => {
          // setEnabledは永続化失敗時に例外を投げ直す(enabled自体は変更前に戻る)ため、
          // 捕捉してユーザーに案内しないと未処理のPromise rejectionになる
          Alert.alert(
            'アプリロックの設定に失敗しました',
            '設定を保存できませんでした。もう一度お試しください。',
          );
        })
        .finally(() => setIsTogglePending(false));
    },
    [setEnabled],
  );

  return (
    <ThemedView style={styles.section}>
      <ThemedText type="subtitle" style={styles.sectionTitle}>
        アプリロック
      </ThemedText>
      <ThemedView style={styles.reminderToggleRow}>
        <ThemedText style={styles.reminderToggleLabel}>
          起動時・復帰時に生体認証またはパスコードでロックする
        </ThemedText>
        <Switch
          value={enabled}
          onValueChange={handleToggle}
          disabled={isTogglePending || !isSupported}
          accessibilityLabel="アプリロック"
        />
      </ThemedView>
      {!isSupported && (
        <ThemedText style={[styles.reminderFallbackText, { color: errorColor }]}>
          この端末では生体認証・パスコードが設定されていないため、アプリロックを利用できません。
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
// Google Play/Apple双方のストア審査で求められる「ユーザーによるデータ削除手段」に対応する
function DeleteAllDiaryDataButton() {
  const [isDeleting, setIsDeleting] = useState(false);
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

// Web(ブラウザ)はexpo-file-system/expo-sharingの端末ネイティブなファイルシステム・共有シートを
// 利用できないため、ブラウザ標準のBlob + <a download>によるダウンロードでエクスポートする
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
// 保存・共有できるようにする操作導線。端末紛失・機種変更等でのデータ消失に備えたバックアップ手段
function ExportDiaryDataButton() {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      // entries.length === 0だけでは「本当に0件」か「読み込み失敗」かを区別できないため、
      // onErrorで検知してメッセージを出し分ける
      let hasLoadError = false;
      const entries = await getAllDiaryEntries({
        onError: () => {
          hasLoadError = true;
        },
      });
      if (hasLoadError) {
        Alert.alert(
          '日記データを読み込めませんでした',
          'エクスポートを完了できませんでした。アプリを再起動しても解決しない場合は端末の復元設定をご確認ください。',
        );
        return;
      }
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

      // ネイティブ(iOS/Android)は一旦キャッシュディレクトリにJSONファイルを書き出してから
      // OS標準の共有シートで共有する。ディレクトリ取得失敗時の例外は外側のtry-catchで捕捉される
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

// Webはexpo-file-systemのファイルシステムAPIに対応していないため、DocumentPickerAssetが
// ブラウザ標準の`File`として返す`asset.file`から直接読み込む(`downloadOnWeb`と同様の別経路)
async function readPickedFileContent(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  if (Platform.OS === 'web') {
    if (!asset.file) {
      throw new Error('選択したファイルを読み込めませんでした');
    }
    return asset.file.text();
  }
  return new File(asset.uri).text();
}

// ExportDiaryDataButtonで書き出したJSONファイルを選択し、日記データとして取り込む操作導線。
// 既存データは削除せず追加し、idが重複する場合はインポート側の内容で上書きする(全置換は行わない)。
// `saveDiaryEntry`がidをキーに個別保存するため、この上書き挙動は特別な実装なしに実現できる
function ImportDiaryDataButton() {
  const [isImporting, setIsImporting] = useState(false);

  const importEntries = useCallback(async (entries: DiaryEntry[]) => {
    // 逐次保存のため、途中で失敗しても直前までのエントリは保存済みのまま残る。
    // 「全く反映されなかった」という誤認を防ぐため、失敗時は成功済み件数を伝える。
    let succeededCount = 0;
    try {
      // 暗号鍵未生成の状態で並列保存すると、各呼び出しが別々の鍵を生成し合って
      // 書き込みを取り合い、データが消失し得るため、あえて逐次保存にしている
      for (const entry of entries) {
        await saveDiaryEntry(entry);
        succeededCount += 1;
      }
      Alert.alert('インポートが完了しました', `${entries.length}件の日記データを取り込みました。`);
    } catch {
      Alert.alert(
        'インポートに失敗しました',
        `${entries.length}件中${succeededCount}件を取り込んだ時点で失敗しました。もう一度お試しください。`,
      );
    } finally {
      setIsImporting(false);
    }
  }, []);

  const confirmImport = useCallback(
    (entries: DiaryEntry[], invalidCount: number) => {
      // 誤操作による意図しない上書きを防ぐため、取り込み前に件数を示して確認する
      // (無効なエントリが除外されていた場合は、その件数もあわせて伝える)
      const skippedNotice =
        invalidCount > 0
          ? `\n${invalidCount}件のデータは形式が正しくないか文字数上限を超えていたためスキップされました。`
          : '';
      Alert.alert(
        '日記データをインポートしますか?',
        `${entries.length}件の日記データを取り込みます。同じ日記が既にある場合は、ファイルの内容で上書きされます。${skippedNotice}`,
        [
          { text: 'キャンセル', style: 'cancel', onPress: () => setIsImporting(false) },
          { text: '取り込む', onPress: () => importEntries(entries) },
        ],
        // Androidは既定でcancelable: falseのため、戻る操作・外側タップで閉じられるようにした上で、
        // ボタンのonPressが呼ばれないその場合もonDismissで解除し、取り込みボタンの固着を防ぐ
        { cancelable: true, onDismiss: () => setIsImporting(false) },
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

      confirmImport(validEntries, invalidCount);
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
  const insets = useSafeAreaInsets();
  // ScrollViewの最下部(データ管理セクション)がタブバーの下に隠れて操作できなくならないよう、
  // セーフエリア下端の分もあわせてpaddingBottomに加算する
  const contentBottomPadding = 16 + insets.bottom + BOTTOM_TAB_BAR_CONTENT_HEIGHT;

  return (
    // ステータスバー/ノッチ領域とコンテンツが重ならないよう、TabScreenContainerでセーフエリア上端の余白を加算する
    <TabScreenContainer style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: contentBottomPadding }]}
      >
        <AppearanceSection />
        <CalendarLayoutSection />
        <DiaryReminderSection />
        <AppLockSection />

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
      </ScrollView>
    </TabScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
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
  reminderHintText: {
    marginTop: 12,
    fontSize: 13,
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
