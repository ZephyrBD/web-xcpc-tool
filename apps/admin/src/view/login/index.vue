<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError } from '@/api'
import { useSessionStore } from '@/store/session'
defineOptions({ name: 'Login' })

const session = useSessionStore()
const router = useRouter()
const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return '用户名或密码不对，再试一次？'
    if (err.status === 429) return '尝试太频繁了，请歇几分钟再来。'
    return '登录出了点问题，请稍后再试。'
  }
  return '登录出了点问题，请稍后再试。'
}

async function onSubmit() {
  loading.value = true
  error.value = ''
  try {
    await session.login(username.value, password.value)
    await router.push('/')
  } catch (err) {
    error.value = friendlyError(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login_page">
    <div class="login_card">
      <h1 class="login_title">Web XCPC Tool 管理台</h1>
      <p class="login_subtitle">登录后继续操作</p>
      <form class="login_form" @submit.prevent="onSubmit">
        <label class="login_field">
          <span class="login_label">用户名</span>
          <input v-model="username" name="username" autocomplete="username" />
        </label>
        <label class="login_field">
          <span class="login_label">密码</span>
          <input v-model="password" name="password" type="password" autocomplete="current-password" />
        </label>
        <p v-if="error" class="login_error" role="alert">{{ error }}</p>
        <button class="login_submit" type="submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
.login_page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg-alt);
}

.login_card {
  width: 360px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  padding: 40px 36px;
}

.login_title {
  font-family: var(--font-heading);
  font-size: var(--text-24);
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
}

.login_subtitle {
  color: var(--text-muted);
  font-size: var(--text-15);
  margin: 8px 0 24px;
}

.login_form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login_field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login_label {
  font-size: var(--text-13);
  color: var(--text-muted);
}

.login_field input {
  font-size: var(--text-15);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.login_field input:focus {
  border-color: var(--brand-purple);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-purple) 35%, transparent);
}

.login_error {
  margin: 0;
  font-size: var(--text-13);
  color: var(--brand-red);
}

.login_submit {
  margin-top: 8px;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--brand-purple);
  color: var(--text-on-accent);
  font-size: var(--text-15);
  font-weight: 500;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.login_submit:hover:not(:disabled) {
  filter: brightness(1.08);
}

.login_submit:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
