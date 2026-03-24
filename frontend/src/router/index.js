import { createRouter, createWebHistory } from 'vue-router'
import { authState, initAuth } from '../auth.js'
import Dashboard from '../views/Dashboard.vue'
import Accounts from '../views/Accounts.vue'
import DnsManager from '../views/DnsManager.vue'
import TaskQueue from '../views/TaskQueue.vue'
import Settings from '../views/Settings.vue'

const routes = [
  { path: '/login', component: () => import('../views/Login.vue'), meta: { title: 'Login', public: true } },
  { path: '/', component: Dashboard, meta: { title: 'Dashboard' } },
  { path: '/accounts', component: Accounts, meta: { title: 'Accounts' } },
  { path: '/cloud', component: () => import('../views/CloudInstances.vue'), meta: { title: 'Cloud Instances' } },
  { path: '/dns', component: DnsManager, meta: { title: 'DNS Manager' } },
  { path: '/tasks', component: TaskQueue, meta: { title: 'Task Queue' } },
  { path: '/settings', component: Settings, meta: { title: 'Settings' } }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to) => {
  await initAuth()

  if (to.meta.public) {
    if (authState.authenticated) return '/'
    return true
  }

  if (!authState.authenticated) {
    return `/login?redirect=${encodeURIComponent(to.fullPath)}`
  }

  return true
})

export default router
