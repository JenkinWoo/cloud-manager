import { reactive } from 'vue'
import { authApi, getAuthToken, setAuthToken } from './api/index.js'

export const authState = reactive({
  ready: false,
  authenticated: false,
  user: null
})

let initPromise = null

export function setAuthUser(user) {
  authState.user = user
}

export async function initAuth() {
  if (initPromise) return initPromise

  initPromise = authApi.status()
    .then((res) => {
      authState.authenticated = Boolean(res.data?.authenticated && getAuthToken())
      authState.user = res.data
      authState.ready = true
      return authState
    })
    .catch(() => {
      setAuthToken('')
      authState.authenticated = false
      authState.user = null
      authState.ready = true
      return authState
    })
    .finally(() => {
      initPromise = null
    })

  return initPromise
}

export async function login(credentials) {
  const res = await authApi.login(credentials)
  setAuthToken(res.data.token)
  authState.authenticated = true
  authState.user = res.data.user
  authState.ready = true
  return res.data
}

export async function logout() {
  try {
    if (getAuthToken()) await authApi.logout()
  } catch (_) {
  } finally {
    setAuthToken('')
    authState.authenticated = false
    authState.user = null
    authState.ready = true
  }
}
