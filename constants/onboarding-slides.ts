/** 初回起動時のオンボーディングで案内するスライドの定義。 */
export type OnboardingSlide = {
  key: string;
  title: string;
  description: string;
};

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    key: 'write-diary',
    title: '日記を書く',
    description:
      'ホーム画面の入力欄に、今日の出来事や気持ちを書いて「保存」を押すだけで日記が記録されます。',
  },
  {
    key: 'view-calendar',
    title: 'カレンダーで一覧を見る',
    description:
      '日記を書いた日はカレンダーにタイトルが表示されます。日付をタップすると、その日に書いた日記をまとめて確認できます。',
  },
  {
    key: 'settings',
    title: '設定でデータを管理',
    description:
      '「設定」タブから、保存した日記データの全件削除やプライバシーポリシーの確認などができます。',
  },
];
