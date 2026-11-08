<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import { useRouter } from 'vue-router'
import { ref } from 'vue'

const session = useSessionStore()
const router = useRouter()
const username = ref('')
const password = ref('')
const loading = ref(false)

async function onSubmit() {
  loading.value = true
  try {
    await session.login(username.value, password.value)
    router.push('/')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card">
      <template #header>登录</template>
      <el-form @submit.prevent="onSubmit">
        <el-form-item label="用户名">
          <el-input v-model="username" name="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" name="password" show-password />
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading">登录</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  justify-content: center;
  padding-top: 10vh;
}

.login-card {
  width: 360px;
}
</style>
