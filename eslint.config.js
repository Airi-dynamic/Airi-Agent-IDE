import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // 忽略构建产物和第三方代码
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '*.config.*'],
  },

  // 基础 JS 推荐规则
  js.configs.recommended,

  // TypeScript 推荐规则（含类型检查）
  ...tseslint.configs.recommended,

  // React 规则
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // React
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // React 17+ 不需要显式引入
      'react/prop-types': 'off',         // TypeScript 已覆盖类型检查

      // TypeScript
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',

      // 通用
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
    },
  },

  // Electron 主进程规则（node 环境，放宽 console）
  {
    files: ['electron/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // 最后覆盖：禁用所有与 Prettier 冲突的 ESLint 格式规则
  prettier
)
