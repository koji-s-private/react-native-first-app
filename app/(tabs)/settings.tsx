import { Link } from 'expo-router';
import { StyleSheet } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { SETTINGS_SECTIONS, type SettingsMenuItem } from '@/constants/settings-menu';

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
});
