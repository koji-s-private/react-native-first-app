// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  // Prettierと競合するスタイル系ルールを無効化する(必ず最後に置く)
  prettierConfig,
  {
    ignores: ['dist/*'],
  },
]);
