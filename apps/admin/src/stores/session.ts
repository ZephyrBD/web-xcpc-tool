import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiFetch, clearToken, getToken, setToken } from '@/api'

export const useSessionStore = defineStore('session', () => {
  const token = ref<string | null>(getToken())

  async function login(username: string, password: string): Promise<void> {
    const data = await apiFetch<{ token: string }>('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      skipAuthRedirect: true,
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
