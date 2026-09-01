import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
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

import { SaveToast } from '@/components/save-toast';
import { TabScreenContainer } from '@/components/tab-screen-container';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useThemePreference } from '@/contexts/theme-preference-context';
import { useThemeColor } from '@/hooks/use-theme-color';
import { buildCreatedAtForDateKey, formatDateHeading, toDateKey } from '@/utils/diary-date';
import { BODY_MAX_LENGTH, splitIntoGraphemes, truncateToBodyMaxLength } from '@/utils/diary-text';
import { getAllDiaryEntries, saveDiaryEntry, type DiaryEntry } from '@/utils/diary-storage';

// 保存前の下書き(draft)を自動保存するためのAsyncStorageキー。日記本文の保存キー(エントリ単位の
// 個別キー、utils/diary-storage.ts参照)とは
// 別キーにすることで、保存済みエントリの一覧データとは独立して読み書きできるようにする。
// 「保存」ボタンを押すまで下書きが永続化されないと、入力途中でアプリがバックグラウンド化・
// 強制終了された場合に内容が失われてしまうため、入力が止まってから一定時間後に自動保存し、
// 次回起動時・画面マウント時に復元する
const DIARY_DRAFT_STORAGE_KEY = 'diary-draft';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)。1文字入力するたびにAsyncStorageへ書き込むと
// 頻度が高すぎるため、入力が一定時間止まってからまとめて保存する
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

// カレンダーの日付セルに表示するタイトルの最大文字数(超える場合は省略記号を付ける)
const TITLE_MAX_LENGTH = 20;

// 保存成功時にトーストへ表示するメッセージ
const SAVE_SUCCESS_MESSAGE = '保存しました';

// 日付セルの高さのデフォルト最小値(外枠の実測高さがまだ取れていない初回レンダー用のフォールバック)
const DEFAULT_DAY_CELL_HEIGHT = 48;
// 日付セル内テキストの拡大率上限。react-native-calendarsのヘッダー・曜日行はallowFontScaling={false}
// 固定でOS文字サイズ設定の影響を受けないが、差し替えているセル本体(ThemedText)は無制限に
// 拡大されるとdayCellHeightを超えてoverflow: 'hidden'で見切れるため、上限を設けてリスクを抑える
const DAY_CELL_MAX_FONT_SCALE = 1.5;
// showSixWeeksを有効にし、月をまたいでも常に6行で表示を揃えるため6固定で計算する
const CALENDAR_WEEK_ROWS = 6;
// react-native-calendarsのヘッダー+曜日行のおおよその高さと、週の行のマージン(デフォルトの
// weekVerticalMargin=7を上下2回分)。ヘッダー等はallowFontScaling={false}固定でOS文字サイズ設定の
// 影響を受けないため、この概算値もフォントスケール補正なしの固定値としてそのまま使う
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

// 指定した年月の1日を表す'YYYY-MM-DD'キーを組み立てる(calendarInitialDateの更新箇所で共通利用する)
function getFirstDayOfMonthKey(year: number, month: number): string {
  return `${year}-${`${month}`.padStart(2, '0')}-01`;
}

// react-native-calendarsが使うdayComponentのpropsの型(ライブラリ側から直接exportされていないため、
// CalendarPropsから抽出して利用する)
type DayComponentProps = ComponentProps<NonNullable<CalendarProps['dayComponent']>>;

// 日本語の月名。react-native-calendarsのロケール設定(月名・月省略名)と、
// 年月ジャンプ用ピッカーの月ボタン表示の両方で共有する
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

// 日記本文からカレンダーセルに表示する短いタイトルを作る
// (改行があれば最初の行のみを使い、さらに長ければ指定文字数で切り詰める)。
// 文字数のカウント・切り詰めは書記素クラスタ単位で行い、絵文字などの
// サロゲートペア・結合文字の途中で文字列が分断されないようにする
function getEntryTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const graphemes = splitIntoGraphemes(firstLine);
  if (graphemes.length <= TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${graphemes.slice(0, TITLE_MAX_LENGTH).join('')}…`;
}

// 検索結果の抜粋で、マッチ箇所の前後何文字を表示するか
const SEARCH_EXCERPT_CONTEXT_LENGTH = 20;

// ひらがな(U+3041〜U+3096)とカタカナ(U+30A1〜U+30F6)のコードポイントの差。
// ひらがなをカタカナへ寄せることで、ひらがな/カタカナの表記ゆれを吸収する
// (半角カタカナはNFKC正規化で全角カタカナに統一されるため、カタカナ側に寄せたほうが変換が少なく済む)
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

// 検索比較用に正規化した文字列と、その各文字が元の文字列上のどの範囲([start, end))に
// 対応するかを示すマップ
type NormalizedForSearch = {
  normalized: string;
  startMap: number[];
  endMap: number[];
};

// 検索クエリ・日記本文の比較前に行う正規化。
// 1. Unicodeの正規化形式NFKCにより、全角英数字→半角、半角カタカナ→全角カタカナ等の
//    全角/半角の表記ゆれを吸収する。
// 2. ひらがなをカタカナへ変換し、ひらがな/カタカナの表記ゆれを吸収する。
// 大文字/小文字は呼び出し元でtoLowerCase()するため、ここでは扱わない。
// 抜粋表示(getSearchExcerpt)で「正規化後の文字列上でのマッチ位置」を「元の文字列上の位置」に
// 復元できるよう、1文字ずつ正規化しながら元の文字列上の範囲(startMap/endMap)を記録する。
// NFKCは文字によって1文字→複数文字に展開されることがあるため、その場合は展開後の各文字を
// 同じ元の文字の範囲に対応付ける。逆に「ｶ」+「ﾞ」→「ガ」のような複数文字が正規化によって
// 1文字に減るケースは、1文字ずつ独立に正規化する本実装では結合されず素通りする
// (稀なエッジケースであり表記ゆれ対応の主眼ではないため、この程度の割り切りとする)
function normalizeForSearch(text: string): NormalizedForSearch {
  let normalized = '';
  const startMap: number[] = [];
  const endMap: number[] = [];
  let originalIndex = 0;
  for (const char of text) {
    const normalizedChar = hiraganaToKatakana(char.normalize('NFKC'));
    const charEnd = originalIndex + char.length;
    // normalizedChar内の各文字(絵文字等のサロゲートペア文字を含みうる)について、
    // normalized文字列に加算されるUTF-16コード単位数(c.length)分だけstartMap/endMapに
    // pushする。1文字=1pushだと、サロゲートペア文字(c.length===2)で
    // normalizedとstartMap/endMapの長さがズレ、以降のインデックス参照が崩れる
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

// 検索キーワードにマッチした日記本文から、マッチ箇所を中心とした抜粋を作る。
// 改行を挟むと一覧上で見づらくなるため空白に置き換え、前後を切り詰めた場合は省略記号を付ける。
// (タイトル表示用のgetEntryTitle/splitIntoGraphemesとは異なり、抜粋位置の計算は
// 単純な文字列操作で行っている。サロゲートペア境界で万一ズレても表示が多少前後するだけで、
// 機能上の実害は無いため、既存のタイトル省略ロジックほど厳密なgrapheme単位分割はしていない)
function getSearchExcerpt(text: string, query: string): string {
  const normalizedText = text.replace(/\n+/g, ' ');
  const {
    normalized: lowerText,
    startMap,
    endMap,
  } = normalizeForSearch(normalizedText.toLowerCase());
  const lowerQuery = normalizeForSearch(query.toLowerCase()).normalized;
  const matchIndex = lowerText.indexOf(lowerQuery);

  // 通常は呼び出し元でマッチ済みのエントリのみ渡されるため到達しないはずだが、
  // 念のためフォールバックとして先頭部分を返す
  if (matchIndex === -1 || lowerQuery.length === 0) {
    return getEntryTitle(normalizedText);
  }

  // 正規化後の文字列上でのマッチ位置(matchIndex)を、startMap/endMap経由で
  // 元の文字列(normalizedText)上のマッチ範囲に変換する
  const matchStart = startMap[matchIndex] ?? 0;
  const matchEnd = endMap[matchIndex + lowerQuery.length - 1] ?? normalizedText.length;

  const start = Math.max(0, matchStart - SEARCH_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(normalizedText.length, matchEnd + SEARCH_EXCERPT_CONTEXT_LENGTH);
  const excerpt = normalizedText.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalizedText.length ? '…' : '';
  return `${prefix}${excerpt}${suffix}`;
}

// モーダルの背景オーバーレイ(フェード)・コンテンツ(下端からのスライド)のアニメーション時間(ミリ秒)。
// 2箇所のモーダル(新規作成・年月ピッカー)すべてで同じ見た目・タイミングになるよう
// 共通の定数として持つ(日付一覧・編集は専用画面への遷移(Issue #221)に置き換えたため対象外)
const MODAL_ANIMATION_DURATION_MS = 220;

// コンテンツのスライドイン開始位置(画面外下端)。modalContentの高さは中身の量によって変わるため、
// 画面全体の高さを開始位置に使うことで、コンテンツの実際の高さによらず必ず画面外からスライドさせる
const MODAL_SLIDE_DISTANCE = Dimensions.get('window').height;

// 背景オーバーレイのフェードとコンテンツのスライドを分離してアニメーションさせるためのフック。
// `Modal`自体の`animationType`は'none'にし、呼び出し側でこのフックが返すAnimated.Valueを
// オーバーレイ/コンテンツそれぞれのstyleに適用する。
// `isOpen`がtrue→falseになった瞬間に`Modal`の`visible`をfalseにすると退場アニメーションが
// 再生される前にモーダルが消えてしまうため、実際に`Modal`を描画するかどうかを表す`isMounted`を
// 別のstateとして持ち、退場アニメーション完了後のコールバックでfalseに反映する
// (`isOpen`自体の値やその変化タイミングは、呼び出し側の既存の開閉ロジック・破棄確認Alert等に
// 一切影響しない)
function useModalSlideTransition(isOpen: boolean) {
  const [isMounted, setIsMounted] = useState(isOpen);
  const overlayOpacity = useRef(new Animated.Value(isOpen ? 1 : 0)).current;
  const contentTranslateY = useRef(new Animated.Value(isOpen ? 0 : MODAL_SLIDE_DISTANCE)).current;

  useEffect(() => {
    if (isOpen) {
      // 入場アニメーションを再生する前に描画状態にする(退場時はアニメーション完了後にfalseへ戻す)
      setIsMounted(true);
    }
    // opacity/transformはどちらもuseNativeDriverの対象にでき、UIスレッド側でアニメーションが
    // 進行するためJSスレッドの混雑(入力処理等)の影響を受けにくくなる
    const animation = Animated.parallel([
      Animated.timing(overlayOpacity, {
        toValue: isOpen ? 1 : 0,
        duration: MODAL_ANIMATION_DURATION_MS,
        useNativeDriver: true,
      }),
      Animated.timing(contentTranslateY, {
        toValue: isOpen ? 0 : MODAL_SLIDE_DISTANCE,
        duration: MODAL_ANIMATION_DURATION_MS,
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      // 新しいアニメーション開始によって中断された場合はfinished===falseになる。
      // その場合は何もせず、後から開始した(=最新の)アニメーション側の完了処理に任せる
      if (finished && !isOpen) {
        setIsMounted(false);
      }
    });
    return () => animation.stop();
  }, [isOpen, overlayOpacity, contentTranslateY]);

  return { isMounted, overlayOpacity, contentTranslateY };
}

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  // 初回のloadEntries完了までの間だけtrueにする読み込み中フラグ。
  // useFocusEffectによりloadEntriesはタブへフォーカスが当たるたびに毎回呼ばれるが、
  // その都度trueへ戻してしまうと空状態メッセージの代わりに表示するローディング表示が
  // 毎回ちらついてしまうため、初期値true→初回読み込み完了時にfalseの一方向にのみ遷移させる
  // (falseになった後は二度とtrueへ戻さない)
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState('');
  // 起動時・画面マウント時にAsyncStorageからの下書き復元が完了したかどうか。復元が完了する前に
  // 自動保存用のeffectを動かしてしまうと、まだ何も読み込んでいない初期値(空文字列)で
  // 保存済みの下書きを誤って上書き・削除してしまうため、復元完了までは自動保存の対象外にする
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 保存成功時に一時的に表示するトーストのメッセージ。nullの間は非表示
  const [saveToastMessage, setSaveToastMessage] = useState<string | null>(null);
  // 日記本文のキーワード検索用の入力値。既存の「今日の出来事を書く」入力欄(composer)とは
  // 独立した、検索専用のstate
  const [searchQuery, setSearchQuery] = useState('');
  // handleSave(新規保存)の実行中かどうか。保存ボタンの連打(またはタップと同時に発生する
  // 複数のonPressイベント)によって、同じ内容の日記エントリが重複して保存されてしまうことを防ぐため、
  // 実行中は早期returnし、保存ボタンもdisabledにする
  const [isSaving, setIsSaving] = useState(false);
  // 新規作成モーダル(日記の無い日をタップした際に、その日付向けに新規作成する導線)の対象日付
  // ('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [newEntryDate, setNewEntryDate] = useState<string | null>(null);
  const [newEntryDraft, setNewEntryDraft] = useState('');
  const [newEntryError, setNewEntryError] = useState<string | null>(null);
  // handleSaveNewEntryの実行中かどうか。isSavingと同様、連打による重複保存を防ぐため、
  // 実行中は早期returnし、保存ボタンもdisabledにする
  const [isSavingNewEntry, setIsSavingNewEntry] = useState(false);
  // handleSave内の保存処理(pending中)開始後に、ユーザーがdraft用TextInputへ入力操作を
  // 行ったかどうかを表すref。「pending開始時にセットした空文字列のまま」なのか
  // 「pending中に入力した末、自分で全部消して空文字列に戻した」のかを、値の内容(空文字列か
  // どうか)では区別できないため、編集操作の有無そのものをrefで別途持つ
  const draftEditedRef = useRef(false);
  // カレンダーの外枠(タイトル・入力欄・保存ボタンの下からタブバーの上までの残りスペースを
  // `flex: 1`で使い切るView)の実測高さ(onLayoutで取得)。この外枠自体に枠線・角丸を付け、
  // 日付グリッドの高さもこの実測値を基準に算出することで、外枠と日付グリッドの基準を一致させる
  const [wrapperHeight, setWrapperHeight] = useState(0);
  // カレンダーに現在表示中の年・月。react-native-calendarsのCalendarは`current`propを
  // 初回マウント時にしか参照しないため(以降のジャンプにはinitialDateを使う。下記
  // calendarInitialDateのコメント参照)、ヘッダーの年月表示・年月ピッカーの初期選択・
  // 月ボタンのハイライトはこのstateを正とする。onMonthChangeでユーザーのスワイプ/矢印操作にも追従する
  const [displayedYear, setDisplayedYear] = useState(() => new Date().getFullYear());
  const [displayedMonth, setDisplayedMonth] = useState(() => new Date().getMonth() + 1);
  // Calendarへ渡す'YYYY-MM-DD'形式の日付。react-native-calendars内部の実装上、`current`propは
  // 初回マウント時の初期値としてしか使われず、マウント後に値を変えても表示月は追従しない一方、
  // `initialDate`propは値が変わるたびにその月へ強制的にジャンプする挙動になっているため、
  // 年月ピッカーで選択された年月へジャンプさせる用途にはこちらを使う。加えて、テーマ切替時の
  // `key={colorScheme}`強制再マウント(下のCalendar参照)後もスワイプ・矢印操作で移動した月を
  // 復元できるよう、handleMonthChangeでも常にその月の1日に同期させている
  const [calendarInitialDate, setCalendarInitialDate] = useState(() => toDateKey(new Date()));
  // 年月ジャンプ用ピッカーモーダルの表示状態と、ピッカー内で選択中の年
  // (月は上のdisplayedMonthをそのまま参照する)
  const [isMonthPickerVisible, setIsMonthPickerVisible] = useState(false);
  const [pickerYear, setPickerYear] = useState(displayedYear);

  // 2つのモーダル(新規作成・年月ピッカー)それぞれの、背景オーバーレイのフェードと
  // コンテンツのスライドを分離したアニメーション制御(詳細はuseModalSlideTransitionのコメント参照)。
  // 日付一覧・編集は専用画面への遷移(Issue #221)に置き換えたため、対象はこの2つのみになった
  const newEntryModalTransition = useModalSlideTransition(newEntryDate !== null);
  const monthPickerTransition = useModalSlideTransition(isMonthPickerVisible);

  const router = useRouter();
  const { colorScheme } = useThemePreference();
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  // この画面内で行う保存処理(「今日」の入力欄からの新規保存・日付指定の新規作成)の
  // 永続化を直列化するためのキュー。編集・削除は専用画面(day-entries/edit-entry)へ
  // 移動しそちらで直接永続化するため、このキューの対象は「保存」のみになっている。
  // loadEntriesが下でこのrefを参照するため、宣言順をloadEntriesより前にしている
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  // 現在キューに積まれている(まだAsyncStorageへの書き込みが完了していない)タスクの件数。
  // loadEntriesが「pending中の書き込みがある場合だけ」writeQueueRef.currentを待つかどうかの
  // 判定に使う(詳細はloadEntries内のコメント参照)
  const pendingWriteCountRef = useRef(0);

  const loadEntries = useCallback(async () => {
    // useFocusEffectでタブに再フォーカスした際、保存の書き込みがwriteQueueRef上で
    // まだpending中(AsyncStorageへの実際の書き込みが完了していない)ことがある。ここで待たずに
    // 読み込むと、キューの書き込みが完了する前の古い内容を一時的に読み込んでしまい、楽観的更新で
    // 表示していた内容から一瞬戻ってしまう(その後キューの書き込みが完了すればUIは正しい状態に
    // 収束するが、ちらつきとして見えてしまう)。そのため、pending中の書き込みがある場合に限り、
    // 直近でキューに積まれた書き込みが完了するまで待ってから読み込む。
    // pending中の書き込みが無い場合にまで無条件で`await`すると、既に解決済みのPromiseであっても
    // 1マイクロタスク分の遅延が余分に発生し、他の非同期処理(下書き復元など)との実行順序が
    // ずれてしまうため、必要な場合のみ待つようにしている
    if (pendingWriteCountRef.current > 0) {
      await writeQueueRef.current;
    }
    // 復号を含む読み込みロジックはutils/diary-storage.tsの共通関数に集約しており、
    // 設定画面のエクスポート機能とも共有している。ストレージが空・壊れている場合は
    // 例外を投げず空配列を返す仕様のため、ここで個別にtry/catchする必要はない
    setEntries(await getAllDiaryEntries());
    // 初回読み込みが完了したことを示す(既にfalseの場合でも呼び出し自体は無害)。
    // isLoadingをtrueへ戻す処理はどこにも無いため、一方向にのみ遷移する
    setIsLoading(false);
  }, []);

  // entryは今回保存する1件分のエントリ(新規作成)を表す。エントリ単位の個別キーで
  // 保存するため、他のエントリの読み書きは発生しない
  const enqueueDiaryWrite = useCallback((entry: DiaryEntry): Promise<void> => {
    // タスクをキューに積んだ時点(実行完了を待たず)で同期的にインクリメントする。
    // これにより、この関数の呼び出し直後にloadEntriesが走った場合でも、
    // まだ実行順が回ってきていないタスクの存在を正しく検知できる
    pendingWriteCountRef.current += 1;
    const task = writeQueueRef.current.then(async () => {
      await saveDiaryEntry(entry);
    });
    // キュー自体は個々のタスクの成否に関わらず先に進める(失敗はtask側のcatchで呼び出し元に伝える)。
    // 併せてpendingWriteCountRefも、成否に関わらずタスクが完了(=もはやpendingではなくなる)
    // 時点でデクリメントする
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

  // expo-routerの`Tabs`はデフォルトで一度訪れたタブ画面をアンマウントせず保持するため、
  // マウント時に一度だけ読み込む`useEffect`だと、設定タブでの全件削除のように他画面から
  // AsyncStorageが書き換えられても、この画面のstateには反映されないまま残ってしまう
  // (その状態で新しい日記を保存すると、stateに残っていた削除前の古いエントリを含めて
  // 上書き保存してしまい、削除したはずのデータが復活する)。
  // `useFocusEffect`でタブにフォーカスが当たるたびに読み込み直すことで、この不整合を防ぐ
  // (初回マウント時にフォーカスされている場合も含めて発火するため、従来のマウント時読み込みも兼ねる)。
  useFocusEffect(
    useCallback(() => {
      loadEntries();
    }, [loadEntries]),
  );

  // 起動時・画面マウント時に、自動保存されていた下書きが残っていればTextInputへ復元する。
  // タブの再フォーカスのたびに実行されるuseFocusEffectとは異なり、マウント時に一度だけ読めばよい
  // (この画面がアンマウントされずに保持される間は、draft自体が引き続きReact stateとして残るため)。
  useEffect(() => {
    let isCancelled = false;
    (async () => {
      try {
        const storedDraft = await AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY);
        if (!isCancelled && storedDraft) {
          setDraft(storedDraft);
        }
      } catch {
        // 下書きの読み込みに失敗した場合は復元を諦めるだけにとどめ、未処理のPromise
        // rejectionを発生させない。ここで早期returnせずisDraftRestoredをtrueにすることで、
        // 以降のデバウンス自動保存(下のuseEffect)が無効化されたままにならないようにする
      } finally {
        if (!isCancelled) {
          setIsDraftRestored(true);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  // draftの変更をデバウンスし、入力が一定時間止まってからAsyncStorageへ自動保存する。
  // 入力途中でアプリがバックグラウンド化・強制終了された場合でも、次回起動時に下書きを復元できる
  useEffect(() => {
    // 下書きの復元が完了する前は、まだ何も読み込んでいない初期値(空文字列)で
    // 保存済みの下書きを誤って上書き・削除してしまわないよう、何もしない
    if (!isDraftRestored) {
      return;
    }
    const timer = setTimeout(() => {
      const persist = draft
        ? AsyncStorage.setItem(DIARY_DRAFT_STORAGE_KEY, draft)
        : AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      // 下書きの自動保存はバックグラウンドでの補助的な処理のため、失敗してもユーザーの入力自体には
      // 影響させず、静かに無視する(本保存の失敗はhandleSave側でsaveErrorとして明示的に伝える)
      persist.catch(() => {});
    }, DRAFT_AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, isDraftRestored]);

  const handleSave = useCallback(async () => {
    // 既に保存処理が進行中であれば、連打による重複保存を防ぐため何もしない
    if (isSaving) {
      return;
    }

    const trimmed = draft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(onChangeText側のgrapheme単位の
    // 切り詰めが主な防御線)。上限チェック自体もsplitIntoGraphemesでgrapheme単位で行い、
    // UTF-16コードユニット単位のlengthとのズレを防ぐ
    if (!trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
      return;
    }

    setIsSaving(true);

    const newEntry: DiaryEntry = {
      // Date.now().toString() は同一ミリ秒での衝突リスクがあるため、
      // 衝突しにくいUUID v4を生成するexpo-cryptoのrandomUUID()を使用する
      id: randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const previousEntries = entries;
    const previousDraft = draft;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    setEntries([newEntry, ...entries]);
    setDraft('');
    // pending開始時点ではまだ編集操作が発生していないことを表すため、フラグをリセットする
    draftEditedRef.current = false;
    setSaveError(null);

    try {
      // 日記本文を平文のままAsyncStorageに保存しないよう、SecureStoreで保護した鍵で
      // AES-256-GCM暗号化してから保存する。この画面内の他の保存処理と競合しないよう、
      // 書き込みはキュー経由で直列化する(このエントリ専用のキーへの書き込みのみで完結する)
      await enqueueDiaryWrite(newEntry);
      // 既に楽観的更新でReact stateは正しい内容になっているため、永続化された内容での
      // setEntriesによる再同期は不要

      // 保存に成功したので、自動保存していた下書きは不要になったためクリアする。
      // draft自体は既にsetDraft('')で空にしているが、AsyncStorage側に下書きキーが残ったままだと
      // 次回起動時に既に保存済みの内容を誤って復元してしまうため、明示的に削除する
      try {
        await AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      } catch {
        // 下書きキーのクリアに失敗しても、日記本体は既に保存済みで致命的ではないため無視する
      }

      // 保存成功をユーザーに明示するため、一時的なトーストとハプティックフィードバックを発火する。
      // 保存失敗時はsaveErrorでエラーメッセージを表示しており、成功時も対称的にフィードバックする
      setSaveToastMessage(SAVE_SUCCESS_MESSAGE);
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、ユーザーにエラーを伝える。
      // ただし、保存処理中(この非同期処理の完了を待つ間)にユーザーが既に次の文章を
      // 入力し始めている場合、previousDraftで単純に上書きすると新しい入力を消してしまう。
      // 現在値が空文字列かどうかでは、「pending開始時のまま何も入力していない」場合と
      // 「pending中に入力した後、自分で全部消して空文字列に戻した」場合を区別できないため、
      // draftEditedRef(pending開始後に編集操作があったかどうか)で判定する。
      // 編集操作が無ければpreviousDraftへ戻し、編集操作があればユーザーが最後に入力した
      // 内容(空文字列を含む)をそのまま優先して上書きしない
      setEntries(previousEntries);
      if (!draftEditedRef.current) {
        setDraft(previousDraft);
      }
      setSaveError('保存に失敗しました。もう一度お試しください。');
    } finally {
      // 成功・失敗いずれの場合も、次の保存を行えるよう必ず実行中フラグを戻す
      setIsSaving(false);
    }
  }, [draft, entries, isSaving, enqueueDiaryWrite]);

  // draft用TextInputのonChangeText。setDraftに加えて、pending中にユーザーが入力操作を
  // 行ったことをdraftEditedRefへ記録する(handleSaveの保存失敗時ロールバック判定に使う)。
  // TextInput側にmaxLength propを指定していないため、ここでtruncateToBodyMaxLengthを使い
  // grapheme単位でBODY_MAX_LENGTHを超えないよう切り詰める
  const handleChangeDraft = useCallback((text: string) => {
    draftEditedRef.current = true;
    setDraft(truncateToBodyMaxLength(text));
  }, []);

  // 新規作成用TextInputのonChangeText。draft用と同様の理由でtruncateToBodyMaxLength
  // (grapheme単位の切り詰め)を使う
  const handleChangeNewEntryDraft = useCallback((text: string) => {
    setNewEntryDraft(truncateToBodyMaxLength(text));
  }, []);

  // 新規作成モーダルを実際に閉じる処理本体(handleCancelNewEntryから、確認不要な場合は直接、
  // 確認が必要な場合はAlert.alertの「破棄」選択時に呼ばれる)
  const closeNewEntryModal = useCallback(() => {
    setNewEntryDate(null);
    setNewEntryDraft('');
    setNewEntryError(null);
  }, []);

  // 新規作成モーダルを閉じる(背景タップ・「閉じる」ボタン・Android戻る操作の共通ハンドラ)。
  // 入力途中の内容がある場合のみ、誤って入力内容を失わないよう確認ダイアログを挟む
  const handleCancelNewEntry = useCallback(() => {
    if (!newEntryDraft.trim()) {
      closeNewEntryModal();
      return;
    }

    Alert.alert('変更を破棄しますか?', '入力中の内容は保存されません。', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '破棄', style: 'destructive', onPress: closeNewEntryModal },
    ]);
  }, [newEntryDraft, closeNewEntryModal]);

  // 日記の無い日をタップして開いたモーダルからの新規保存。ホーム画面上部の「今日」入力欄用の
  // handleSaveとは異なり、createdAtをその瞬間の日時ではなく選択された日付基準
  // (buildCreatedAtForDateKey)にする
  const handleSaveNewEntry = useCallback(async () => {
    // 既に保存処理が進行中であれば、連打による重複保存を防ぐため何もしない
    if (isSavingNewEntry || !newEntryDate) {
      return;
    }

    const trimmed = newEntryDraft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(onChangeText側のgrapheme単位の
    // 切り詰めが主な防御線)。上限チェック自体もsplitIntoGraphemesでgrapheme単位で行い、
    // UTF-16コードユニット単位のlengthとのズレを防ぐ
    if (!trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
      return;
    }

    setIsSavingNewEntry(true);

    const newEntry: DiaryEntry = {
      id: randomUUID(),
      text: trimmed,
      createdAt: buildCreatedAtForDateKey(newEntryDate),
    };
    const previousEntries = entries;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    setEntries([newEntry, ...entries]);
    setNewEntryError(null);

    try {
      // この画面内の他の保存処理と競合しないよう、書き込みはキュー経由で直列化する
      // (このエントリ専用のキーへの書き込みのみで完結する)
      await enqueueDiaryWrite(newEntry);
      // 既に楽観的更新でReact stateは正しい内容になっているため、永続化された内容での
      // setEntriesによる再同期は不要。永続化に成功した場合のみモーダルを閉じる
      setNewEntryDate(null);
      setNewEntryDraft('');
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、モーダルは開いたままエラーを伝える
      setEntries(previousEntries);
      setNewEntryError('保存に失敗しました。もう一度お試しください。');
    } finally {
      // 成功・失敗いずれの場合も、次の保存を行えるよう必ず実行中フラグを戻す
      setIsSavingNewEntry(false);
    }
  }, [entries, enqueueDiaryWrite, isSavingNewEntry, newEntryDate, newEntryDraft]);

  // トーストを非表示にする(SaveToastのuseEffectの依存配列に含まれるため、毎レンダーで
  // 参照が変わらないようuseCallbackで安定化する。インライン関数のままだと、トースト表示中に
  // ユーザーが入力欄を編集し続けるたびにHomeScreenが再レンダーされてonHideの参照が変わり、
  // 自動非表示タイマーが張り直され続けてトーストが仕様通り2.5秒で消えなくなってしまう)
  const handleHideSaveToast = useCallback(() => {
    setSaveToastMessage(null);
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

  // 検索キーワードに本文が部分一致する(大文字小文字、全角/半角、ひらがな/カタカナの
  // 表記ゆれを区別しない)エントリの一覧。
  // 全文検索エンジンのような大掛かりな仕組みは使わず、既存のentries stateに対する
  // クライアントサイドの単純なフィルタリングで実現する。
  // 新しく書かれたものほど見つけやすいよう、日時の降順(新しい順)に並べ替える
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

  // 検索欄の「クリア」ボタン押下時、検索キーワードを空にしてカレンダー表示へ戻す
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

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

  // スワイプ・矢印操作でカレンダーの表示月が変わった際、ヘッダー表示と年月ピッカーの
  // ハイライトをその月に追従させる(ピッカー経由のジャンプ以外の全ての月変更手段をカバーする)。
  // 併せてcalendarInitialDateもその月の1日へ同期させる。react-native-calendarsの
  // Calendarは`theme` propをuseRefで初回計算した値のままキャッシュし続けるため、テーマ切替時に
  // `key={colorScheme}`で強制再マウントしているが(下のCalendar参照)、再マウント後の新しい
  // Calendarインスタンスは`initialDate`から表示月を再構築する。ここを同期させておかないと、
  // 月ピッカーを使わずスワイプ・矢印だけで移動した状態でテーマを切り替えた際、ヘッダー表示は
  // 移動後の月のままなのに実際の日付グリッドだけ古いinitialDate(=今日の月)へ巻き戻ってしまう
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

  // react-native-calendarsのrenderHeaderは矢印・曜日行はそのまま維持しつつ、中央の見出し部分のみを
  // 差し替える仕組みのため、既存のスワイプ・矢印での月送りやレイアウトに影響を与えず、
  // 見出しをタップ可能なボタンに置き換えられる
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

  const handleDayPress = useCallback(
    (date: DateData) => {
      if (entriesByDate[date.dateString]?.length) {
        // 月次・週次いずれの表示であっても、日付タップ時は専用の一覧画面へ遷移する
        // (以前はモーダル(ドロワー)として重ねて表示していたが、Issue #221で画面遷移に置き換えた)
        router.push(`/day-entries/${date.dateString}`);
        return;
      }
      // 日記の無い日は、未来日でなければその日付向けの新規作成モーダルを開く。
      // 未来日はCalendarのmaxDateで既にセル自体が押せなくなっている(renderDay参照)が、
      // 念のためここでも二重にチェックする
      if (date.dateString > toDateKey(new Date())) {
        return;
      }
      setNewEntryDate(date.dateString);
    },
    [entriesByDate, router],
  );

  const renderDay = useCallback(
    ({ date, state, onPress }: DayComponentProps) => {
      if (!date) {
        return null;
      }

      const dayEntries = entriesByDate[date.dateString];
      // その日にエントリが実在するか(タイトル文字列の有無ではなく、handleDayPressと同じ基準で判定する。
      // 本文が空白のみのレガシーデータではタイトルが空文字列になり得るため、両者を区別する必要がある)
      const hasEntries = Boolean(dayEntries?.length);
      const entryCount = dayEntries?.length ?? 0;
      const isDisabled = state === 'disabled' || state === 'inactive';
      const isToday = state === 'today';
      // 日記が無い日でも、未来日でなければ新規作成モーダルを開けるようタップ可能にする。
      // 未来日はCalendarのmaxDateによりstateが'disabled'になるため、それ以外は押せる扱いにする
      const isPressable = hasEntries || state !== 'disabled';
      // スクリーンリーダー(VoiceOver/TalkBack)利用者にも、セルの数字だけでなく
      // 「何年何月何日か」と「その日に日記があるか・新規作成できるか」が伝わるようラベルを組み立てる
      // (フォーマットはモーダル見出しと同じformatDateHeadingを再利用する)
      const statusLabel = hasEntries
        ? `日記あり(${entryCount}件)`
        : isPressable
          ? '日記なし、タップして新規作成'
          : '日記なし';
      const accessibilityLabel = `${formatDateHeading(date.dateString)}、${statusLabel}`;

      return (
        <Pressable
          style={[styles.dayCell, { height: dayCellHeight }]}
          onPress={() => onPress?.(date)}
          disabled={!isPressable}
          accessibilityRole={isPressable ? 'button' : undefined}
          accessibilityLabel={accessibilityLabel}
          // タップしても反応しない日はスクリーンリーダーにも操作不可であることを明示的に伝える
          accessibilityState={{ disabled: !isPressable }}
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
          {entryCount === 1 ? (
            // タイトル文字は小さすぎて読めないため、日記が1件あることだけが伝わる
            // 視認性の高いドットで代替する
            <View style={[styles.entryDot, { backgroundColor: tintColor }]} />
          ) : entryCount > 1 ? (
            // 2件以上ある場合は合計件数を丸バッジで表示する(モーダルを開かなくても
            // 複数件あることに気づけるようにするため)
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
    [entriesByDate, tintColor, backgroundColor, dayCellHeight],
  );

  // 文字数カウンター表示用に、grapheme単位で数え直す(絵文字などでUTF-16の.lengthとずれるため)
  const draftGraphemeCount = useMemo(() => splitIntoGraphemes(draft).length, [draft]);
  const newEntryDraftGraphemeCount = useMemo(
    () => splitIntoGraphemes(newEntryDraft).length,
    [newEntryDraft],
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android SDK 54のedge-to-edge対応でwindowSoftInputModeの自動リサイズが効かない
      // ケースがあるため、iOS同様behaviorを明示的に指定する(未指定だと入力欄が隠れうる)
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* ステータスバー/ノッチ領域とタイトルが重ならないよう、TabScreenContainerで
          セーフエリア上端インセットぶんの余白を自動的に加算する */}
      <TabScreenContainer style={styles.container}>
        {/* 背景タップでキーボードを閉じる。TextInput/Pressable自身がタッチを受け取るため既存の
            操作性は損なわれない。accessible={false}で内側の要素が1つにまとめて読み上げられるのを防ぐ */}
        <Pressable
          style={styles.contentWrapper}
          onPress={() => Keyboard.dismiss()}
          accessible={false}
        >
          <ThemedText type="title" style={styles.title}>
            日記
          </ThemedText>

          <ThemedView style={styles.composer}>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: tintColor }]}
              placeholder="今日の出来事や気持ちを書いてみましょう"
              placeholderTextColor={iconColor}
              value={draft}
              onChangeText={handleChangeDraft}
              multiline
              // placeholderはフォーカス後に読み上げられない環境があるため、
              // スクリーンリーダー向けに明示的なラベルを付ける
              accessibilityLabel="日記本文"
              // maxLength propはUTF-16コードユニット単位でしか制限できないためあえて指定せず、
              // handleChangeDraft側でgrapheme単位の切り詰めを行っている
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
                <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                  保存
                </ThemedText>
              </Pressable>
            </View>
            {saveError ? (
              <ThemedText style={[styles.errorText, { color: errorColor }]}>{saveError}</ThemedText>
            ) : null}
            {saveToastMessage ? (
              <SaveToast message={saveToastMessage} onHide={handleHideSaveToast} />
            ) : null}
          </ThemedView>

          {/* 日記本文のキーワード検索用の入力欄。「今日の出来事を書く」入力欄(composer)とは
            独立した検索専用の入力欄で、キーワードが入力されている間だけ下に検索結果一覧を表示する */}
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
              // 検索欄は日記本文をそのまま入力する用途ではなく、composer/edit用の
              // grapheme単位切り詰めのような厳密な制御は不要なため、TextInput標準の
              // maxLength(UTF-16コードユニット単位)でBODY_MAX_LENGTHを上限として指定する
              maxLength={BODY_MAX_LENGTH}
            />
            {searchQuery ? (
              // TextInputのclearButtonModeはiOS専用のためクロスプラットフォームで挙動を揃えられず、
              // 入力欄に重ねて配置するカスタムボタンでクリア操作を実現する
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
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.searchResultItem, { borderBottomColor: iconColor }]}
                  onPress={() => handleSearchResultPress(item)}
                >
                  <ThemedText style={[styles.searchResultDate, { color: iconColor }]}>
                    {formatDateHeading(toDateKey(new Date(item.createdAt)))}
                  </ThemedText>
                  <ThemedText numberOfLines={2}>
                    {getSearchExcerpt(item.text, trimmedSearchQuery)}
                  </ThemedText>
                </Pressable>
              )}
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
                // 初回読み込み中は、まだentriesが空配列なだけなのに空状態メッセージが
                // 一瞬誤って表示されてしまわないよう、代わりにローディング表示を出す
                <ThemedView style={styles.emptyState}>
                  <ActivityIndicator color={tintColor} />
                </ThemedView>
              ) : entries.length === 0 ? (
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
                  // react-native-calendars内部はtheme propに応じたスタイルをuseRefで初回計算した
                  // ものをキャッシュし続け、マウント後のtheme変更(Web版のハイドレーション後の
                  // colorScheme確定や、設定画面でのテーマ切り替え)に追従しない。colorSchemeを
                  // keyに含めて配色が変わるたびに強制的に再マウントさせ、常に現在のテーマで
                  // スタイルを計算させる
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
                  // 月・年の見出しを「2026年8月」のような日本語の語順で表示しつつ、タップで
                  // 年月ジャンプ用ピッカーを開けるボタンに差し替える(矢印・曜日行はそのまま維持される)
                  renderHeader={renderCalendarHeader}
                  enableSwipeMonths
                  // ピッカーから任意の年月へジャンプするための制御用prop(詳細は
                  // calendarInitialDate stateのコメント参照)。スワイプ・矢印操作による
                  // 表示月の変化もhandleMonthChange(onMonthChange)でstate側に反映する
                  initialDate={calendarInitialDate}
                  onMonthChange={handleMonthChange}
                  // 未来日を新規作成の対象外にするため、今日より後の日付をタップ不可(state: 'disabled')にする
                  maxDate={toDateKey(new Date())}
                  // 月によって行数(4〜6週)が変わって高さがガタつかないよう、常に6週分の高さで揃える
                  showSixWeeks
                />
              </View>
            </>
          )}
        </Pressable>

        <Modal
          visible={newEntryModalTransition.isMounted}
          animationType="none"
          transparent
          onRequestClose={handleCancelNewEntry}
          statusBarTranslucent
          navigationBarTranslucent
        >
          {/* Modalは親のKeyboardAvoidingViewとは別のネイティブサーフェスに描画され効果を受けないため、
              TextInput(本文入力欄)を含むこのモーダル内にも別途KeyboardAvoidingViewを配置する */}
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる(他のモーダルと同じパターン) */}
            <Pressable
              style={styles.modalOverlay}
              onPress={handleCancelNewEntry}
              testID="modal-overlay-pressable"
            >
              <Animated.View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  styles.modalOverlayBackground,
                  { opacity: newEntryModalTransition.overlayOpacity },
                ]}
              />
              <Animated.View
                style={{
                  transform: [{ translateY: newEntryModalTransition.contentTranslateY }],
                }}
              >
                <ThemedView
                  style={[styles.modalContent, { borderColor: iconColor }]}
                  // オーバーレイ側のPressableへタップイベントが伝播して意図せず閉じてしまわないよう、
                  // modalContent内でのタッチ開始をこのViewがレスポンダーとして引き受け、伝播を止める
                  onStartShouldSetResponder={() => true}
                >
                  <View style={styles.modalHeader}>
                    <ThemedText type="subtitle">
                      {newEntryDate ? formatDateHeading(newEntryDate) : ''}の日記を書く
                    </ThemedText>
                    <Pressable onPress={handleCancelNewEntry}>
                      <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                        閉じる
                      </ThemedText>
                    </Pressable>
                  </View>
                  <TextInput
                    style={[styles.input, { color: textColor, borderColor: tintColor }]}
                    placeholder="その日の出来事や気持ちを書いてみましょう"
                    placeholderTextColor={iconColor}
                    value={newEntryDraft}
                    onChangeText={handleChangeNewEntryDraft}
                    multiline
                    // draft用TextInputと同様、スクリーンリーダー向けに明示的なラベルを付ける
                    accessibilityLabel="日記本文"
                    // draft用TextInputと同様の理由でmaxLength propはあえて指定しない
                  />
                  <View style={styles.composerFooter}>
                    <ThemedText
                      style={[
                        styles.charCount,
                        newEntryDraftGraphemeCount >= BODY_MAX_LENGTH
                          ? { color: errorColor }
                          : { color: iconColor },
                      ]}
                    >
                      {newEntryDraftGraphemeCount}/{BODY_MAX_LENGTH}
                    </ThemedText>
                    <Pressable
                      style={[
                        styles.saveButton,
                        { backgroundColor: tintColor },
                        // 押せない状態であることが見た目でも分かるよう、無効時は半透明にする
                        { opacity: !newEntryDraft.trim() || isSavingNewEntry ? 0.5 : 1 },
                      ]}
                      onPress={handleSaveNewEntry}
                      disabled={!newEntryDraft.trim() || isSavingNewEntry}
                      accessibilityRole="button"
                      accessibilityLabel="保存"
                      accessibilityState={{ disabled: !newEntryDraft.trim() || isSavingNewEntry }}
                    >
                      <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                        保存
                      </ThemedText>
                    </Pressable>
                  </View>
                  {newEntryError ? (
                    <ThemedText style={[styles.errorText, { color: errorColor }]}>
                      {newEntryError}
                    </ThemedText>
                  ) : null}
                </ThemedView>
              </Animated.View>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>

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
                style={[styles.modalContent, { borderColor: iconColor }]}
                // オーバーレイ側のPressableへタップイベントが伝播して意図せず閉じてしまわないよう、
                // modalContent内でのタッチ開始をこのViewがレスポンダーとして引き受け、伝播を止める
                onStartShouldSetResponder={() => true}
              >
                <View style={styles.modalHeader}>
                  <ThemedText type="subtitle">年月を選択</ThemedText>
                  <Pressable onPress={handleCloseMonthPicker}>
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
                <View style={styles.monthGrid}>
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
                </View>
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
  // 背景タップでキーボードを閉じるためのPressableラッパー。従来containerに指定していた
  // gapは、ラッパーの追加によりtitle/composer/検索欄/カレンダー等の直接の親がこちらに
  // 変わったため、レイアウトを崩さないようこちらへ移動している
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
    // 3列×4行で12ヶ月分を均等に並べる(gap込みで4等分すると幅がはみ出すため、
    // gap分の余白を差し引いてから3等分している)
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
    // ThemedTextのdefaultスタイル(lineHeight: 24)を引き継ぐと丸の中で数字が下寄りになるため、
    // fontSizeに近い値を明示して縦方向も中央に揃える
    lineHeight: 11,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // 背景の暗さのみを別レイヤーとして持つことで、Animatedによるopacityのフェードを
  // コンテンツ側のスライドから独立させる(詳細はuseModalSlideTransitionのコメント参照)
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
