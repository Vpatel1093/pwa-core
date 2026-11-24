// ESLint (flat config). npm run lint runs it with ruff for the Python side
// (tools/pwacore/lint.mjs). Base: eslint's recommended set, plus rules that
// catch real bugs. Types are checked by tsc (npm run typecheck), not here.
// A disable comment carries a reason: // eslint-disable-next-line rule -- why
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'data/', '.local/'] },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
      'array-callback-return': 'error',
      'no-constructor-return': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-var': 'error',
      'prefer-const': 'error',
      // `_` is the name for a parameter that is not used, so nested callbacks may reuse it.
      'no-shadow': ['error', { builtinGlobals: false, allow: ['_'] }],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      radix: 'error',
    },
  },
  { files: ['app/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['app/sw.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['tools/**/*.mjs', 'test/**/*.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
];
