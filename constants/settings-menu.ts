import type { Href } from 'expo-router';

/**
 * 設定画面のメニュー項目定義。
 * セクション・配列駆動の構成にすることで、将来的な通知設定(#92)などの
 * 追加項目をこのファイルに配列要素として足すだけで拡張できるようにしている。
 * (テーマ切替(#91)はボタン形式のインタラクティブなUIのため、この配列駆動の型定義には
 * 当てはまらず、`app/(tabs)/settings.tsx`に直接JSXで実装している)
 */

// 外部ブラウザ(アプリ内ブラウザ)で開くリンク項目
type ExternalLinkItem = {
  key: string;
  label: string;
  type: 'external';
  href: `${string}:${string}`;
};

// アプリ内の別画面へ遷移するリンク項目
type InternalLinkItem = {
  key: string;
  label: string;
  type: 'internal';
  href: Href;
};

// メールクライアントを開くリンク項目
type MailtoLinkItem = {
  key: string;
  label: string;
  type: 'mailto';
  href: `mailto:${string}`;
};

export type SettingsMenuItem = ExternalLinkItem | InternalLinkItem | MailtoLinkItem;

export type SettingsSection = {
  key: string;
  title: string;
  items: SettingsMenuItem[];
};

// TODO: Issue #100でプライバシーポリシー・利用規約の公開URLが確定次第、
// 以下のプレースホルダーURLを実際のHTTPS URLに差し替える
// (GitHub Free + privateリポジトリのためGitHub Pagesが使えず、公開URL未確定)
const PRIVACY_POLICY_URL = 'https://example.com/legal/privacy-policy';
const TERMS_OF_SERVICE_URL = 'https://example.com/legal/terms-of-service';

// TODO: 実際の問い合わせ用連絡先メールアドレスが確定次第差し替える
// (docs/legal/privacy-policy.md, docs/legal/terms-of-service.md と同じプレースホルダーを使用)
const CONTACT_EMAIL = 'xxxx@yyy.zz';

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'legal',
    title: '法的情報',
    items: [
      {
        key: 'privacy-policy',
        label: 'プライバシーポリシー',
        type: 'external',
        href: PRIVACY_POLICY_URL,
      },
      {
        key: 'terms-of-service',
        label: '利用規約',
        type: 'external',
        href: TERMS_OF_SERVICE_URL,
      },
      {
        key: 'oss-licenses',
        label: 'OSSライセンス',
        type: 'internal',
        href: '/oss-licenses',
      },
    ],
  },
  {
    key: 'support',
    title: 'サポート',
    items: [
      {
        key: 'contact',
        label: 'お問い合わせ',
        type: 'mailto',
        href: `mailto:${CONTACT_EMAIL}`,
      },
    ],
  },
  // 将来的に通知設定(#92)のセクションをここに追加する想定
];
