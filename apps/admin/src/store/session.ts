import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiFetch, clearToken, getToken, setToken } from '@/api'

export const useSessionStore = defineStore('session', () => {
  const token = ref<string | null>(getToken())
  // EventSource cannot send headers, so SSE authenticates with this token
  // as a ?token= query param. The server issues it alongside (currently
  // identical to) the admin JWT in the login response.
  const sseToken = ref<string | null>(getToken())

  async function login(username: string, password: string): Promise<void> {
    const data = await apiFetch<{ token: string; sseToken?: string }>('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      skipAuthRedirect: true,
    })
    token.value = data.token
    sseToken.value = data.sseToken ?? data.token
    setToken(data.token)
  }

  function logout(): void {
    token.value = null
    sseToken.value = null
    clearToken()
  }

  return { token, sseToken, login, logout }
})
