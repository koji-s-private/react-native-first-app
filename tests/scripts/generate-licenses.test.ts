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

type FakeLockEntry = {
  dev?: boolean;
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

  it('excludes packages that are only required by devDependencies (dev: true)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {},
        'node_modules/prod-lib': {},
        'node_modules/only-dev-lib': { dev: true },
      },
      packageJsonByKey: {
        'node_modules/prod-lib': { name: 'prod-lib', version: '1.0.0', license: 'MIT' },
        // dev:true のエントリはpackage.jsonを読みに行かないはずなので、あえて登録しない
        // (もし読みに行ってしまう実装ならreadFileSyncのモックがエラーを投げて検知できる)。
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses.map((entry: { name: string }) => entry.name)).toEqual(['prod-lib']);
  });

  it('deduplicates entries that share the same name+version even if they appear at different nested node_modules paths', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {},
        'node_modules/dup-lib': {},
        'node_modules/some-lib/node_modules/dup-lib': {},
      },
      packageJsonByKey: {
        'node_modules/dup-lib': { name: 'dup-lib', version: '1.0.0', license: 'MIT' },
        'node_modules/some-lib/node_modules/dup-lib': {
          name: 'dup-lib',
          version: '1.0.0',
          license: 'MIT',
        },
      },
    });

    runScript();

    const licenses = getWrittenLicenses(writeFileSyncMock);
    expect(licenses).toHaveLength(1);
    expect(licenses[0]).toMatchObject({ name: 'dup-lib', version: '1.0.0' });
  });

  it('keeps entries with the same name but different versions as separate entries (not deduplicated)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {},
        'node_modules/multi-version-lib': {},
        'node_modules/some-lib/node_modules/multi-version-lib': {},
      },
      packageJsonByKey: {
        'node_modules/multi-version-lib': {
          name: 'multi-version-lib',
          version: '2.0.0',
          license: 'MIT',
        },
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
        '': {},
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
        '': {},
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

  it('normalizes license/repository field formats (object license, licenses array, git+ prefixed URL, .git suffix)', () => {
    const { writeFileSyncMock } = setupFakeFileSystem({
      lockPackages: {
        '': {},
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
