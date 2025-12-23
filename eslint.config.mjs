import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  formatters: true,
  stylistic: {
    indent: 2,
    semi: false,
    quotes: 'single',
    overrides: {
      'no-multiple-empty-lines': ['error', {
        max: 1,
      }],
    },
  },
  vue: {
    overrides: {
      'vue/block-order': ['error', {
        order: ['template', 'script', 'style'],
      }],
    },
  },
  ignores: [
    'dist/**',
    'node_modules/**',
    'public/**',
    'index.html',
    '.vscode/**',
    '.devcontainer/**',
    '.github/**',
    '**/*.md',
  ],
}, {
  rules: {
    'no-console': ['warn'],
    'antfu/no-top-level-await': ['off'],
    'node/prefer-global/process': ['off'],
    'node/no-process-env': ['error'],
    'unicorn/prefer-node-protocol': ['off'],
    'perfectionist/sort-imports': ['error', {
      tsconfigRootDir: '.',
    }],
    'eslint-comments/no-unlimited-disable': ['off'],
    'no-restricted-syntax': ['off', {
      selector: 'TSEnumDeclaration[const=true]',
    }],
  },
})
