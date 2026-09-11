import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { tasksDb } from './db.mjs'
import { serializeTask } from './utils/taskCredentials.mjs'

export const queueEmitter = new EventEmitter()
queueEmitter.setMaxListeners(100)

export const sseClients = new Set()

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch (e) {
      sseClients.delete(res)
    }
  }
}

export async function createTask(type, accountId, params = {}) {
  const task = {
    id: uuidv4(),
    type,
    accountId,
    params: structuredClone(params),
    status: 'pending',
    result: null,
    error: null,
    retries: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  tasksDb.data.tasks.push(task)
  await tasksDb.write()

  broadcast({ event: 'task:created', task: serializeTask(task) })
  queueEmitter.emit('task:new', task)
  return task
}

export async function resumePersistedTasks() {
  const resumableTasks = tasksDb.data.tasks.filter(task =>
    ['pending', 'running'].includes(task.status)
  )

  for (const task of resumableTasks) {
    queueEmitter.emit('task:new', task)
  }

  return resumableTasks.length
}

export async function updateTask(id, updates) {
  const task = tasksDb.data.tasks.find(item => item.id === id)
  if (!task) return

  const previousStatus = task.status
  Object.assign(task, updates, { updatedAt: new Date().toISOString() })
  await tasksDb.write()
  broadcast({ event: 'task:updated', task: serializeTask(task) })

  if (task.status !== previousStatus && ['done', 'cancelled'].includes(task.status)) {
    queueEmitter.emit('task:finalized', { task, previousStatus })
  }

  return task
}

export function getTasks(filter = {}) {
  let tasks = tasksDb.data.tasks
  if (filter.status) tasks = tasks.filter(task => task.status === filter.status)
  if (filter.accountId) tasks = tasks.filter(task => task.accountId === filter.accountId)
  if (filter.type) tasks = tasks.filter(task => task.type === filter.type)
  return tasks.slice().reverse().slice(0, 200).map(serializeTask)
}

export function getTask(id) {
  return tasksDb.data.tasks.find((task) => task.id === id)
}

export async function cancelTask(id) {
  return updateTask(id, { status: 'cancelled' })
}
