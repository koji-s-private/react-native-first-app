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

const STORAGE_KEY = 'diary-entries';

type DiaryEntry = {
  id: string;
  text: string;
  createdAt: string;
};

// カレンダーの日付セルに表示するタイトルの最大文字数(超える場合は省略記号を付ける)
const TITLE_MAX_LENGTH = 20;

// 日付セルの高さのデフォルト最小値(カレンダーの実測高さがまだ取れていない初回レンダー用のフォールバック)
const DEFAULT_DAY_CELL_MIN_HEIGHT = 48;
// カレンダーのヘッダー(月表示+矢印)と曜日行を合わせたおおよその高さ(実測ではなく概算値)。
// 日付グリッドに割り当てられる高さを求めるために、カレンダー全体の実測高さから差し引く
const CALENDAR_CHROME_HEIGHT = 100;
// showSixWeeksを有効にし、月をまたいでも常に6行で表示を揃えるため6固定で計算する
const CALENDAR_WEEK_ROWS = 6;

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

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // 一覧表示用にタップされた日付('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // カレンダーを包むViewの実測高さ(onLayoutで取得)。react-native-calendarsは内部で
  // ジェスチャー認識用の無スタイルなViewでラップされており、`flex: 1`を渡しても
  // 残りの縦スペースまで自動で広がらないため、実測高さから日付セルの高さを逆算して埋める
  const [calendarHeight, setCalendarHeight] = useState(0);
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

  // カレンダー下に大きな空白が残らないよう、実測した高さに応じて日付セルの高さを広げる
  const dayCellMinHeight = useMemo(() => {
    if (calendarHeight <= 0) {
      return DEFAULT_DAY_CELL_MIN_HEIGHT;
    }
    const availableHeight = calendarHeight - CALENDAR_CHROME_HEIGHT;
    return Math.max(DEFAULT_DAY_CELL_MIN_HEIGHT, availableHeight / CALENDAR_WEEK_ROWS);
  }, [calendarHeight]);

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
          style={[styles.dayCell, { minHeight: dayCellMinHeight }]}
          onPress={() => onPress?.(date)}
          disabled={!title}
          accessibilityRole={title ? 'button' : undefined}
        >
          {isToday ? (
            // 今日のセルは数字を丸背景で囲んで強調する(一般的なカレンダーアプリの表現に合わせる)
            <View style={[styles.todayBadge, { backgroundColor: tintColor }]}>
              <ThemedText
                style={[styles.dayNumber, { color: backgroundColor, fontWeight: '700' as const }]}
              >
                {date.day}
              </ThemedText>
            </View>
          ) : (
            <ThemedText
              style={[styles.dayNumber, isDisabled ? styles.dayNumberDisabled : undefined]}
            >
              {date.day}
            </ThemedText>
          )}
          {title ? (
            <ThemedText style={[styles.dayEntryTitle, { color: tintColor }]} numberOfLines={1}>
              {title}
            </ThemedText>
          ) : null}
        </Pressable>
      );
    },
    [entriesByDate, tintColor, backgroundColor, dayCellMinHeight],
  );

  const selectedDateEntries = selectedDate ? (entriesByDate[selectedDate] ?? []) : [];

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

        <View
          style={styles.calendarWrapper}
          onLayout={(event) => setCalendarHeight(event.nativeEvent.layout.height)}
        >
          <Calendar
            style={[styles.calendar, { borderColor: iconColor }]}
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
                      {new Date(item.createdAt).toLocaleString()}
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
  calendarWrapper: {
    flex: 1,
  },
  calendar: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  dayCell: {
    flex: 1,
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
