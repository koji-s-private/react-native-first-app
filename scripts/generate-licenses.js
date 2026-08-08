#!/usr/bin/env node

/**
 * OSSライセンス一覧生成スクリプト
 *
 * package.json の "dependencies"(本番で実際にアプリに同梱されるライブラリ)を対象に、
 * それぞれの node_modules/<package>/package.json からライブラリ名・バージョン・ライセンス種別・
 * リポジトリURLを収集し、静的なJSONファイル(data/licenses.json)として書き出す。
 *
 * license-checker等の外部ツールに頼らず、npm自体が持つ情報(node_modules配下のpackage.json)だけを
 * 読み取るシンプルな実装にすることで、依存関係の追加やツールのバージョン変動に左右されにくくしている。
 *
 * 実行方法: npm run generate-licenses
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const rootPackageJsonPath = path.join(rootDir, 'package.json');
const outputPath = path.join(rootDir, 'data', 'licenses.json');

/** package.jsonの"repository"フィールド(文字列 or オブジェクト)からURLを取り出す */
function extractRepositoryUrl(repository) {
  if (!repository) return undefined;
  const url = typeof repository === 'string' ? repository : repository.url;
  if (!url) return undefined;
  // "git+https://..." や "git://..." 形式をブラウザで開けるhttps URLに正規化する
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

/** package.jsonの"license"/"licenses"フィールド(表記揺れがある)からライセンス名の文字列を取り出す */
function extractLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses.map((license) => license.type || license).join(' OR ');
  }
  return 'UNKNOWN';
}

function main() {
  const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf-8'));
  const dependencyNames = Object.keys(rootPackageJson.dependencies || {}).sort((a, b) =>
    a.localeCompare(b),
  );

  const licenses = dependencyNames.map((name) => {
    const packageJsonPath = path.join(rootDir, 'node_modules', name, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    return {
      name,
      version: pkg.version || rootPackageJson.dependencies[name],
      license: extractLicense(pkg),
      repository: extractRepositoryUrl(pkg.repository),
    };
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`);

  console.log(
    `Generated ${licenses.length} license entries -> ${path.relative(rootDir, outputPath)}`,
  );
}

main();
