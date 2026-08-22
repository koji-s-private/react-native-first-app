import { FlatList, StyleSheet } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import licenses from '@/data/licenses.json';

type LicenseEntry = {
  name: string;
  version: string;
  license: string;
  repository?: string;
};

// data/licenses.json は `npm run generate-licenses` で package-lock.json から自動生成される静的ファイル
// (直接依存だけでなくtransitive依存も含む)。
// 依存関係を追加・更新した際は、このコマンドを再実行して最新の内容にしてから差分をコミットする。
const licenseEntries = licenses as LicenseEntry[];

export default function OssLicensesScreen() {
  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={licenseEntries}
        keyExtractor={(item) => `${item.name}@${item.version}`}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <ThemedText style={styles.description}>
            このアプリは以下のオープンソースソフトウェア(OSS)を利用しています。
          </ThemedText>
        }
        renderItem={({ item }) => (
          <ThemedView style={styles.item}>
            <ThemedText type="defaultSemiBold">{item.name}</ThemedText>
            <ThemedText style={styles.meta}>
              v{item.version} ・ {item.license}
            </ThemedText>
            {item.repository ? (
              <ExternalLink href={item.repository as `${string}:${string}`}>
                <ThemedText type="link" style={styles.link}>
                  {item.repository}
                </ThemedText>
              </ExternalLink>
            ) : null}
          </ThemedView>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
  },
  description: {
    marginBottom: 16,
  },
  item: {
    marginBottom: 20,
  },
  meta: {
    marginTop: 2,
    opacity: 0.7,
  },
  link: {
    marginTop: 2,
    fontSize: 14,
  },
});
