import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  {
    ignores: ['node_modules/**', '../server/static/**', 'auto-imports.d.ts', 'components.d.ts'],
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      // 面板/卡片组件把组合式 store（ref 集合）作为 prop 接收，v-model 改写
      // store 内部状态是本项目的既定模式（共享可变状态），非单向数据流误用。
      'vue/no-mutating-props': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
)
