// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  // Prettierと競合するスタイル系ルールを無効化する(必ず最後に置く)
  prettierConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // scripts/配下はNode.js(CommonJS)で実行するスクリプトのため、__dirnameやrequire等の
    // Node.jsグローバルを許可する(将来scripts/がlint対象に含まれた場合の誤検知を防ぐ)
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // jest.setup.jsはJest実行時に読み込まれるため、jest等のJestグローバルを許可する
    files: ['jest.setup.js'],
    languageOptions: {
      globals: globals.jest,
    },
  },
]);
