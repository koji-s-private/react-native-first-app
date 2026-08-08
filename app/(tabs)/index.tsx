import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { CalendarProps, DateData } from 'react-native-calendars';
import { Calendar, LocaleConfig } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import {
  decryptText,
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';
import { DIARY_ENTRIES_STORAGE_KEY } from '@/utils/diary-storage';

// 日記データのAsyncStorageキーは、設定画面からの全件削除機能(utils/diary-storage.ts)と
// 共有するため、そちらで定義した定数を参照する
const STORAGE_KEY = DIARY_ENTRIES_STORAGE_KEY;

type DiaryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

// カレンダーの日付セルに表示するタイトルの最大文字数(超える場合は省略記号を付ける)
const TITLE_MAX_LENGTH = 20;

// 日記本文の最大文字数(AsyncStorageのサイズ制限に抵触しないよう、1件あたりの文字数を制限する)
const BODY_MAX_LENGTH = 1000;

// 日付セルの高さのデフォルト最小値(外枠の実測高さがまだ取れていない初回レンダー用のフォールバック)
const DEFAULT_DAY_CELL_HEIGHT = 48;
// 日付セル内のテキスト(日付番号・日記タイトル)に許容するOS文字サイズ設定の最大倍率。
// react-native-calendars自体の月見出し・曜日行は内部実装で常にallowFontScaling={false}が
// 指定されており(theme等では変更不可。node_modules/react-native-calendars/src/calendar/header/index.js
// 参照)OSの文字サイズ設定の影響を受けないが、dayComponentとして差し替えている日付セルの中身は
// このアプリ側のThemedTextであり、そのままでは無制限に拡大されてしまう。拡大を放置すると
// セル内のテキストが1週あたりの行の高さ(dayCellHeight)を超えてはみ出し、calendarWrapperの
// overflow: 'hidden'によって最下段の週が見切れる懸念があるため、拡大率の上限を設けてリスクを抑える
const DAY_CELL_MAX_FONT_SCALE = 1.5;
// showSixWeeksを有効にし、月をまたいでも常に6行で表示を揃えるため6固定で計算する
const CALENDAR_WEEK_ROWS = 6;
// react-native-calendarsのヘッダー(月表示+矢印)と曜日行を合わせたおおよその高さ、および
// 1週間の行に付与される上下マージン(週の行が持つmarginVertical、react-native-calendarsの
// デフォルトのweekVerticalMargin=7を上下2回分)。テーマのフォントサイズ等から算出した概算値であり、
// 実測ではないが、日付セルの高さを外枠の実測高さから一度の計算で求めるための基準として使う
//
// なお、これらの値はOSの文字サイズ設定(Dynamic Type等)によって変化しないため、
// PixelRatio.getFontScale()による補正はあえて行っていない。react-native-calendarsの
// ヘッダー・曜日行を描画するTextコンポーネントは、テーマ等で変更不可能な形で内部実装として
// 常にallowFontScaling={false}が指定されており(node_modules/react-native-calendars/src/calendar/
// header/index.js、src/commons/WeekDaysNames.js参照)、OSの文字サイズ設定の影響を受けない。
// この実装依存のガードは万一将来ライブラリ側の挙動が変わった場合に外れる可能性があるため、
// フォントスケール由来の高さ増加リスクは、実際に可変であるこのアプリ側のセル内テキスト
// (dayNumber/dayEntryTitle、上記のDAY_CELL_MAX_FONT_SCALEで拡大率を制限)側で根本的に
// 抑える方針とし、既に文字サイズ設定の影響を受けないここでの概算値をあえて動かさない
const CALENDAR_CHROME_HEIGHT = 90;
const CALENDAR_WEEK_ROW_MARGIN = 14;

// react-native-calendarsが使うdayComponentのpropsの型(ライブラリ側から直接exportされていないため、
// CalendarPropsから抽出して利用する)
type DayComponentProps = ComponentProps<NonNullable<CalendarProps['dayComponent']>>;

// アプリ全体が日本語UIのため、カレンダーの月名・曜日名・「今日」ボタンの表記も日本語化する
LocaleConfig.locales.ja = {
  monthNames: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  monthNamesShort: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  dayNames: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  dayNamesShort: ['日', '月', '火', '水', '木', '金', '土'],
  today: '今日',
};
LocaleConfig.defaultLocale = 'ja';

// Dateをreact-native-calendarsが使う'YYYY-MM-DD'形式のキーに変換する(端末のローカル日時基準)
function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 日記本文からカレンダーセルに表示する短いタイトルを作る
// (改行があれば最初の行のみを使い、さらに長ければ指定文字数で切り詰める)
function getEntryTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`;
}

// 'YYYY-MM-DD'形式の日付キーをモーダルの見出し用に整形する
function formatDateHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}

// 日記エントリの日時を'YYYY/MM/DD HH:mm'形式で整形する(端末のロケール設定に依存する
// toLocaleString()は使わず、日本語UIで一貫した表記になるよう手動でフォーマットする)
function formatEntryDateTime(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // 一覧表示用にタップされた日付('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // カレンダーの外枠(タイトル・入力欄・保存ボタンの下からタブバーの上までの残りスペースを
  // `flex: 1`で使い切るView)の実測高さ(onLayoutで取得)。この外枠自体に枠線・角丸を付け、
  // 日付グリッドの高さもこの実測値を基準に算出することで、外枠と日付グリッドの基準を一致させる
  const [wrapperHeight, setWrapperHeight] = useState(0);
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
          if (isEncryptedPayload(stored)) {
            const key = await getOrCreateEncryptionKey();
            setEntries(JSON.parse(decryptText(stored, key)) as DiaryEntry[]);
          } else {
            // 暗号化対応前に保存された平文JSON(後方互換)。そのまま読み込んで表示し、
            // 次回保存時から暗号化形式に移行する
            setEntries(JSON.parse(stored) as DiaryEntry[]);
          }
        }
      } catch {
        // ストレージが壊れている・スキーマ不整合・復号失敗の場合は空の状態から始める
        setEntries([]);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = draft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(TextInput側のmaxLengthが主な防御線)
    if (!trimmed || trimmed.length > BODY_MAX_LENGTH) {
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
      // 日記本文を平文のままAsyncStorageに保存しないよう、SecureStoreで保護した鍵で
      // AES-256-GCM暗号化してから保存する
      const key = await getOrCreateEncryptionKey();
      await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(nextEntries), key));
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、ユーザーにエラーを伝える。
      // ただし、保存処理中(この非同期処理の完了を待つ間)にユーザーが既に次の文章を
      // 入力し始めている場合、previousDraftで単純に上書きすると新しい入力を消してしまう。
      // 現在値が保存開始時にセットした空文字列のままであれば(=何も入力していなければ)
      // previousDraftへ戻し、既に何か入力されていればその入力を優先して上書きしない
      setEntries(previousEntries);
      setDraft((current) => (current === '' ? previousDraft : current));
      setSaveError('保存に失敗しました。もう一度お試しください。');
    }
  }, [draft, entries]);

  // 日付ごとに日記をまとめる(カレンダーセルへの表示・タップ時の一覧表示の両方で利用する)
  const entriesByDate = useMemo(() => {
    const map: Record<string, DiaryEntry[]> = {};
    for (const entry of entries) {
      const key = toDateKey(new Date(entry.createdAt));
      if (!map[key]) {
        map[key] = [];
      }
      map[key].push(entry);
    }
    // 各日付内は書かれた時刻の昇順に揃える(「その日最初の1件」が常に先頭に来るように)
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return map;
  }, [entries]);

  // 外枠の実測高さ(wrapperHeight)からヘッダー+曜日行のおおよその高さと6週分の行マージンを差し引き、
  // 残りを6週で均等に割ることで、外枠いっぱいに日付グリッドが広がる日付セルの高さを算出する。
  // (カレンダー本体側の実測値を使って反復的に補正する方式も試したが、react-native-calendarsの
  // 内部レイアウトが確定するタイミングとズレて誤った実測値を拾ってしまい、セルの高さが
  // 異常に大きくなる/更新が反映されないなど不安定だったため、外枠の実測値のみを使う
  // シンプルな一度切りの計算に倒している)
  const dayCellHeight = useMemo(() => {
    if (wrapperHeight <= 0) {
      return DEFAULT_DAY_CELL_HEIGHT;
    }
    const gridHeight = wrapperHeight - CALENDAR_CHROME_HEIGHT;
    const perRowHeight = gridHeight / CALENDAR_WEEK_ROWS - CALENDAR_WEEK_ROW_MARGIN;
    return Math.max(DEFAULT_DAY_CELL_HEIGHT, perRowHeight);
  }, [wrapperHeight]);

  const handleDayPress = useCallback(
    (date: DateData) => {
      // 日記が無い日は何も表示しない(タップしても反応しない)
      if (entriesByDate[date.dateString]?.length) {
        setSelectedDate(date.dateString);
      }
    },
    [entriesByDate],
  );

  const renderDay = useCallback(
    ({ date, state, onPress }: DayComponentProps) => {
      if (!date) {
        return null;
      }

      const dayEntries = entriesByDate[date.dateString];
      // その日に書かれた日記のうち最初の1件のタイトルのみをセルに表示する
      const title = dayEntries?.length ? getEntryTitle(dayEntries[0].text) : null;
      const isDisabled = state === 'disabled' || state === 'inactive';
      const isToday = state === 'today';

      return (
        <Pressable
          style={[styles.dayCell, { height: dayCellHeight }]}
          onPress={() => onPress?.(date)}
          disabled={!title}
          accessibilityRole={title ? 'button' : undefined}
        >
          {isToday ? (
            // 今日のセルは数字を丸背景で囲んで強調する(一般的なカレンダーアプリの表現に合わせる)
            <View style={[styles.todayBadge, { backgroundColor: tintColor }]}>
              <ThemedText
                style={[styles.dayNumber, { color: backgroundColor, fontWeight: '700' as const }]}
                maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
              >
                {date.day}
              </ThemedText>
            </View>
          ) : (
            <ThemedText
              style={[styles.dayNumber, isDisabled ? styles.dayNumberDisabled : undefined]}
              maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
            >
              {date.day}
            </ThemedText>
          )}
          {title ? (
            <ThemedText
              style={[styles.dayEntryTitle, { color: tintColor }]}
              numberOfLines={1}
              maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
            >
              {title}
            </ThemedText>
          ) : null}
        </Pressable>
      );
    },
    [entriesByDate, tintColor, backgroundColor, dayCellHeight],
  );

  const selectedDateEntries = selectedDate ? (entriesByDate[selectedDate] ?? []) : [];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android は SDK 54 で edge-to-edge 表示が常時有効になり、OS標準の
      // windowSoftInputMode(adjustResize相当)によるレイアウト自動リサイズが
      // 効かないケースがあるため、iOS同様にbehaviorを明示的に指定する
      // (undefinedのままだとAndroid実機でキーボード表示時に入力欄・保存ボタンが
      // 隠れる可能性がある。React Native公式ドキュメントでも
      // 「Android and iOS both interact with this prop differently. On both iOS and
      // Android, setting behavior is recommended.」と案内されている)
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
            maxLength={BODY_MAX_LENGTH}
          />
          <View style={styles.composerFooter}>
            {/* 文字数カウンター(上限に近づいた/達したことがひと目で分かるよう常に表示する) */}
            <ThemedText
              style={[
                styles.charCount,
                draft.length >= BODY_MAX_LENGTH ? { color: '#d32f2f' } : { color: iconColor },
              ]}
            >
              {draft.length}/{BODY_MAX_LENGTH}
            </ThemedText>
            <Pressable
              style={[styles.saveButton, { backgroundColor: tintColor }]}
              onPress={handleSave}
              disabled={!draft.trim()}
            >
              <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                保存
              </ThemedText>
            </Pressable>
          </View>
          {saveError ? <ThemedText style={styles.errorText}>{saveError}</ThemedText> : null}
        </ThemedView>

        {entries.length === 0 ? (
          // 日記が1件も保存されていない場合、ラベルの無いカレンダーだけが表示されて
          // 何をすればよいか分かりにくくならないよう、案内メッセージを表示する
          // (カレンダー自体は今後日記を書く導線として引き続き表示しておく)
          <ThemedView style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              まだ日記がありません。最初の日記を書いてみましょう。
            </ThemedText>
          </ThemedView>
        ) : null}

        <View
          style={[styles.calendarWrapper, { borderColor: iconColor, backgroundColor }]}
          onLayout={(event) => setWrapperHeight(event.nativeEvent.layout.height)}
        >
          <Calendar
            theme={{
              backgroundColor,
              calendarBackground: backgroundColor,
              // 曜日行はtextColorを使い、アイコン色より高いコントラストで視認性を確保する
              textSectionTitleColor: textColor,
              textDayHeaderFontWeight: '600',
              dayTextColor: textColor,
              // 月・年の見出しも大きく太字にして、矢印の間で確実に視認できるようにする
              monthTextColor: textColor,
              textMonthFontWeight: '700',
              textMonthFontSize: 18,
              arrowColor: tintColor,
              todayTextColor: tintColor,
            }}
            // 「2026年8月」のように年→月の順で表示する(デフォルトの'MMMM yyyy'は英語の語順のまま
            // 月名だけ日本語化されてしまい不自然なため)
            monthFormat="yyyy年M月"
            dayComponent={renderDay}
            onDayPress={handleDayPress}
            enableSwipeMonths
            // 月によって行数(4〜6週)が変わって高さがガタつかないよう、常に6週分の高さで揃える
            showSixWeeks
          />
        </View>

        <Modal
          visible={selectedDate !== null}
          animationType="slide"
          transparent
          onRequestClose={() => setSelectedDate(null)}
        >
          <View style={styles.modalOverlay}>
            <ThemedView style={[styles.modalContent, { borderColor: iconColor }]}>
              <View style={styles.modalHeader}>
                <ThemedText type="subtitle">
                  {selectedDate ? formatDateHeading(selectedDate) : ''}
                </ThemedText>
                <Pressable onPress={() => setSelectedDate(null)}>
                  <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                    閉じる
                  </ThemedText>
                </Pressable>
              </View>
              <FlatList
                data={selectedDateEntries}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <ThemedView style={[styles.entry, { borderBottomColor: iconColor }]}>
                    <ThemedText style={styles.entryDate}>
                      {formatEntryDateTime(item.createdAt)}
                    </ThemedText>
                    <ThemedText>{item.text}</ThemedText>
                  </ThemedView>
                )}
              />
            </ThemedView>
          </View>
        </Modal>
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
  composerFooter: {
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
    color: '#d32f2f',
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  emptyStateText: {
    opacity: 0.7,
  },
  calendarWrapper: {
    // タイトル・入力欄・保存ボタンの下からタブバーの上までの残りスペースをすべて使い切る。
    // 枠線・角丸もこの外枠に付け、内側の日付グリッドの高さ計算もこの実測高さを基準にすることで、
    // 「外枠と内部の高さ計算の基準がズレて中身がはみ出す」問題が起きないようにする
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    // 実測に多少の誤差があっても、日付グリッドが外枠からはみ出して見えないようにする保険
    overflow: 'hidden',
  },
  dayCell: {
    alignItems: 'center',
    paddingTop: 4,
    gap: 2,
  },
  dayNumber: {
    fontSize: 14,
  },
  dayNumberDisabled: {
    opacity: 0.3,
  },
  todayBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayEntryTitle: {
    fontSize: 10,
    paddingHorizontal: 2,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  modalContent: {
    maxHeight: '70%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalCloseText: {
    fontSize: 16,
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
