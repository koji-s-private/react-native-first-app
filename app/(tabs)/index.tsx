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

// 保存前の下書きを自動保存するAsyncStorageキー(保存済みエントリの個別キーとは別。utils/diary-storage.ts参照)
const DIARY_DRAFT_STORAGE_KEY = 'diary-draft';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

// カレンダーの日付セルに表示するタイトルの最大文字数(超える場合は省略記号を付ける)
const TITLE_MAX_LENGTH = 20;

const SAVE_SUCCESS_MESSAGE = '保存しました';

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

// 日記本文の最初の行から、カレンダーセル表示用の短いタイトルを作る。
// 文字数のカウント・切り詰めは書記素クラスタ単位で行い、絵文字等が途中で分断されないようにする
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
// getEntryTitleと異なりgrapheme単位までは厳密にせず、多少のズレは許容する単純な文字列操作で行う
function getSearchExcerpt(text: string, query: string): SearchExcerpt {
  const normalizedText = text.replace(/\n+/g, ' ');
  const {
    normalized: lowerText,
    startMap,
    endMap,
  } = normalizeForSearch(normalizedText.toLowerCase());
  const lowerQuery = normalizeForSearch(query.toLowerCase()).normalized;
  const matchIndex = lowerText.indexOf(lowerQuery);

  // 通常は到達しないが、念のためのフォールバック(ハイライト対象なしのためmatchは空文字列)
  if (matchIndex === -1 || lowerQuery.length === 0) {
    return { prefix: getEntryTitle(normalizedText), match: '', suffix: '' };
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

// モーダルのフェード・スライドアニメーション時間(ミリ秒)。2箇所のモーダル(新規作成・年月ピッカー)で
// 共通定数として使う(日付一覧・編集は専用画面への遷移(Issue #221)に置き換えたため対象外)
const MODAL_ANIMATION_DURATION_MS = 220;

// コンテンツのスライドイン開始位置。modalContentの実際の高さによらず画面外からスライドさせるため、
// 画面全体の高さを使う
const MODAL_SLIDE_DISTANCE = Dimensions.get('window').height;

// 背景オーバーレイのフェードとコンテンツのスライドを分離アニメーションさせるフック
// (`Modal`のanimationTypeは'none'にし、返り値のAnimated.Valueを呼び出し側でstyleに適用する)。
// `isOpen`がfalseになった瞬間に`visible`もfalseにすると退場アニメーションが再生されないため、
// 実際に描画するかどうかを表す`isMounted`を別stateで持ち、退場アニメーション完了後にfalseへ戻す
function useModalSlideTransition(isOpen: boolean) {
  const [isMounted, setIsMounted] = useState(isOpen);
  const overlayOpacity = useRef(new Animated.Value(isOpen ? 1 : 0)).current;
  const contentTranslateY = useRef(new Animated.Value(isOpen ? 0 : MODAL_SLIDE_DISTANCE)).current;

  useEffect(() => {
    if (isOpen) {
      // 入場アニメーション再生前に描画状態にする(退場時は完了後にfalseへ戻す)
      setIsMounted(true);
    }
    // opacity/transformはuseNativeDriver対象にでき、UIスレッド側で進行するためJSスレッド混雑の影響を受けにくい
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
      // 中断された場合はfinished===falseになるため、後から開始した最新のアニメーション側に任せる
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
  // 初回のloadEntries完了までtrueの読み込み中フラグ。useFocusEffectで再フォーカス時にも
  // loadEntriesは呼ばれるが、都度trueに戻すとローディング表示がちらつくため一方向にのみ遷移させる
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState('');
  // 下書き復元が完了したか。完了前に自動保存effectを動かすと、初期値(空文字列)で
  // 保存済みの下書きを誤って上書き・削除してしまうため、完了までは自動保存の対象外にする
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 保存成功時に一時的に表示するトーストのメッセージ。nullの間は非表示
  const [saveToastMessage, setSaveToastMessage] = useState<string | null>(null);
  // 日記本文のキーワード検索用の入力値(composerの入力とは独立したstate)
  const [searchQuery, setSearchQuery] = useState('');
  // handleSaveの実行中かどうか。連打による重複保存を防ぐため、実行中は早期returnしボタンもdisabledにする
  const [isSaving, setIsSaving] = useState(false);
  // 新規作成モーダルの対象日付('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [newEntryDate, setNewEntryDate] = useState<string | null>(null);
  const [newEntryDraft, setNewEntryDraft] = useState('');
  const [newEntryError, setNewEntryError] = useState<string | null>(null);
  // handleSaveNewEntryの実行中かどうか。isSavingと同様に連打による重複保存を防ぐ
  const [isSavingNewEntry, setIsSavingNewEntry] = useState(false);
  // handleSaveの保存処理中にユーザーがdraftを編集したかどうかを表すref。空文字列という値だけでは
  // 「pending開始時のまま」なのか「入力後に全部消した」のかを区別できないため別途持つ
  const draftEditedRef = useRef(false);
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

  // 新規作成・年月ピッカー、それぞれのモーダルのアニメーション制御(詳細はuseModalSlideTransitionを参照)
  const newEntryModalTransition = useModalSlideTransition(newEntryDate !== null);
  const monthPickerTransition = useModalSlideTransition(isMonthPickerVisible);

  const router = useRouter();
  const { colorScheme } = useThemePreference();
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');
  const searchHighlightBackgroundColor = useThemeColor({}, 'searchHighlightBackground');

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
    // ここで個別にtry/catchする必要はない
    setEntries(await getAllDiaryEntries());
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
  useEffect(() => {
    let isCancelled = false;
    (async () => {
      try {
        const storedDraft = await AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY);
        if (!isCancelled && storedDraft) {
          setDraft(storedDraft);
        }
      } catch {
        // 復元を諦めるだけにとどめる。finallyでisDraftRestoredをtrueにするため、
        // 以降の自動保存が無効化されたままにはならない
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

  // draftの変更をデバウンスし、入力が止まってからAsyncStorageへ自動保存する
  useEffect(() => {
    // 復元完了前は、初期値(空文字列)で保存済みの下書きを上書きしないよう何もしない
    if (!isDraftRestored) {
      return;
    }
    const timer = setTimeout(() => {
      const persist = draft
        ? AsyncStorage.setItem(DIARY_DRAFT_STORAGE_KEY, draft)
        : AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      // 下書きの自動保存は補助的な処理のため、失敗しても静かに無視する(本保存の失敗はhandleSave側で伝える)
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
    // 万が一上限超のテキストが渡っても保存しない。チェックもgrapheme単位で行い、
    // UTF-16コードユニット単位のlengthとのズレを防ぐ
    if (!trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
      return;
    }

    setIsSaving(true);

    const newEntry: DiaryEntry = {
      // Date.now().toString()は同一ミリ秒での衝突リスクがあるため、UUID v4を生成するrandomUUID()を使う
      id: randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const previousEntries = entries;
    const previousDraft = draft;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    setEntries([newEntry, ...entries]);
    setDraft('');
    draftEditedRef.current = false;
    setSaveError(null);

    try {
      // 本文はSecureStoreで保護した鍵でAES-256-GCM暗号化して保存する。他の保存処理と競合しないよう
      // 書き込みはキュー経由で直列化する
      await enqueueDiaryWrite(newEntry);
      // 楽観的更新で既にstateは正しいため、永続化後の再同期(setEntries)は不要

      // 保存成功時は自動保存済みの下書きキーも削除する。残したままだと次回起動時に
      // 既に保存済みの内容を誤って復元してしまう
      try {
        await AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      } catch {
        // 下書きキーのクリアに失敗しても、日記本体は既に保存済みで致命的ではないため無視する
      }

      // 保存成功をユーザーに明示するため、トーストとハプティックフィードバックを発火する
      setSaveToastMessage(SAVE_SUCCESS_MESSAGE);
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      // 永続化失敗時は保存前の状態に戻す。ただしdraftEditedRefで編集操作の有無を判定し、
      // 保存処理中にユーザーが既に入力していた場合はpreviousDraftで上書きしない
      setEntries(previousEntries);
      if (!draftEditedRef.current) {
        setDraft(previousDraft);
      }
      setSaveError('保存に失敗しました。もう一度お試しください。');
    } finally {
      setIsSaving(false);
    }
  }, [draft, entries, isSaving, enqueueDiaryWrite]);

  // draft用TextInputのonChangeText。draftEditedRefへ編集済みを記録し(handleSaveのロールバック判定に使う)、
  // maxLength未指定のためtruncateToBodyMaxLengthでgrapheme単位に切り詰める
  const handleChangeDraft = useCallback((text: string) => {
    draftEditedRef.current = true;
    setDraft(truncateToBodyMaxLength(text));
  }, []);

  // 新規作成用TextInputのonChangeText。draft用と同様にgrapheme単位で切り詰める
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

  // 日記の無い日をタップして開いたモーダルからの新規保存。handleSaveと異なり、
  // createdAtはその瞬間ではなく選択された日付基準(buildCreatedAtForDateKey)にする
  const handleSaveNewEntry = useCallback(async () => {
    // 既に保存処理が進行中であれば、連打による重複保存を防ぐため何もしない
    if (isSavingNewEntry || !newEntryDate) {
      return;
    }

    const trimmed = newEntryDraft.trim();
    // 万が一上限超のテキストが渡っても保存しない。チェックもgrapheme単位で行い、
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
      // 他の保存処理と競合しないよう、書き込みはキュー経由で直列化する
      await enqueueDiaryWrite(newEntry);
      // 楽観的更新で既にstateは正しいため、永続化後の再同期は不要。成功時のみモーダルを閉じる
      setNewEntryDate(null);
      setNewEntryDraft('');
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、モーダルは開いたままエラーを伝える
      setEntries(previousEntries);
      setNewEntryError('保存に失敗しました。もう一度お試しください。');
    } finally {
      setIsSavingNewEntry(false);
    }
  }, [entries, enqueueDiaryWrite, isSavingNewEntry, newEntryDate, newEntryDraft]);

  // トーストを非表示にする。SaveToastのuseEffect依存配列に含まれるため、参照を安定させないと
  // 再レンダーのたびにタイマーが張り直され、トーストが仕様通りの時間で消えなくなる
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

  const handleDayPress = useCallback(
    (date: DateData) => {
      if (entriesByDate[date.dateString]?.length) {
        // 日付タップ時は専用の一覧画面へ遷移する(以前はモーダル表示だったが#221で置き換えた)
        router.push(`/day-entries/${date.dateString}`);
        return;
      }
      // 日記の無い日は、未来日でなければ新規作成モーダルを開く。未来日はmaxDateで既に
      // 押せなくなっている(renderDay参照)が、念のため二重にチェックする
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
          onPress={() => onPress?.(date)}
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
              ) : entries.length === 0 ? (
                // 日記が1件も無い場合、案内メッセージを表示する(カレンダー自体は書く導線として表示し続ける)
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
          {/* Modalは親のKeyboardAvoidingViewの効果を受けないため、モーダル内にも別途配置する */}
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
                {/* オーバーレイ側へのタップ伝播で意図せず閉じないよう、modalContentをPressableで包んで止める。
                    react-native-webのPressableはクリックイベント判定のためonStartShouldSetResponderでは
                    効果が無く(#249)、Pressableのクリックハンドラは内部でstopPropagationするためこの包み方で防げる */}
                <Pressable onPress={() => {}}>
                  <ThemedView style={[styles.modalContent, { borderColor: iconColor }]}>
                    <View style={styles.modalHeader}>
                      <ThemedText type="subtitle">
                        {newEntryDate ? formatDateHeading(newEntryDate) : ''}の日記を書く
                      </ThemedText>
                      <Pressable
                        onPress={handleCancelNewEntry}
                        accessibilityRole="button"
                        accessibilityLabel="閉じる"
                      >
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
                </Pressable>
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
    // 残りスペースをすべて使い切る外枠。日付グリッドの高さ計算もこの実測高さを基準にし、
    // 外枠と内部の基準がズレて中身がはみ出さないようにする
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
