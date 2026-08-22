#!/usr/bin/env node

/**
 * OSSライセンス一覧生成スクリプト
 *
 * package-lock.json(lockfileVersion 3)の "packages" フィールドを対象に、実際に
 * インストールされる全パッケージ(直接依存だけでなく、依存の依存であるtransitive依存も含む)
 * のうち、devDependencies経由でのみ必要なもの(`dev: true`。本番ビルドには同梱されない)を
 * 除いたものを収集し、それぞれの <パッケージパス>/package.json からライブラリ名・バージョン・
 * ライセンス種別・リポジトリURLを抽出して、静的なJSONファイル(data/licenses.json)として書き出す。
 *
 * 当初(Issue #101 / PR #115)はpackage.jsonの直接依存のみを対象にしていたが、実際にバンドルへ
 * 含まれるtransitive依存が抜け落ちておりストア審査対応として不完全だった(Issue #117)。
 * license-checker-rseidelsohn等の外部ツールでの自動収集も試みたが、このリポジトリのnode_modules
 * 構成では正しく動作しなかったため、npm自体が生成するpackage-lock.jsonの情報だけを読み取る
 * シンプルな実装で代替している。依存関係の追加やツールのバージョン変動に左右されにくい利点もある。
 *
 * 実行方法: npm run generate-licenses
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const packageLockPath = path.join(rootDir, 'package-lock.json');
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

/**
 * package-lock.jsonの"packages"のキー(例: "node_modules/foo/node_modules/@scope/bar")から
 * パッケージ名を推測する。ネストしたnode_modules配下でも、最後の"node_modules/"以降が
 * そのパッケージ自身のパスになる。
 */
function inferPackageNameFromKey(key) {
  const segments = key.split('node_modules/');
  return segments[segments.length - 1];
}

function main() {
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf-8'));
  const packageEntries = Object.entries(packageLock.packages || {});

  // ルート自身("")と、devDependencies経由でのみ必要なパッケージ(本番ビルドに含まれない)を除外する
  const productionEntries = packageEntries.filter(([key, entry]) => key !== '' && !entry.dev);

  // ネストしたnode_modulesによる重複(同一name+versionの組み合わせ)を除いた上で収集する
  const licenseByKey = new Map();

  for (const [key] of productionEntries) {
    const packageJsonPath = path.join(rootDir, key, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const name = pkg.name || inferPackageNameFromKey(key);
    const version = pkg.version;
    const dedupeKey = `${name}@${version}`;

    if (licenseByKey.has(dedupeKey)) continue;

    licenseByKey.set(dedupeKey, {
      name,
      version,
      license: extractLicense(pkg),
      repository: extractRepositoryUrl(pkg.repository),
    });
  }

  const licenses = Array.from(licenseByKey.values()).sort((a, b) => {
    const nameOrder = a.name.localeCompare(b.name);
    if (nameOrder !== 0) return nameOrder;
    return a.version.localeCompare(b.version);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`);

  console.log(
    `Generated ${licenses.length} license entries -> ${path.relative(rootDir, outputPath)}`,
  );
}

main();
