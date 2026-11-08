import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiFetch, clearToken, getToken, setToken } from '@/api'

export const useSessionStore = defineStore('session', () => {
  const token = ref<string | null>(getToken())

  async function login(username: string, password: string): Promise<void> {
    const data = await apiFetch<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    token.value = data.token
    setToken(data.token)
  }

  function logout(): void {
    token.value = null
    clearToken()
  }

  return { token, login, logout }
})
