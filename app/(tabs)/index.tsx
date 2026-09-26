import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import type { CalendarProps, DateData } from 'react-native-calendars';
import { Calendar, LocaleConfig } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DiaryEntryComposerModal } from '@/components/diary-entry-composer-modal';
import { SaveToast } from '@/components/save-toast';
import { TabScreenContainer } from '@/components/tab-screen-container';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useCalendarLayoutPreference } from '@/contexts/calendar-layout-preference-context';
import { useThemePreference } from '@/contexts/theme-preference-context';
import { useDraftAutoSave } from '@/hooks/use-draft-auto-save';
import { useDraftRestore } from '@/hooks/use-draft-restore';
import { useModalSlideTransition } from '@/hooks/use-modal-slide-transition';
import { useSaveDiaryEntry } from '@/hooks/use-save-diary-entry';
import { useThemeColor } from '@/hooks/use-theme-color';
import {
  buildCreatedAtForDateKeyAtTime,
  dateKeyToDate,
  formatDateHeading,
  getSwipeDayDelta,
  getWeekDays,
  toDateKey,
} from '@/utils/diary-date';
import {
  DIARY_DRAFT_STORAGE_KEY,
  DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX,
} from '@/utils/diary-draft-storage';
import {
  BODY_MAX_LENGTH,
  splitIntoGraphemes,
  truncateForAccessibilityLabel,
  truncateToBodyMaxLength,
} from '@/utils/diary-text';
import {
  buildDiaryPartialCorruptionMessage,
  DIARY_LOAD_ERROR_MESSAGE,
  getAllDiaryEntries,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

// 週表示レイアウトの「今日」判定を再評価する間隔(ミリ秒)。タブ画面が保持され続けても
// 日付をまたいだタイミングから1分以内には追従できるようにする
const TODAY_DATE_KEY_REFRESH_INTERVAL_MS = 60 * 1000;

// getSearchExcerptで通常マッチしないフォールバック時に使う抜粋の最大文字数(超える場合は省略記号を付ける)
const FALLBACK_EXCERPT_MAX_LENGTH = 20;

const SAVE_SUCCESS_MESSAGE = '保存しました';

// タブバー(@react-navigation/bottom-tabsのデフォルト、tabBarStyle未カスタマイズ)のおおよその
// コンテンツ高さ(セーフエリア分は含まない)。ボトムシート系モーダルの下端がタブバーと重ならないよう、
// insets.bottomと合わせてpaddingBottomに加算する
const BOTTOM_TAB_BAR_CONTENT_HEIGHT = 49;

// 年月ピッカーモーダルの高さ上限(画面高さに対する割合)
const MONTH_PICKER_MAX_HEIGHT_RATIO = 0.7;

// 外枠の実測高さがまだ取れていない初回レンダー用のフォールバック値
const DEFAULT_DAY_CELL_HEIGHT = 48;
// 日付セル内テキストの拡大率上限。OS文字サイズ設定で無制限に拡大されるとdayCellHeightを
// 超えてoverflow: 'hidden'で見切れてしまうため、上限を設ける
const DAY_CELL_MAX_FONT_SCALE = 1.5;
// showSixWeeksにより月をまたいでも常に6行になるため、固定値で計算する
const CALENDAR_WEEK_ROWS = 6;
// react-native-calendarsのヘッダー+曜日行のおおよその高さと、週の行マージン(weekVerticalMargin=7の上下2回分)
const CALENDAR_CHROME_HEIGHT = 90;
const CALENDAR_WEEK_ROW_MARGIN = 14;

function getMonthIndex(year: number, month: number): number {
  return year * 12 + month;
}

function getPickerMaxMonthIndex(today: Date): number {
  return getMonthIndex(today.getFullYear(), today.getMonth() + 1);
}

function getPickerMinMonthIndex(entries: DiaryEntry[], pickerMaxMonthIndex: number): number {
  const entryMonthIndexes = entries
    .map((entry) => {
      const createdAt = new Date(entry.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        return null;
      }
      return getMonthIndex(createdAt.getFullYear(), createdAt.getMonth() + 1);
    })
    .filter((monthIndex): monthIndex is number => monthIndex !== null);

  if (entryMonthIndexes.length === 0) {
    return pickerMaxMonthIndex;
  }
  return Math.min(Math.min(...entryMonthIndexes), pickerMaxMonthIndex);
}

function getYearFromMonthIndex(monthIndex: number): number {
  return Math.floor((monthIndex - 1) / 12);
}

function getMonthFromMonthIndex(monthIndex: number): number {
  return ((monthIndex - 1) % 12) + 1;
}

// 指定した年月の1日を表す'YYYY-MM-DD'キーを組み立てる
function getFirstDayOfMonthKey(year: number, month: number): string {
  return `${year}-${`${month}`.padStart(2, '0')}-01`;
}

// react-native-calendarsが使うdayComponentのpropsの型(ライブラリ側から直接exportされていないため、
// CalendarPropsから抽出して利用する)
type DayComponentProps = ComponentProps<NonNullable<CalendarProps['dayComponent']>>;

// 日本語の月名。react-native-calendarsのロケール設定と年月ピッカーの月ボタン表示で共有する
const JA_MONTH_NAMES = [
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
];

// アプリ全体が日本語UIのため、カレンダーの月名・曜日名・「今日」ボタンの表記も日本語化する
LocaleConfig.locales.ja = {
  monthNames: JA_MONTH_NAMES,
  monthNamesShort: JA_MONTH_NAMES,
  dayNames: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  dayNamesShort: ['日', '月', '火', '水', '木', '金', '土'],
  today: '今日',
};
LocaleConfig.defaultLocale = 'ja';

// 週表示カレンダーのヘッダーで使う曜日の短縮名(getWeekDaysのdayOfWeek(0:日〜6:土)に対応する並び)
const JA_WEEKDAY_SHORT_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// 検索結果の抜粋で、マッチ箇所の前後何文字を表示するか
const SEARCH_EXCERPT_CONTEXT_LENGTH = 20;

// ひらがな(U+3041〜U+3096)とカタカナ(U+30A1〜U+30F6)のコードポイント差。
// 半角カタカナはNFKC正規化で全角カタカナに統一されるため、ひらがなをカタカナ側に寄せて表記ゆれを吸収する
const HIRAGANA_TO_KATAKANA_CODE_POINT_OFFSET = 0x60;

// 文字列中のひらがなをすべてカタカナへ変換する。ひらがな以外の文字はそのまま返す
function hiraganaToKatakana(text: string): string {
  let result = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0x3041 && codePoint <= 0x3096) {
      result += String.fromCodePoint(codePoint + HIRAGANA_TO_KATAKANA_CODE_POINT_OFFSET);
    } else {
      result += char;
    }
  }
  return result;
}

// 検索比較用に正規化した文字列と、その各文字が元の文字列上のどの範囲([start, end))に対応するかを示すマップ
type NormalizedForSearch = {
  normalized: string;
  startMap: number[];
  endMap: number[];
};

// 検索クエリ・日記本文の比較前の正規化(NFKCで全角/半角の表記ゆれ、ひらがな→カタカナ変換で
// ひらがな/カタカナの表記ゆれを吸収する。大文字/小文字は呼び出し元でtoLowerCase()済み)。
// 抜粋表示(getSearchExcerpt)で正規化後の位置を元の文字列上の位置に復元できるよう、
// 1文字ずつ正規化しながら元の文字列上の範囲(startMap/endMap)を記録する。
// 「ｶ」+「ﾞ」→「ガ」のように複数文字が正規化で1文字に減るケースは本実装では非対応
// (稀なエッジケースのため許容する)
function normalizeForSearch(text: string): NormalizedForSearch {
  let normalized = '';
  const startMap: number[] = [];
  const endMap: number[] = [];
  let originalIndex = 0;
  for (const char of text) {
    const normalizedChar = hiraganaToKatakana(char.normalize('NFKC'));
    const charEnd = originalIndex + char.length;
    // サロゲートペア文字(c.length===2)を1文字=1pushで扱うと、normalizedと
    // startMap/endMapの長さがズレるため、UTF-16コード単位数分だけpushする
    for (const c of normalizedChar) {
      normalized += c;
      for (let i = 0; i < c.length; i++) {
        startMap.push(originalIndex);
        endMap.push(charEnd);
      }
    }
    originalIndex = charEnd;
  }
  return { normalized, startMap, endMap };
}

// 検索結果抜粋の構成要素(prefix/match/suffix)。呼び出し側はmatchのみハイライト表示する
type SearchExcerpt = {
  prefix: string;
  match: string;
  suffix: string;
};

// 検索キーワードにマッチした日記本文から、マッチ箇所を中心とした抜粋を作る
// (改行は見づらいので空白に置換し、前後を切り詰めた場合は省略記号を付ける)。
// マッチ箇所の抜粋はgrapheme単位までは厳密にせず、多少のズレは許容する単純な文字列操作で行う
function getSearchExcerpt(text: string, query: string): SearchExcerpt {
  const normalizedText = text.replace(/\n+/g, ' ');
  // クエリ側にも本文と同じ改行畳み込みを適用し、entries.filter側の一致判定とズレないようにする
  const normalizedQuery = query.replace(/\n+/g, ' ');
  const {
    normalized: lowerText,
    startMap,
    endMap,
  } = normalizeForSearch(normalizedText.toLowerCase());
  const lowerQuery = normalizeForSearch(normalizedQuery.toLowerCase()).normalized;
  const matchIndex = lowerText.indexOf(lowerQuery);

  // 呼び出し元は常に非空のtrimmedSearchQueryを渡し、NFKC正規化は非空文字列を空文字列に
  // しないため、lowerQueryが空になることは無い。本文・クエリ双方を同じ規則で折り畳んで
  // いるため、matchIndex===-1もentries.filterを通過したエントリでは実質的に到達しない、
  // 念のためのフォールバック(ハイライト対象なしのためmatchは空文字列)。
  // 本文の最初の行を、書記素クラスタ単位で切り詰めて抜粋として使う
  // (絵文字等が途中で分断されないようにする配慮のためsliceではなくsplitIntoGraphemesを使う)
  if (matchIndex === -1) {
    const trimmedText = normalizedText.trim();
    const graphemes = splitIntoGraphemes(trimmedText);
    const fallbackExcerpt =
      graphemes.length <= FALLBACK_EXCERPT_MAX_LENGTH
        ? trimmedText
        : `${graphemes.slice(0, FALLBACK_EXCERPT_MAX_LENGTH).join('')}…`;
    return { prefix: fallbackExcerpt, match: '', suffix: '' };
  }

  // 正規化後の位置(matchIndex)を、startMap/endMap経由で元の文字列上の範囲に変換する
  const matchStart = startMap[matchIndex] ?? 0;
  const matchEnd = endMap[matchIndex + lowerQuery.length - 1] ?? normalizedText.length;

  const start = Math.max(0, matchStart - SEARCH_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(normalizedText.length, matchEnd + SEARCH_EXCERPT_CONTEXT_LENGTH);
  const prefixEllipsis = start > 0 ? '…' : '';
  const suffixEllipsis = end < normalizedText.length ? '…' : '';
  return {
    prefix: prefixEllipsis + normalizedText.slice(start, matchStart),
    match: normalizedText.slice(matchStart, matchEnd),
    suffix: normalizedText.slice(matchEnd, end) + suffixEllipsis,
  };
}

// 週表示レイアウトのカレンダー部分。フォーカス中の日を含む週(日曜始まり)の7日分を1行の
// ヘッダーとして表示し、各日付の下にその日の日記を作成日時の昇順で並べる(初期フォーカスは今日)。
// ヘッダーの日付タップ・専用の前後日ボタンのタップ・左右スワイプでフォーカスを前後の日へ移動でき、
// フォーカスが週の外に出た場合は表示する週ごと自動的に切り替わる。
// 日記の無い今日以前の日には、月表示の空日タップと同じく新規作成モーダルを開く「+」ボタンを出す
function WeekCalendarView({
  entriesByDate,
  onEntryPress,
  onCreateEntry,
  isLoading,
}: {
  entriesByDate: Record<string, DiaryEntry[]>;
  onEntryPress: (dateKey: string) => void;
  onCreateEntry: (dateKey: string) => void;
  // 日記の有無が未確定の間は新規作成ボタンを出さない
  isLoading: boolean;
}) {
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');

  // 「今日」の日付キー。expo-routerのTabsはタブ画面をアンマウントしないため、マウント時一度きりの
  // 評価だと週表示を開いたまま日付をまたいでも古い日付を指し続ける。フォーカス復帰時に加え、
  // 開いたままでも追従できるようタイマーでも定期的に再評価する
  const [todayDateKey, setTodayDateKey] = useState(() => toDateKey(new Date()));
  useFocusEffect(
    useCallback(() => {
      setTodayDateKey(toDateKey(new Date()));
    }, []),
  );
  useEffect(() => {
    const intervalId = setInterval(() => {
      setTodayDateKey(toDateKey(new Date()));
    }, TODAY_DATE_KEY_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);
  // フォーカス中の日。初期値は今日で、タップ/スワイプ操作で前後に移動する
  const [focusedDate, setFocusedDate] = useState(() => new Date());
  const focusedDateKey = useMemo(() => toDateKey(focusedDate), [focusedDate]);
  // 表示する週はフォーカス中の日を基準に毎回計算し直すため、週の外へフォーカスが
  // 移動した場合も自動的に隣の週へ表示が切り替わる
  const weekDays = useMemo(() => getWeekDays(focusedDate), [focusedDate]);

  // フォーカスをdelta日分(前日: -1 / 翌日: +1)移動する。前後日ボタンのタップ・スワイプ操作の共通処理
  const moveFocusByDays = useCallback((delta: number) => {
    setFocusedDate((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta);
      return next;
    });
  }, []);

  // 週ヘッダーの日付タップで、その日へフォーカスを移す
  const handleFocusDate = useCallback((dateKey: string) => {
    setFocusedDate(dateKeyToDate(dateKey));
  }, []);

  // 左右スワイプでフォーカスを前後の日へ移動するジェスチャー(追加ライブラリ不要なPanResponderを使用)。
  // 移動量の判定自体はgetSwipeDayDeltaに切り出しており、ここでは結果に応じてフォーカスを動かすだけ
  const panResponderRef = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        getSwipeDayDelta(gestureState.dx, gestureState.dy) !== 0,
      onPanResponderRelease: (_event, gestureState) => {
        const delta = getSwipeDayDelta(gestureState.dx, gestureState.dy);
        if (delta !== 0) {
          moveFocusByDays(delta);
        }
      },
    }),
  );

  return (
    <View
      style={[styles.weekWrapper, { borderColor: iconColor, backgroundColor }]}
      {...panResponderRef.current.panHandlers}
    >
      <View style={styles.weekFocusNav}>
        <Pressable
          onPress={() => moveFocusByDays(-1)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="前の日へ移動"
        >
          <IconSymbol name="chevron.left" size={20} color={tintColor} />
        </Pressable>
        <ThemedText type="subtitle" style={{ color: textColor }}>
          {formatDateHeading(focusedDateKey)}
        </ThemedText>
        <Pressable
          onPress={() => moveFocusByDays(1)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="次の日へ移動"
        >
          <IconSymbol name="chevron.right" size={20} color={tintColor} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.weekScrollContent}>
        <View style={styles.weekRow}>
          {weekDays.map((weekDay) => {
            const isToday = weekDay.dateKey === todayDateKey;
            const isFocused = weekDay.dateKey === focusedDateKey;
            const dayEntries = entriesByDate[weekDay.dateKey] ?? [];
            return (
              <View key={weekDay.dateKey} style={styles.weekColumn}>
                <Pressable
                  onPress={() => handleFocusDate(weekDay.dateKey)}
                  style={[styles.weekColumnHeader, isFocused && { borderColor: tintColor }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${formatDateHeading(weekDay.dateKey)}にフォーカスを移動`}
                  accessibilityState={{ selected: isFocused }}
                >
                  <ThemedText style={[styles.weekDayName, { color: textColor }]}>
                    {JA_WEEKDAY_SHORT_NAMES[weekDay.dayOfWeek]}
                  </ThemedText>
                  {isToday ? (
                    <View style={[styles.todayBadge, { backgroundColor: tintColor }]}>
                      <ThemedText
                        style={[styles.dayNumber, { color: backgroundColor, fontWeight: '700' }]}
                      >
                        {weekDay.day}
                      </ThemedText>
                    </View>
                  ) : (
                    <ThemedText style={styles.dayNumber}>{weekDay.day}</ThemedText>
                  )}
                </Pressable>
                <View style={styles.weekColumnEntries}>
                  {dayEntries.map((entry) => (
                    <Pressable
                      key={entry.id}
                      onPress={() => onEntryPress(weekDay.dateKey)}
                      style={[styles.weekEntryItem, { backgroundColor: tintColor }]}
                      accessibilityRole="button"
                      accessibilityLabel={`${formatDateHeading(weekDay.dateKey)}の日記: ${truncateForAccessibilityLabel(entry.text)}`}
                    >
                      <ThemedText
                        numberOfLines={2}
                        style={[styles.weekEntryText, { color: backgroundColor }]}
                      >
                        {entry.text || '(内容なし)'}
                      </ThemedText>
                    </Pressable>
                  ))}
                  {!isLoading && dayEntries.length === 0 && weekDay.dateKey <= todayDateKey ? (
                    <Pressable
                      onPress={() => onCreateEntry(weekDay.dateKey)}
                      style={[styles.weekCreateButton, { borderColor: tintColor }]}
                      accessibilityRole="button"
                      accessibilityLabel={`${formatDateHeading(weekDay.dateKey)}の日記を新規作成`}
                    >
                      <ThemedText style={[styles.weekCreateButtonText, { color: tintColor }]}>
                        +
                      </ThemedText>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  // 初回のloadEntries完了までtrueの読み込み中フラグ。useFocusEffectで再フォーカス時にも
  // loadEntriesは呼ばれるが、都度trueに戻すとローディング表示がちらつくため一方向にのみ遷移させる
  const [isLoading, setIsLoading] = useState(true);
  // 直近のloadEntriesが読み込みエラーだったか。「日記が0件」と見た目上区別できるよう、
  // 空状態メッセージの表示を切り替えるために使う
  const [hasLoadError, setHasLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  // 保存成功時に一時的に表示するトーストのメッセージ。nullの間は非表示
  const [saveToastMessage, setSaveToastMessage] = useState<string | null>(null);
  // 一部エントリの破損を検知した際に一時的に表示するトーストのメッセージ。保存成功トーストとは
  // 独立したstateにし、それぞれ別のSaveToastとして同時に表示できるようにする
  const [corruptionToastMessage, setCorruptionToastMessage] = useState<string | null>(null);
  // 日記本文のキーワード検索用の入力値(composerの入力とは独立したstate)
  const [searchQuery, setSearchQuery] = useState('');
  // handleSaveの実行中かどうか・エラー内容。連打による重複保存を防ぐため、実行中は早期returnしボタンもdisabledにする
  const { isSaving, error: saveError, save: saveDraftEntry } = useSaveDiaryEntry();
  // 新規作成モーダルの対象日付('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [newEntryDate, setNewEntryDate] = useState<string | null>(null);
  const draftEditRevisionRef = useRef(0);
  // カレンダー外枠(flex: 1で残りスペースを使い切るView)の実測高さ(onLayoutで取得)。
  // 日付グリッドの高さもこの値を基準に算出し、外枠との基準を一致させる
  const [wrapperHeight, setWrapperHeight] = useState(0);
  // カレンダーに現在表示中の年・月。react-native-calendarsの`current`propは初回マウント時にしか
  // 参照されない(ジャンプにはinitialDateを使う)ため、ヘッダー表示・ピッカーはこのstateを正とし、
  // onMonthChangeでスワイプ/矢印操作にも追従させる
  const [displayedYear, setDisplayedYear] = useState(() => new Date().getFullYear());
  const [displayedMonth, setDisplayedMonth] = useState(() => new Date().getMonth() + 1);
  // Calendarへ渡す'YYYY-MM-DD'。`current`propは初回マウント時のみ参照され追従しないが、
  // `initialDate`は値が変わるたびその月へジャンプするため、年月ピッカーからのジャンプに使う。
  // テーマ切替時の強制再マウント後も移動先の月を復元できるよう、handleMonthChangeでも同期させる
  const [calendarInitialDate, setCalendarInitialDate] = useState(() => toDateKey(new Date()));
  // 年月ジャンプ用ピッカーの表示状態と、ピッカー内で選択中の年(月はdisplayedMonthを参照)
  const [isMonthPickerVisible, setIsMonthPickerVisible] = useState(false);
  const [pickerYear, setPickerYear] = useState(displayedYear);

  // 年月ピッカーモーダルのアニメーション制御(詳細はuseModalSlideTransitionを参照)
  const monthPickerTransition = useModalSlideTransition(isMonthPickerVisible);

  const router = useRouter();
  const { colorScheme } = useThemePreference();
  // 月表示/週表示のどちらでホーム画面のカレンダー部分を表示するかの設定
  const { layout: calendarLayout } = useCalendarLayoutPreference();
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');
  const searchHighlightBackgroundColor = useThemeColor({}, 'searchHighlightBackground');
  // ボトムシート系モーダル(新規作成・年月ピッカー)の下端がタブバーと重ならないよう、
  // セーフエリア下端の分だけ余分にpaddingBottomへ加算する。TabScreenContainerが担うのは
  // 上端のセーフエリア対応のみで下端は扱わないため、ここでの加算は二重加算にはならない
  const insets = useSafeAreaInsets();
  const modalContentBottomPadding = insets.bottom + BOTTOM_TAB_BAR_CONTENT_HEIGHT;
  // modalContentのmaxHeight(%)は内容量で高さが決まる親ラッパーを基準に解決され上限として機能しないため、
  // 画面高さからpxで算出して年月ピッカーのみ上書きする
  const { height: windowHeight } = useWindowDimensions();
  const monthPickerMaxHeight = windowHeight * MONTH_PICKER_MAX_HEIGHT_RATIO;

  // この画面内の保存処理(新規保存・日付指定の新規作成)を直列化するキュー。
  // 編集・削除は専用画面で直接永続化するため対象外。loadEntriesが参照するため宣言順を前にしている
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  // キューに積まれ未完了のタスク件数。loadEntriesがwriteQueueRef.currentを待つべきか判定するのに使う
  const pendingWriteCountRef = useRef(0);

  const loadEntries = useCallback(async () => {
    // pending中の書き込みがある場合、待たずに読み込むと楽観的更新後の内容が一瞬古い内容に
    // 戻ってちらつくため、直近の書き込み完了を待ってから読み込む。pending無しでも無条件にawaitすると
    // 他の非同期処理との実行順序が余分な1マイクロタスク分ずれるため、必要な場合のみ待つ
    if (pendingWriteCountRef.current > 0) {
      await writeQueueRef.current;
    }
    // getAllDiaryEntriesはストレージが空・壊れている場合も例外を投げず空配列を返すため、
    // ここで個別にtry/catchする必要はない。読み込みエラーの有無はonErrorで受け取り、
    // 「日記0件」の空状態表示と区別する
    let loadFailed = false;
    let partialCorruptionCount = 0;
    const loadedEntries = await getAllDiaryEntries({
      onError: () => {
        loadFailed = true;
      },
      onPartialCorruption: (invalidCount) => {
        partialCorruptionCount = invalidCount;
      },
    });
    setEntries(loadedEntries);
    setHasLoadError(loadFailed);
    if (partialCorruptionCount > 0) {
      setCorruptionToastMessage(buildDiaryPartialCorruptionMessage(partialCorruptionCount));
    }
    // 初回読み込み完了を示す(isLoadingは一方向にのみ遷移し、trueへ戻す処理は無い)
    setIsLoading(false);
  }, []);

  // エントリ単位の個別キーで保存するため、他のエントリの読み書きは発生しない
  const enqueueDiaryWrite = useCallback((entry: DiaryEntry): Promise<void> => {
    // 実行完了を待たず、積んだ時点で同期的にインクリメントする。これにより呼び出し直後に
    // loadEntriesが走っても未実行のタスクの存在を検知できる
    pendingWriteCountRef.current += 1;
    const task = writeQueueRef.current.then(async () => {
      await saveDiaryEntry(entry);
    });
    // キューは成否に関わらず先へ進める(失敗はtask側で呼び出し元に伝わる)。
    // pendingWriteCountRefも成否問わず完了時点でデクリメントする
    writeQueueRef.current = task.then(
      () => {
        pendingWriteCountRef.current -= 1;
      },
      () => {
        pendingWriteCountRef.current -= 1;
      },
    );
    return task;
  }, []);

  // expo-routerの`Tabs`はタブ画面をアンマウントせず保持するため、マウント時一度きりのuseEffectだと
  // 他画面(設定タブの全件削除等)によるAsyncStorageの変更がstateに反映されないまま残り、
  // 古いエントリを巻き込んで上書き保存してしまう。useFocusEffectで再フォーカス毎に読み直し防ぐ
  useFocusEffect(
    useCallback(() => {
      loadEntries();
    }, [loadEntries]),
  );

  // 起動時・画面マウント時に、自動保存されていた下書きが残っていればTextInputへ復元する。
  // 画面はアンマウントされず保持されるため、マウント時に一度だけ読めば済む
  const isDraftRestored = useDraftRestore({
    draftKey: DIARY_DRAFT_STORAGE_KEY,
    onRestore: setDraft,
    editRevisionRef: draftEditRevisionRef,
  });
  const { clearDraft } = useDraftAutoSave({
    draftKey: DIARY_DRAFT_STORAGE_KEY,
    draft,
    isRestored: isDraftRestored,
  });

  const handleSave = useCallback(async () => {
    // ロールバック用に保存前の状態をpersist内で退避し、失敗時にonErrorから参照する
    let previousEntries: DiaryEntry[] = [];
    let previousDraft = '';
    const editRevisionAtSave = draftEditRevisionRef.current;

    await saveDraftEntry({
      text: draft,
      persist: async (trimmed) => {
        const newEntry: DiaryEntry = {
          // Date.now().toString()は同一ミリ秒での衝突リスクがあるため、UUID v4を生成するrandomUUID()を使う
          id: randomUUID(),
          text: trimmed,
          createdAt: new Date().toISOString(),
        };
        previousEntries = entries;
        previousDraft = draft;
        // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
        setEntries([newEntry, ...entries]);
        setDraft('');
        // 本文はSecureStoreで保護した鍵でAES-256-GCM暗号化して保存する。他の保存処理と競合しないよう
        // 書き込みはキュー経由で直列化する
        await enqueueDiaryWrite(newEntry);
      },
      onSuccess: async () => {
        // 保存成功時は自動保存済みの下書きキーも削除する。残したままだと次回起動時に
        // 既に保存済みの内容を誤って復元してしまう。ただし保存中に編集された下書きは残す
        // 必要があるため、保存開始時からrevisionが変わっていない場合だけ削除する
        if (draftEditRevisionRef.current === editRevisionAtSave) {
          await clearDraft();
        }

        // 保存成功をユーザーに明示するため、トーストとハプティックフィードバックを発火する
        setSaveToastMessage(SAVE_SUCCESS_MESSAGE);
        if (process.env.EXPO_OS === 'ios') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      },
      onError: () => {
        // 保存中に入力が更新されていない場合だけ、保存前の内容を復元する
        setEntries(previousEntries);
        if (draftEditRevisionRef.current === editRevisionAtSave) {
          setDraft(previousDraft);
        }
      },
      errorMessage: '保存に失敗しました。もう一度お試しください。',
    });
  }, [draft, entries, enqueueDiaryWrite, saveDraftEntry, clearDraft]);

  // 入力が空文字列に戻った場合も、復元や保存失敗による古い内容で上書きしないよう編集revisionを進める
  const handleChangeDraft = useCallback((text: string) => {
    draftEditRevisionRef.current += 1;
    setDraft(truncateToBodyMaxLength(text));
  }, []);

  // 日記の無い日をタップして開いたモーダルからの新規保存。createdAtの日付部分は選択日付に
  // 固定しつつ、時分秒は実際に保存した瞬間の時刻にする(buildCreatedAtForDateKeyAtTime)
  const handlePersistNewEntry = useCallback(
    async (trimmed: string) => {
      // 対象日付が無いまま成功扱いにしないよう、失敗として伝える
      if (!newEntryDate) {
        throw new Error('対象日付が未設定です');
      }
      const newEntry: DiaryEntry = {
        id: randomUUID(),
        text: trimmed,
        createdAt: buildCreatedAtForDateKeyAtTime(newEntryDate),
      };
      // 体感速度を落とさないよう、即座にReact stateを楽観的に更新する
      setEntries((current) => [newEntry, ...current]);
      try {
        // 他の保存処理と競合しないよう、書き込みはキュー経由で直列化する
        await enqueueDiaryWrite(newEntry);
      } catch (err) {
        // 永続化に失敗した場合は楽観的に追加した分を取り除いてロールバックする
        setEntries((current) => current.filter((entry) => entry.id !== newEntry.id));
        throw err;
      }
    },
    [newEntryDate, enqueueDiaryWrite],
  );

  const handleCloseNewEntryModal = useCallback(() => {
    setNewEntryDate(null);
  }, []);

  // トーストを非表示にする。SaveToastのuseEffect依存配列に含まれるため、参照を安定させないと
  // 再レンダーのたびにタイマーが張り直され、トーストが仕様通りの時間で消えなくなる
  const handleHideSaveToast = useCallback(() => {
    setSaveToastMessage(null);
  }, []);

  const handleHideCorruptionToast = useCallback(() => {
    setCorruptionToastMessage(null);
  }, []);

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

  // 検索キーワードの前後の空白を除いたもの。空文字列の間は「検索していない」状態として扱う
  const trimmedSearchQuery = searchQuery.trim();

  // 検索キーワードに本文が部分一致する(大文字小文字・全角半角・ひらがな/カタカナの表記ゆれを
  // 区別しない)エントリの一覧。日時の降順(新しい順)に並べ替える
  const searchResults = useMemo(() => {
    if (!trimmedSearchQuery) {
      return [];
    }
    const normalizedQuery = normalizeForSearch(trimmedSearchQuery.toLowerCase()).normalized;
    return entries
      .filter((entry) =>
        normalizeForSearch(entry.text.toLowerCase()).normalized.includes(normalizedQuery),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [entries, trimmedSearchQuery]);

  // 検索結果の項目がタップされたら、そのエントリが書かれた日付の一覧画面へ遷移する
  const handleSearchResultPress = useCallback(
    (entry: DiaryEntry) => {
      router.push(`/day-entries/${toDateKey(new Date(entry.createdAt))}`);
    },
    [router],
  );

  // 週表示カレンダーの日記項目がタップされたら、その日の一覧画面へ遷移する(検索結果と同じ導線)
  const handleWeekEntryPress = useCallback(
    (dateKey: string) => {
      router.push(`/day-entries/${dateKey}`);
    },
    [router],
  );

  // 検索欄の「クリア」ボタン押下時、検索キーワードを空にしてカレンダー表示へ戻す
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  // 外枠の実測高さ(wrapperHeight)からヘッダー+曜日行の高さと6週分の行マージンを差し引き、
  // 残りを6週で均等に割って日付セルの高さを算出する。カレンダー本体側の実測値を使う反復補正も
  // 試したが、react-native-calendarsのレイアウト確定タイミングとズレて不安定だったため、
  // 外枠の実測値のみを使うシンプルな一度切りの計算にしている
  const dayCellHeight = useMemo(() => {
    if (wrapperHeight <= 0) {
      return DEFAULT_DAY_CELL_HEIGHT;
    }
    const gridHeight = wrapperHeight - CALENDAR_CHROME_HEIGHT;
    const perRowHeight = gridHeight / CALENDAR_WEEK_ROWS - CALENDAR_WEEK_ROW_MARGIN;
    return Math.max(DEFAULT_DAY_CELL_HEIGHT, perRowHeight);
  }, [wrapperHeight]);

  const [pickerToday, setPickerToday] = useState(() => new Date());
  const pickerMaxYear = pickerToday.getFullYear();
  const pickerMaxMonthIndex = getPickerMaxMonthIndex(pickerToday);

  const pickerMinMonthIndex = useMemo(() => {
    return getPickerMinMonthIndex(entries, pickerMaxMonthIndex);
  }, [entries, pickerMaxMonthIndex]);

  const pickerMinYear = getYearFromMonthIndex(pickerMinMonthIndex);

  const isPickerMonthInRange = useCallback(
    (year: number, month: number) => {
      const monthIndex = getMonthIndex(year, month);
      return monthIndex >= pickerMinMonthIndex && monthIndex <= pickerMaxMonthIndex;
    },
    [pickerMinMonthIndex, pickerMaxMonthIndex],
  );

  const isPreviousYearDisabled = pickerYear <= pickerMinYear;
  const isNextYearDisabled = pickerYear >= pickerMaxYear;

  // スワイプ・矢印操作で表示月が変わった際、ヘッダー表示・年月ピッカーのハイライト・
  // calendarInitialDateをその月に追従させる。テーマ切替時の`key={colorScheme}`強制再マウント後、
  // 新しいCalendarインスタンスはinitialDateから表示月を再構築するため、ここで同期させておかないと
  // スワイプ・矢印だけで移動した状態でテーマを切り替えた際に日付グリッドが今日の月へ巻き戻ってしまう
  const handleMonthChange = useCallback((date: DateData) => {
    setDisplayedYear(date.year);
    setDisplayedMonth(date.month);
    setCalendarInitialDate(getFirstDayOfMonthKey(date.year, date.month));
  }, []);

  // ヘッダーの年月表示をタップすると、現在表示中の年を初期選択状態にしてピッカーを開く
  const handleOpenMonthPicker = useCallback(() => {
    const currentToday = new Date();
    const currentPickerMaxMonthIndex = getPickerMaxMonthIndex(currentToday);
    const currentPickerMinYear = getYearFromMonthIndex(
      getPickerMinMonthIndex(entries, currentPickerMaxMonthIndex),
    );
    setPickerToday(currentToday);
    setPickerYear(
      Math.min(Math.max(displayedYear, currentPickerMinYear), currentToday.getFullYear()),
    );
    setIsMonthPickerVisible(true);
  }, [displayedYear, entries]);

  const handleCloseMonthPicker = useCallback(() => {
    setIsMonthPickerVisible(false);
  }, []);

  const handlePickerYearStep = useCallback(
    (delta: number) => {
      setPickerYear((year) => Math.min(Math.max(year + delta, pickerMinYear), pickerMaxYear));
    },
    [pickerMinYear, pickerMaxYear],
  );

  // 月ボタンが選択されたら、その年月の1日をcalendarInitialDateへセットしてカレンダーをジャンプさせる
  const handleSelectMonth = useCallback(
    (month: number) => {
      if (!isPickerMonthInRange(pickerYear, month)) {
        return;
      }
      setDisplayedYear(pickerYear);
      setDisplayedMonth(month);
      setCalendarInitialDate(getFirstDayOfMonthKey(pickerYear, month));
      setIsMonthPickerVisible(false);
    },
    [isPickerMonthInRange, pickerYear],
  );

  // react-native-calendarsのrenderHeaderは矢印・曜日行を維持したまま中央の見出しのみ差し替えられるため、
  // 既存の月送り・レイアウトに影響せず見出しをタップ可能なボタンに置き換えられる
  const renderCalendarHeader = useCallback(() => {
    return (
      <Pressable
        onPress={handleOpenMonthPicker}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${displayedYear}年${displayedMonth}月、年月を選択して移動`}
        style={styles.calendarHeaderButton}
      >
        <ThemedText
          allowFontScaling={false}
          style={[styles.calendarHeaderText, { color: textColor }]}
        >
          {displayedYear}年{displayedMonth}月
        </ThemedText>
        <IconSymbol name="chevron.down" size={18} color={textColor} />
      </Pressable>
    );
  }, [displayedYear, displayedMonth, handleOpenMonthPicker, textColor]);

  // 未来日は新規作成の対象外。月表示ではmaxDateで既に押せなくなっている(renderDay参照)が、
  // 週表示と共通の入口として念のため二重にチェックする
  const openNewEntryModal = useCallback((dateKey: string) => {
    if (dateKey > toDateKey(new Date())) {
      return;
    }
    setNewEntryDate(dateKey);
  }, []);

  const handleDayPress = useCallback(
    (date: DateData) => {
      if (entriesByDate[date.dateString]?.length) {
        // 日付タップ時は専用の一覧画面へ遷移する
        router.push(`/day-entries/${date.dateString}`);
        return;
      }
      openNewEntryModal(date.dateString);
    },
    [entriesByDate, router, openNewEntryModal],
  );

  const renderDay = useCallback(
    ({ date, state }: DayComponentProps) => {
      if (!date) {
        return null;
      }

      const dayEntries = entriesByDate[date.dateString];
      // その日にエントリが実在するか(タイトル文字列の有無ではなくhandleDayPressと同じ基準で判定。
      // 本文が空白のみのレガシーデータではタイトルが空文字列になり得るため区別が必要)
      const hasEntries = Boolean(dayEntries?.length);
      const entryCount = dayEntries?.length ?? 0;
      const isDisabled = state === 'disabled' || state === 'inactive';
      const isToday = state === 'today';
      // 未来日はmaxDateによりstateが'disabled'になるため、それ以外は押せる扱いにする
      const isPressable = hasEntries || state !== 'disabled';
      // スクリーンリーダー向けに「何年何月何日か」「日記の有無・新規作成可否」が伝わるラベルを組み立てる
      const statusLabel = hasEntries
        ? `日記あり(${entryCount}件)`
        : isPressable
          ? '日記なし、タップして新規作成'
          : '日記なし';
      const accessibilityLabel = `${formatDateHeading(date.dateString)}、${statusLabel}`;

      return (
        <Pressable
          style={[styles.dayCell, { height: dayCellHeight }]}
          // react-native-calendars内部のonPressはmaxDateを超える日付で発火しないため、
          // isPressableの判定と遷移処理を一致させるためhandleDayPressを直接呼び出す
          onPress={() => handleDayPress(date)}
          disabled={!isPressable}
          accessibilityRole={isPressable ? 'button' : undefined}
          accessibilityLabel={accessibilityLabel}
          // タップしても反応しない日はスクリーンリーダーにも操作不可であることを明示的に伝える
          accessibilityState={{ disabled: !isPressable }}
        >
          {isToday ? (
            // 今日のセルは数字を丸背景で囲んで強調する
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
          {entryCount === 1 ? (
            // タイトル文字は小さすぎて読めないため、日記が1件あることが伝わるドットで代替する
            <View style={[styles.entryDot, { backgroundColor: tintColor }]} />
          ) : entryCount > 1 ? (
            // 2件以上ある場合は合計件数を丸バッジで表示する
            <View style={[styles.entryCountBadge, { backgroundColor: tintColor }]}>
              <ThemedText
                style={[styles.entryCountText, { color: backgroundColor }]}
                maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
              >
                {entryCount}
              </ThemedText>
            </View>
          ) : null}
        </Pressable>
      );
    },
    [entriesByDate, tintColor, backgroundColor, dayCellHeight, handleDayPress],
  );

  // 文字数カウンター表示用に、grapheme単位で数え直す(絵文字などでUTF-16の.lengthとずれるため)
  const draftGraphemeCount = useMemo(() => splitIntoGraphemes(draft).length, [draft]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android SDK 54のedge-to-edge対応でwindowSoftInputModeの自動リサイズが効かないケースがあるため明示指定する
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* ステータスバー/ノッチ領域とタイトルが重ならないよう、TabScreenContainerでセーフエリア上端インセットぶんの余白を自動的に加算する */}
      <TabScreenContainer style={styles.container}>
        {/* 背景タップでキーボードを閉じる。accessible={false}で内側要素がまとめて読み上げられるのを防ぐ */}
        <Pressable
          style={styles.contentWrapper}
          onPress={() => Keyboard.dismiss()}
          accessible={false}
        >
          <ThemedText type="title" style={styles.title}>
            日記
          </ThemedText>

          {corruptionToastMessage ? (
            <SaveToast
              message={corruptionToastMessage}
              onHide={handleHideCorruptionToast}
              testID="data-integrity-toast"
              variant="warning"
            />
          ) : null}

          <ThemedView style={styles.composer}>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: tintColor }]}
              placeholder="今日の出来事や気持ちを書いてみましょう"
              placeholderTextColor={iconColor}
              value={draft}
              onChangeText={handleChangeDraft}
              multiline
              // placeholderはフォーカス後に読み上げられない環境があるため、明示的なラベルを付ける
              accessibilityLabel="日記本文"
              // maxLengthはUTF-16コードユニット単位でしか制限できないため使わず、grapheme単位で切り詰める
            />
            <View style={styles.composerFooter}>
              {/* 文字数カウンター(上限に近づいた/達したことがひと目で分かるよう常に表示する) */}
              <ThemedText
                style={[
                  styles.charCount,
                  draftGraphemeCount >= BODY_MAX_LENGTH
                    ? { color: errorColor }
                    : { color: iconColor },
                ]}
              >
                {draftGraphemeCount}/{BODY_MAX_LENGTH}
              </ThemedText>
              <Pressable
                style={[
                  styles.saveButton,
                  { backgroundColor: tintColor },
                  // 押せない状態であることが見た目でも分かるよう、無効時は半透明にする
                  { opacity: !draft.trim() || isSaving ? 0.5 : 1 },
                ]}
                onPress={handleSave}
                disabled={!draft.trim() || isSaving}
                accessibilityRole="button"
                accessibilityLabel="保存"
                accessibilityState={{ disabled: !draft.trim() || isSaving }}
              >
                {isSaving ? (
                  <View style={styles.saveButtonContent}>
                    <ActivityIndicator size="small" color={backgroundColor} />
                    <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                      保存中...
                    </ThemedText>
                  </View>
                ) : (
                  <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                    保存
                  </ThemedText>
                )}
              </Pressable>
            </View>
            {saveError ? (
              <ThemedText style={[styles.errorText, { color: errorColor }]}>{saveError}</ThemedText>
            ) : null}
            {saveToastMessage ? (
              <SaveToast message={saveToastMessage} onHide={handleHideSaveToast} />
            ) : null}
          </ThemedView>

          {/* 日記検索用の入力欄。composerとは独立し、キーワード入力中は下に検索結果一覧を表示する */}
          <View style={styles.searchContainer}>
            <TextInput
              style={[
                styles.searchInput,
                // クリアボタンと文字が重ならないよう、入力中のみ右側の余白を広げる
                searchQuery ? styles.searchInputWithClear : null,
                { color: textColor, borderColor: iconColor },
              ]}
              placeholder="日記を検索"
              placeholderTextColor={iconColor}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              accessibilityLabel="日記を検索"
              // 検索欄は本文入力ほど厳密な制御は不要なため、標準のmaxLength(UTF-16コードユニット単位)を使う
              maxLength={BODY_MAX_LENGTH}
            />
            {searchQuery ? (
              // clearButtonModeはiOS専用のため、カスタムボタンでクリア操作をクロスプラットフォームに実現する
              <Pressable
                style={styles.searchClearButton}
                onPress={handleClearSearch}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="検索キーワードをクリア"
              >
                <ThemedText style={[styles.searchClearButtonText, { color: iconColor }]}>
                  ✕
                </ThemedText>
              </Pressable>
            ) : null}
          </View>

          {trimmedSearchQuery ? (
            // 検索キーワードが入力されている間は、通常のカレンダー表示の代わりに検索結果一覧を表示する
            <FlatList
              style={styles.searchResultsList}
              data={searchResults}
              keyExtractor={(item) => item.id}
              // 一覧をスクロールした際にもキーボードを閉じられるようにする
              keyboardDismissMode="on-drag"
              // キーボード表示中でも1回のタップで検索結果を選択できるようにする
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const excerpt = getSearchExcerpt(item.text, trimmedSearchQuery);
                return (
                  <Pressable
                    style={[styles.searchResultItem, { borderBottomColor: iconColor }]}
                    onPress={() => handleSearchResultPress(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`${formatDateHeading(toDateKey(new Date(item.createdAt)))}の日記: ${truncateForAccessibilityLabel(item.text)}`}
                  >
                    <ThemedText style={[styles.searchResultDate, { color: iconColor }]}>
                      {formatDateHeading(toDateKey(new Date(item.createdAt)))}
                    </ThemedText>
                    <ThemedText numberOfLines={2}>
                      {excerpt.prefix}
                      {excerpt.match ? (
                        <ThemedText
                          style={[
                            styles.searchResultHighlight,
                            { backgroundColor: searchHighlightBackgroundColor },
                          ]}
                        >
                          {excerpt.match}
                        </ThemedText>
                      ) : null}
                      {excerpt.suffix}
                    </ThemedText>
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                // 検索結果が0件のときは、カレンダーが何も表示されず戸惑わないよう明示的に案内する
                <ThemedView style={styles.emptyState}>
                  <ThemedText style={styles.emptyStateText}>見つかりませんでした</ThemedText>
                </ThemedView>
              }
            />
          ) : (
            <>
              {isLoading ? (
                // 初回読み込み中はentriesが空配列なだけで空状態メッセージが誤表示されないよう、ローディング表示にする
                <ThemedView style={styles.emptyState}>
                  <ActivityIndicator color={tintColor} />
                </ThemedView>
              ) : entries.length === 0 && hasLoadError ? (
                // 読み込み失敗時は「日記が0件」と見た目上区別が付かなくなるため、専用のメッセージを表示する。
                // emptyStateTextのopacityはコントラストを下げるため、エラー表示には適用しない
                <ThemedView style={styles.emptyState}>
                  <ThemedText style={[styles.emptyStateErrorText, { color: errorColor }]}>
                    {DIARY_LOAD_ERROR_MESSAGE}
                  </ThemedText>
                  <Pressable
                    onPress={loadEntries}
                    style={[styles.retryButton, { borderColor: tintColor }]}
                    accessibilityRole="button"
                    accessibilityLabel="再試行"
                  >
                    <ThemedText style={[styles.retryButtonText, { color: tintColor }]}>
                      再試行
                    </ThemedText>
                  </Pressable>
                </ThemedView>
              ) : entries.length === 0 ? (
                // 日記が1件も無い場合、案内メッセージを表示する(カレンダー自体は書く導線として表示し続ける)
                <ThemedView style={styles.emptyState}>
                  <ThemedText style={styles.emptyStateText}>
                    まだ日記がありません。最初の日記を書いてみましょう。
                  </ThemedText>
                </ThemedView>
              ) : null}

              {calendarLayout === 'week' ? (
                // 週表示: 1ヶ月分をまとめて表示する月表示だと情報が細かすぎるという
                // フィードバックに対応した、当日を含む週のみを表示するレイアウト
                <WeekCalendarView
                  entriesByDate={entriesByDate}
                  onEntryPress={handleWeekEntryPress}
                  onCreateEntry={openNewEntryModal}
                  isLoading={isLoading}
                />
              ) : (
                <View
                  style={[styles.calendarWrapper, { borderColor: iconColor, backgroundColor }]}
                  onLayout={(event) => setWrapperHeight(event.nativeEvent.layout.height)}
                >
                  <Calendar
                    // react-native-calendarsはtheme propのスタイルをuseRefで初回計算しキャッシュするため、
                    // マウント後のテーマ変更に追従しない。colorSchemeをkeyにして変化のたびに強制再マウントさせる
                    key={colorScheme}
                    theme={{
                      backgroundColor,
                      calendarBackground: backgroundColor,
                      // 曜日行はtextColorを使い、アイコン色より高いコントラストで視認性を確保する
                      textSectionTitleColor: textColor,
                      textDayHeaderFontWeight: '600',
                      dayTextColor: textColor,
                      arrowColor: tintColor,
                      todayTextColor: tintColor,
                    }}
                    dayComponent={renderDay}
                    onDayPress={handleDayPress}
                    // 見出しを日本語語順で表示しつつ、タップで年月ピッカーを開くボタンに差し替える
                    renderHeader={renderCalendarHeader}
                    enableSwipeMonths
                    // ピッカーから任意の年月へジャンプするための制御用prop(詳細はcalendarInitialDateを参照)
                    initialDate={calendarInitialDate}
                    onMonthChange={handleMonthChange}
                    // 未来日を新規作成の対象外にするため、今日より後の日付をタップ不可(state: 'disabled')にする
                    maxDate={toDateKey(new Date())}
                    // 年月ピッカーで選択可能な最古月より過去へスワイプできてしまうと、
                    // ピッカーのクランプ処理と表示中の月が食い違うため下限を揃える
                    minDate={getFirstDayOfMonthKey(
                      pickerMinYear,
                      getMonthFromMonthIndex(pickerMinMonthIndex),
                    )}
                    // minDate/maxDateは日付セルの見た目にのみ影響し、矢印タップ・スワイプによる
                    // 月送り自体はブロックしないため、範囲外への移動はここで直接止める
                    onPressArrowLeft={(subtractMonth) => {
                      if (getMonthIndex(displayedYear, displayedMonth) > pickerMinMonthIndex) {
                        subtractMonth();
                      }
                    }}
                    onPressArrowRight={(addMonth) => {
                      if (getMonthIndex(displayedYear, displayedMonth) < pickerMaxMonthIndex) {
                        addMonth();
                      }
                    }}
                    disableArrowLeft={
                      getMonthIndex(displayedYear, displayedMonth) <= pickerMinMonthIndex
                    }
                    disableArrowRight={
                      getMonthIndex(displayedYear, displayedMonth) >= pickerMaxMonthIndex
                    }
                    // 月によって行数(4〜6週)が変わって高さがガタつかないよう、常に6週分の高さで揃える
                    showSixWeeks
                  />
                </View>
              )}
            </>
          )}
        </Pressable>

        <DiaryEntryComposerModal
          dateKey={newEntryDate}
          draftStorageKeyPrefix={DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}
          contentBottomPadding={modalContentBottomPadding}
          persist={handlePersistNewEntry}
          onSaved={handleCloseNewEntryModal}
          onClose={handleCloseNewEntryModal}
        />

        <Modal
          visible={monthPickerTransition.isMounted}
          animationType="none"
          transparent
          onRequestClose={handleCloseMonthPicker}
          statusBarTranslucent
          navigationBarTranslucent
        >
          {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる(他のモーダルと同じパターン) */}
          <Pressable
            style={styles.modalOverlay}
            onPress={handleCloseMonthPicker}
            testID="modal-overlay-pressable"
          >
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.modalOverlayBackground,
                { opacity: monthPickerTransition.overlayOpacity },
              ]}
            />
            <Animated.View
              style={{ transform: [{ translateY: monthPickerTransition.contentTranslateY }] }}
            >
              <ThemedView
                style={[
                  styles.modalContent,
                  {
                    borderColor: iconColor,
                    paddingBottom: modalContentBottomPadding,
                    maxHeight: monthPickerMaxHeight,
                  },
                ]}
                // オーバーレイへのタップ伝播を防ぐため、modalContent内のタッチ開始をこのViewが引き受ける
                onStartShouldSetResponder={() => true}
              >
                <View style={styles.modalHeader}>
                  <ThemedText type="subtitle">年月を選択</ThemedText>
                  <Pressable
                    onPress={handleCloseMonthPicker}
                    accessibilityRole="button"
                    accessibilityLabel="閉じる"
                  >
                    <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                      閉じる
                    </ThemedText>
                  </Pressable>
                </View>
                <View style={styles.yearStepperRow}>
                  <Pressable
                    onPress={() => handlePickerYearStep(-1)}
                    disabled={isPreviousYearDisabled}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="前の年"
                    accessibilityState={{ disabled: isPreviousYearDisabled }}
                    style={[
                      styles.yearStepperButton,
                      isPreviousYearDisabled ? styles.disabledButton : null,
                    ]}
                  >
                    <IconSymbol
                      name="chevron.left"
                      size={24}
                      color={isPreviousYearDisabled ? iconColor : tintColor}
                    />
                  </Pressable>
                  <ThemedText type="subtitle">{pickerYear}年</ThemedText>
                  <Pressable
                    onPress={() => handlePickerYearStep(1)}
                    disabled={isNextYearDisabled}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="次の年"
                    accessibilityState={{ disabled: isNextYearDisabled }}
                    style={[
                      styles.yearStepperButton,
                      isNextYearDisabled ? styles.disabledButton : null,
                    ]}
                  >
                    <IconSymbol
                      name="chevron.right"
                      size={24}
                      color={isNextYearDisabled ? iconColor : tintColor}
                    />
                  </Pressable>
                </View>
                {/* maxHeightに収まらない画面でも全ての月に到達できるようスクロール可能にする */}
                <ScrollView contentContainerStyle={styles.monthGrid} testID="month-picker-scroll">
                  {JA_MONTH_NAMES.map((monthName, index) => {
                    const month = index + 1;
                    const isSelected = pickerYear === displayedYear && month === displayedMonth;
                    const isDisabled = !isPickerMonthInRange(pickerYear, month);
                    return (
                      <Pressable
                        key={monthName}
                        style={[
                          styles.monthGridButton,
                          { borderColor: iconColor },
                          isSelected
                            ? { backgroundColor: tintColor, borderColor: tintColor }
                            : null,
                          isDisabled ? styles.disabledButton : null,
                        ]}
                        onPress={() => handleSelectMonth(month)}
                        disabled={isDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={`${pickerYear}年${monthName}へ移動`}
                        accessibilityState={{ selected: isSelected, disabled: isDisabled }}
                      >
                        <ThemedText
                          style={isSelected ? { color: backgroundColor } : { color: textColor }}
                        >
                          {monthName}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </ThemedView>
            </Animated.View>
          </Pressable>
        </Modal>
      </TabScreenContainer>
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
  },
  // 背景タップでキーボードを閉じるPressableラッパー。直接の親がこちらに変わったため、
  // 元containerのgapもここへ移動している
  contentWrapper: {
    flex: 1,
    gap: 16,
  },
  title: {
    // セーフエリア上端インセットぶんの余白はTabScreenContainer側で加算済みのため、
    // ここではタイトル自体のベース余白のみを指定する
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
  searchContainer: {
    gap: 8,
    // クリアボタンを入力欄の右側に重ねて配置するための基準
    position: 'relative',
    justifyContent: 'center',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  searchInputWithClear: {
    paddingRight: 36,
  },
  searchClearButton: {
    position: 'absolute',
    right: 8,
    height: 24,
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearButtonText: {
    fontSize: 16,
    lineHeight: 16,
  },
  searchResultsList: {
    flex: 1,
  },
  searchResultItem: {
    gap: 4,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchResultDate: {
    fontSize: 12,
  },
  searchResultHighlight: {
    fontWeight: 'bold',
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
  saveButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  errorText: {
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 4,
    gap: 8,
  },
  emptyStateText: {
    opacity: 0.7,
  },
  // エラー表示はコントラスト確保のためemptyStateTextのopacityを継承しない
  emptyStateErrorText: {
    textAlign: 'center',
  },
  retryButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  retryButtonText: {
    fontWeight: '600',
  },
  calendarWrapper: {
    // 残りスペースをすべて使い切る外枠。日付グリッドの高さ計算もこの実測高さを基準にし、
    // 外枠と内部の基準がズレて中身がはみ出さないようにする
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    // 実測に多少の誤差があっても、日付グリッドが外枠からはみ出して見えないようにする保険
    overflow: 'hidden',
  },
  // 週表示のカレンダー部分。calendarWrapperと同様に残りスペースを使い切る
  weekWrapper: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  weekScrollContent: {
    padding: 8,
  },
  // フォーカス中の日の見出しと、タップで前後日へ移動するボタンを並べるナビゲーションバー
  weekFocusNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  weekRow: {
    flexDirection: 'row',
    gap: 4,
  },
  weekColumn: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  // フォーカス中の日を枠線で強調するため、常に(透明の)枠線を確保しておきレイアウトのガタつきを防ぐ
  weekColumnHeader: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  weekDayName: {
    fontSize: 12,
  },
  weekColumnEntries: {
    width: '100%',
    gap: 4,
  },
  // タップ領域の目安(44pt)を確保した、日記の無い日の新規作成ボタン
  weekCreateButton: {
    width: '100%',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  weekCreateButtonText: {
    fontSize: 20,
    lineHeight: 24,
  },
  weekEntryItem: {
    width: '100%',
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  weekEntryText: {
    fontSize: 10,
  },
  calendarHeaderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  calendarHeaderText: {
    // react-native-calendarsのデフォルト見出し(textMonthFontSize/textMonthFontWeight)と揃えた見た目にしている
    fontSize: 18,
    fontWeight: '700',
  },
  yearStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  yearStepperButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  monthGridButton: {
    // 3列×4行で12ヶ月を並べる(gap込みで4等分すると幅がはみ出すため31%にしている)
    width: '31%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  disabledButton: {
    opacity: 0.35,
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
  entryDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  entryCountBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  entryCountText: {
    fontSize: 9,
    fontWeight: '700',
    // ThemedTextのデフォルトlineHeight(24)だと丸の中で数字が下寄りになるため、fontSizeに近い値を明示する
    lineHeight: 11,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // 背景の暗さを別レイヤーにし、opacityフェードをコンテンツのスライドから独立させる
  modalOverlayBackground: {
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
});
