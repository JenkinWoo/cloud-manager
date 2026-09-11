export function getStoredCreationCredentials(task) {
  if (task?.type !== 'cloud:createInstance') return null
  const params = task.params || {}
  let username
  let password
  if (params.provider === 'azure') {
    username = params.adminUsername || 'azureuser'
    password = params.adminPassword
  } else if (params.provider === 'oracle' || params.provider === 'aws') {
    username = params.provider === 'oracle' ? 'root' : 'ec2-user'
    password = params.rootPassword
  }
  if (typeof password !== 'string' || !password.length) return null
  return { username, password }
}

// Keep the persisted creation parameters available to the worker, while sending
// only redacted task data through list responses and SSE broadcasts.
export function serializeTask(task) {
  const passwords = [task.params?.rootPassword, task.params?.adminPassword]
    .filter((value) => typeof value === 'string' && value.length)
  function redact(value) {
    if (typeof value === 'string') {
      return passwords.reduce((text, password) => text.split(password).join('[REDACTED]'), value)
    }
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/password/i.test(key))
        .map(([key, entry]) => [key, redact(entry)]))
    }
    return value
  }
  return { ...redact(task), hasCreationPassword: task.status === 'done' && Boolean(getStoredCreationCredentials(task)) }
}
