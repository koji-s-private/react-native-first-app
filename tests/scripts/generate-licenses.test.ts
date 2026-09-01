import path from 'path';

// `scripts/generate-licenses.js` はrequireされた時点で `main()` を即実行し、`fs` を直接
// 読み書きするNode.jsスクリプト(exportを持たない)。実際のディスクを使わずロジックだけを
// 検証するため、`fs` をこのテスト内だけの仮想ファイルシステムに差し替える。
jest.mock('fs');

type FakePackageJson = {
  name?: string;
  version: string;
  license?: string | { type: string };
  licenses?: ({ type: string } | string)[];
  repository?: string | { url?: string };
};

// package-lock.jsonの"packages"エントリ。Issue #235以降、本番/開発の判定には`dependencies`
// フィールド(本番依存のみ辿る)を使うため、フィクスチャでは`dev`フラグではなくこちらを使う。
type FakeLockEntry = {
  dependencies?: Record<string, string>;
  // ルート(packages[""])のみが持つ本番以外の依存宣言。新ロジックでは辿らないため、フィクスチャ上は
  // 「本番dependenciesからは辿れない」ことを明示する目的でのみ使う(型上はどのエントリにも許容する)。
  devDependencies?: Record<string, string>;
};

// scripts/generate-licenses.js の rootDir(= path.join(__dirname, '..'))と同じ値になるよう、
// このテストファイルの位置(tests/scripts)から2階層上ってリポジトリルートを求める。
const rootDir = path.join(__dirname, '..', '..');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const outputPath = path.join(rootDir, 'data', 'licenses.json');

/**
 * `fs` モックの状態(package-lock.jsonの中身・各パッケージのpackage.json・書き込み結果)を
 * まとめて管理するヘルパー。テストケースごとに `setup()` で初期化する。
 */
function setupFakeFileSystem(params: {
  lockPackages: Record<string, FakeLockEntry>;
  packageJsonByKey: Record<string, FakePackageJson>;
}) {
  const { lockPackages, packageJsonByKey } = params;

  // `jest.resetModules()`は`fs`の自動モックインスタンスも含めてモジュールレジストリを
  // 丸ごと作り直してしまうため、このリセットは必ずモック関数を設定する前に行う
  // (後で行うと、ここで設定したreadFileSync等の実装が失われ、`main()`実行時に
  // 素の自動モック(何もしないダミー関数)へ差し戻ってしまう)。
  jest.resetModules();

  const packageJsonFiles = new Map<string, string>();
  for (const [key, pkg] of Object.entries(packageJsonByKey)) {
    const filePath = path.join(rootDir, key, 'package.json');
    packageJsonFiles.set(filePath, JSON.stringify(pkg));
  }

  const writeFileSyncMock = jest.fn();
  const mkdirSyncMock = jest.fn();

  const fs = jest.requireMock<typeof import('fs')>('fs');
  fs.existsSync = jest.fn((target: unknown) => {
    if (target === packageLockPath) return true;
    return packageJsonFiles.has(target as string);
  }) as unknown as typeof fs.existsSync;
  fs.readFileSync = jest.fn((target: unknown) => {
    if (target === packageLockPath) {
      return JSON.stringify({ packages: lockPackages });
    }
    const content = packageJsonFiles.get(target as string);
    if (content === undefined) {
      throw new Error(`unexpected readFileSync call: ${String(target)}`);
    }
    return content;
  }) as unknown as typeof fs.readFileSync;
  fs.writeFileSync = writeFileSyncMock as unknown as typeof fs.writeFileSync;
  fs.mkdirSync = mkdirSyncMock as unknown as typeof fs.mkdirSync;

  return { writeFileSyncMock, mkdirSyncMock };
}

/**
 * `main()`を実行させるためスクリプトを読み込む。
 * `setupFakeFileSystem()`が直前に構成した`fs`モックと同じモジュールレジストリを
 * 使う必要があるため、ここでは`resetModules()`を呼ばない。
 */
function runScript() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/scripts/generate-licenses');
}

/** `fs.writeFileSync` に渡された内容(data/licenses.json相当)をパースして取り出す */
function getWrittenLicenses(writeFileSyncMock: jest.Mock) {
  expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  const [calledPath, calledContent] = writeFileSyncMock.mock.calls[0];
  expect(calledPath).toBe(outputPath);
  return JSON.parse(calledContent as string);
}

describe('scripts/generate-licenses.js', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('includes packages reachable from the root production dependencies, including transitive ones', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'prod-lib': '1.0.0' } },
        'node_modules/prod-lib': { dependencies: { 'prod-lib-transitive': '1.0.0' } },
        'node_modules/prod-lib-transitive': {},
      },
      packageJsonByKey: {
        'node_modules/prod-lib': { name: 'prod-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/prod-lib-transitive': {
          name: 'prod-lib-transitive',
          version: '1.0.0',
          license: 'MIT',
        },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name).sort()).toEqual([
      'prod-lib',
      'prod-lib-transitive',
    ]);
  });

  it('excludes packages that are only reachable via root devDependencies (not listed in root dependencies)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {
          dependencies: { 'prod-lib': '1.0.0' },
          devDependencies: { 'only-dev-lib': '1.0.0' },
        },
        'node_modules/prod-lib': {},
        'node_modules/only-dev-lib': { dependencies: { 'only-dev-lib-transitive': '1.0.0' } },
        'node_modules/only-dev-lib-transitive': {},
      },
      packageJsonByKey: {
        'node_modules/prod-lib': { name: 'prod-lib', version: '1.0.0', license: 'MIT' },
        // 'only-dev-lib' / 'only-dev-lib-transitive' はpackage.jsonを読みに行かないはずなので、
        // あえて登録しない(もし読みに行ってしまう実装ならreadFileSyncのモックがエラーを投げて検知できる)。
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name)).toEqual(['prod-lib']);
  });

  it('excludes a package reachable only via peerDependencies even when its "dev" flag would be absent/false (Issue #235 core case)', () => {
    // expo-router → @testing-library/react-native のようなpeerDependency経由の連鎖を模したケース。
    // 「dependencies」フィールドではなく「peerDependencies」でのみ辿れる場合、npm自体は`dev`を
    // 付与しないことがあるが、新ロジックでは`dependencies`しか辿らないため正しく除外される。
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'prod-router-like': '1.0.0' } },
        'node_modules/prod-router-like': {
          dependencies: { 'prod-lib': '1.0.0' },
        },
        'node_modules/prod-lib': {},
        // peerDependencies経由でのみ到達可能(dependenciesには含まれない)ため辿られない
        'node_modules/testing-lib-like': { dependencies: { 'react-test-renderer-like': '1.0.0' } },
        'node_modules/react-test-renderer-like': {},
      },
      packageJsonByKey: {
        'node_modules/prod-router-like': {
          name: 'prod-router-like',
          version: '1.0.0',
          license: 'MIT',
        },
        'node_modules/prod-lib': { name: 'prod-lib', version: '1.0.0', license: 'MIT' },
        // 'testing-lib-like' / 'react-test-renderer-like' はpeerDependency経由でのみ到達可能な
        // 想定のため、package.jsonを登録しない(読みに行けばエラーで検知できる)。
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name).sort()).toEqual([
      'prod-lib',
      'prod-router-like',
    ]);
  });

  it('resolves nested node_modules by walking up to parent directories (hoisting)', () => {
    // "prod-lib" は直接依存の"parent-lib"配下にネストされてインストールされている想定
    // (ホイスティングされずネストされたnode_modulesに配置されるケース)。
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'parent-lib': '1.0.0' } },
        'node_modules/parent-lib': { dependencies: { 'nested-lib': '2.0.0' } },
        'node_modules/parent-lib/node_modules/nested-lib': {},
        // ルート直下にも同名だが別バージョンの"nested-lib"が存在するが、ネストされた方が
        // 優先して解決されるべきケース
        'node_modules/nested-lib': {},
      },
      packageJsonByKey: {
        'node_modules/parent-lib': { name: 'parent-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/parent-lib/node_modules/nested-lib': {
          name: 'nested-lib',
          version: '2.0.0',
          license: 'MIT',
        },
        'node_modules/nested-lib': { name: 'nested-lib', version: '1.0.0', license: 'MIT' },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    const nestedLibVersions = licenses
      .filter((entry: { name: string }) => entry.name === 'nested-lib')
      .map((entry: { version: string }) => entry.version);
    // ホイスティング解決によりネストされた2.0.0のみが収集され、無関係な1.0.0は含まれない
    expect(nestedLibVersions).toEqual(['2.0.0']);
  });

  it('handles circular and diamond dependencies without infinite looping, collecting each package only once', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'a-lib': '1.0.0', 'b-lib': '1.0.0' } },
        // ダイヤモンド依存: a-lib, b-lib の両方から shared-lib に到達できる
        'node_modules/a-lib': { dependencies: { 'shared-lib': '1.0.0' } },
        'node_modules/b-lib': { dependencies: { 'shared-lib': '1.0.0' } },
        // 循環依存: shared-lib -> cyclic-lib -> shared-lib
        'node_modules/shared-lib': { dependencies: { 'cyclic-lib': '1.0.0' } },
        'node_modules/cyclic-lib': { dependencies: { 'shared-lib': '1.0.0' } },
      },
      packageJsonByKey: {
        'node_modules/a-lib': { name: 'a-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/b-lib': { name: 'b-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/shared-lib': { name: 'shared-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/cyclic-lib': { name: 'cyclic-lib', version: '1.0.0', license: 'MIT' },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name).sort()).toEqual([
      'a-lib',
      'b-lib',
      'cyclic-lib',
      'shared-lib',
    ]);
    // 各パッケージがちょうど1回だけ収集されていること(重複なし)
    expect(licenses).toHaveLength(4);
  });

  it('deduplicates entries that share the same name+version even if they appear at different nested node_modules paths', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'dup-lib': '1.0.0', 'some-lib': '1.0.0' } },
        'node_modules/dup-lib': {},
        'node_modules/some-lib': { dependencies: { 'dup-lib': '1.0.0' } },
        'node_modules/some-lib/node_modules/dup-lib': {},
      },
      packageJsonByKey: {
        'node_modules/dup-lib': { name: 'dup-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/some-lib': { name: 'some-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/some-lib/node_modules/dup-lib': {
          name: 'dup-lib',
          version: '1.0.0',
          license: 'MIT',
        },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    const dupLibEntries = licenses.filter(
      (entry: { name: string }) => entry.name === 'dup-lib',
    );
    expect(dupLibEntries).toHaveLength(1);
    expect(dupLibEntries[0]).toMatchObject({ name: 'dup-lib', version: '1.0.0' });
  });

  it('keeps entries with the same name but different versions as separate entries (not deduplicated)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'multi-version-lib': '2.0.0', 'some-lib': '1.0.0' } },
        'node_modules/multi-version-lib': {},
        'node_modules/some-lib': { dependencies: { 'multi-version-lib': '1.0.0' } },
        'node_modules/some-lib/node_modules/multi-version-lib': {},
      },
      packageJsonByKey: {
        'node_modules/multi-version-lib': {
          name: 'multi-version-lib',
          version: '2.0.0',
          license: 'MIT',
        },
        'node_modules/some-lib': { name: 'some-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/some-lib/node_modules/multi-version-lib': {
          name: 'multi-version-lib',
          version: '1.0.0',
          license: 'MIT',
        },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    const versions = licenses
      .filter((entry: { name: string }) => entry.name === 'multi-version-lib')
      .map((entry: { version: string }) => entry.version);
    expect(versions).toEqual(['1.0.0', '2.0.0']);
  });

  it('sorts the resulting entries by name, then by version', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { zeta: '1.0.0', alpha: '2.0.0', 'alpha-newer': '1.0.0' } },
        'node_modules/zeta': {},
        'node_modules/alpha': {},
        'node_modules/alpha-newer': {},
      },
      packageJsonByKey: {
        'node_modules/zeta': { name: 'zeta', version: '1.0.0', license: 'MIT' },
        'node_modules/alpha': { name: 'alpha', version: '2.0.0', license: 'MIT' },
        'node_modules/alpha-newer': { name: 'alpha', version: '1.0.0', license: 'MIT' },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(
      licenses.map((entry: { name: string; version: string }) => `${entry.name}@${entry.version}`),
    ).toEqual(['alpha@1.0.0', 'alpha@2.0.0', 'zeta@1.0.0']);
  });

  it('skips entries whose package.json is missing on disk instead of throwing', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'present-lib': '1.0.0', 'ghost-lib': '1.0.0' } },
        'node_modules/present-lib': {},
        'node_modules/ghost-lib': {},
      },
      packageJsonByKey: {
        'node_modules/present-lib': { name: 'present-lib', version: '1.0.0', license: 'MIT' },
        // 'node_modules/ghost-lib' はpackage.jsonを用意しない = fs.existsSyncがfalseを返すケース
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name)).toEqual(['present-lib']);
  });

  it('excludes a package that is not reachable at all from the root, even without any dependencies field', () => {
    // ルートの"dependencies"に一切登場せず、他のどのパッケージからも辿れない孤立したエントリ
    // (未使用の古いエントリ等を模したケース)は、`dev`フラグの有無に関わらず除外される。
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': { dependencies: { 'prod-lib': '1.0.0' } },
        'node_modules/prod-lib': {},
        'node_modules/unreachable-lib': {},
      },
      packageJsonByKey: {
        'node_modules/prod-lib': { name: 'prod-lib', version: '1.0.0', license: 'MIT' },
        // 'unreachable-lib' はpackage.jsonを登録しない(読みに行けばエラーで検知できる)
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name)).toEqual(['prod-lib']);
  });

  it('normalizes license/repository field formats (object license, licenses array, git+ prefixed URL, .git suffix)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {
          dependencies: {
            'object-license-lib': '1.0.0',
            'licenses-array-lib': '1.0.0',
            'no-license-lib': '1.0.0',
          },
        },
        'node_modules/object-license-lib': {},
        'node_modules/licenses-array-lib': {},
        'node_modules/no-license-lib': {},
      },
      packageJsonByKey: {
        'node_modules/object-license-lib': {
          name: 'object-license-lib',
          version: '1.0.0',
          license: { type: 'Apache-2.0' },
          repository: { url: 'git+https://github.com/example/object-license-lib.git' },
        },
        'node_modules/licenses-array-lib': {
          name: 'licenses-array-lib',
          version: '1.0.0',
          licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
          repository: 'git://github.com/example/licenses-array-lib.git',
        },
        'node_modules/no-license-lib': {
          name: 'no-license-lib',
          version: '1.0.0',
        },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    const byName = Object.fromEntries(
      licenses.map((entry: { name: string }) => [entry.name, entry]),
    );

    expect(byName['object-license-lib']).toMatchObject({
      license: 'Apache-2.0',
      repository: 'https://github.com/example/object-license-lib',
    });
    expect(byName['licenses-array-lib']).toMatchObject({
      license: 'MIT OR Apache-2.0',
      repository: 'https://github.com/example/licenses-array-lib',
    });
    // license情報が全く無いパッケージは 'UNKNOWN' として扱われ、除外はされない
    expect(byName['no-license-lib']).toMatchObject({ license: 'UNKNOWN' });
    expect(byName['no-license-lib'].repository).toBeUndefined();
  });
});
