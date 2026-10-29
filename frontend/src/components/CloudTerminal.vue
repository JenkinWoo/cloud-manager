<template>
  <p class="connection-status" role="status">{{ status }}</p>
  <p v-if="error" class="terminal-error" role="alert">{{ error }}</p>
  <section class="terminal-card" aria-label="交互式云终端">
    <div class="terminal-toolbar">
      <span>&gt;_ 实例救援终端</span>
      <div class="terminal-actions">
        <button class="btn btn-ghost btn-sm" :disabled="state !== 'connected'" @click="sendInput('\r')">Enter</button>
        <button class="btn btn-ghost btn-sm" :disabled="state !== 'connected'" @click="sendInput('\u0003')">Ctrl+C</button>
        <button class="btn btn-ghost btn-sm" :disabled="state !== 'connected'" @click="sendInput('\t')">Tab</button>
        <button class="btn btn-ghost btn-sm" @click="terminal?.clear()">清屏</button>
      </div>
    </div>
    <div ref="terminalElement" class="terminal-host"></div>
    <div class="terminal-footer">连接后点击终端直接输入。空白屏幕可先按 Enter。离开页面会断开；空闲 15 分钟或连接满 1 小时后自动关闭。</div>
  </section>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cloudShellApi, getAuthToken } from '../api/index.js'

const emit = defineEmits(['active'])
const state = ref('idle')
const status = ref('未连接')
const error = ref('')
const terminalElement = ref(null)
let terminal, fit, observer, socket, sessionId, resizeTimer, handshakeTimer
let disposed = false
let generation = 0
watch(state, value => emit('active', value !== 'idle'), { flush: 'sync' })
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)) }
function sendInput(data) {
  if (state.value !== 'connected') return
  const characters = Array.from(data)
  for (let offset = 0; offset < characters.length; offset += 4096) send({ type: 'input', data: characters.slice(offset, offset + 4096).join('') })
  terminal?.focus()
}
function resize() {
  if (disposed || !terminalElement.value?.clientWidth) return
  fit?.fit()
  if (state.value === 'connected') send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
}
async function closeReservation(id) {
  if (!id) return
  try {
    // Unlike an ordinary XHR, keepalive can finish while the page is unloading.
    await fetch(`/api/cloud-shell/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${getAuthToken()}` }
    })
  }
  catch { /* Socket close and reservation timeout also clean up the session. */ }
}
function disconnect() {
  generation++
  clearTimeout(handshakeTimer)
  const ws = socket
  socket = null
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close()
  void closeReservation(sessionId)
  sessionId = null
  state.value = 'idle'
  status.value = '已断开'
}
async function connect(request) {
  if (state.value !== 'idle' || !terminal) return
  const id = ++generation
  error.value = ''
  state.value = 'creating'
  status.value = '正在创建会话…'
  terminal.reset()
  terminal.writeln('正在连接云端终端…')
  resize()
  try {
    const { data } = await cloudShellApi.createSession({ ...request, cols: terminal.cols, rows: terminal.rows })
    if (disposed || id !== generation) { await closeReservation(data.id); return }
    sessionId = data.id
    const url = new URL('/api/cloud-shell/socket', window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    socket = ws
    state.value = 'connecting'
    handshakeTimer = setTimeout(() => {
      if (id === generation && state.value === 'connecting') { error.value = '终端通道超时，请检查反向代理的 WebSocket 配置'; disconnect() }
    }, 15000)
    ws.onopen = () => {
      if (id !== generation || disposed) { ws.close(); return }
      send({ type: 'auth', token: getAuthToken(), sessionId })
    }
    ws.onmessage = event => {
      if (id !== generation || disposed) return
      let message
      try { message = JSON.parse(event.data) } catch { return }
      clearTimeout(handshakeTimer)
      if (message.type === 'output') terminal.write(Uint8Array.from(atob(message.data), char => char.charCodeAt(0)))
      if (message.type === 'status') { status.value = message.message; state.value = 'connecting' }
      if (message.type === 'ready') { state.value = 'connected'; status.value = '已连接'; resize(); terminal.focus() }
      if (message.type === 'error' || message.type === 'notice') error.value = message.message
      if (message.type === 'closed') { status.value = message.message; state.value = 'idle'; terminal.writeln(`\r\n[${message.message}]`) }
    }
    ws.onerror = () => { if (id === generation) error.value = '终端通道连接失败，请检查后端及 WebSocket 代理配置' }
    ws.onclose = () => {
      if (id !== generation || disposed) return
      clearTimeout(handshakeTimer)
      if (state.value !== 'idle') status.value = '连接已断开'
      state.value = 'idle'
      socket = null
      const closedId = sessionId
      sessionId = null
      void closeReservation(closedId)
    }
  } catch (err) {
    if (id !== generation || disposed) return
    error.value = err.response?.data?.error || '无法创建终端会话'
    disconnect()
  }
}
defineExpose({ connect, disconnect })
onMounted(async () => {
  window.addEventListener('pagehide', disconnect)
  terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'Consolas, Menlo, monospace', scrollback: 3000,
    theme: { background: '#080d17', foreground: '#e2e8f0', cursor: '#5b8cff' } })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(terminalElement.value)
  terminal.onData(sendInput)
  terminal.writeln('选择云账户与目标实例，然后点击“连接救援终端”。')
  terminal.writeln('此终端连接云平台的串口服务，不需要目标实例的 SSH 正常工作。')
  await nextTick()
  if (disposed) return
  resize()
  observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150) })
  observer.observe(terminalElement.value)
})
onUnmounted(() => {
  window.removeEventListener('pagehide', disconnect)
  disposed = true
  disconnect()
  observer?.disconnect()
  clearTimeout(resizeTimer)
  terminal?.dispose()
})
</script>

<style scoped>
.connection-status { color: var(--accent); margin-top: 16px; }
.terminal-error { color: var(--red); margin-top: 12px; overflow-wrap: anywhere; }
.terminal-card { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: #080d17; }
.terminal-toolbar, .terminal-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.terminal-toolbar { padding: 12px 18px; justify-content: space-between; border-bottom: 1px solid var(--border); }
.terminal-toolbar > span { font-family: monospace; color: var(--accent); }
.terminal-host { height: 480px; padding: 12px; }
.terminal-footer { padding: 10px 18px; color: var(--text-secondary); border-top: 1px solid var(--border); font-size: 12px; }
@media (max-width: 900px) { .terminal-host { height: 420px; } }
</style>
