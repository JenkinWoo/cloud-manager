import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateInstancePassword, validateAwsInstancePassword } from '../backend/utils/instancePassword.mjs'
import { validateOracleInstancePassword } from '../backend/utils/oraclePassword.mjs'
import { getStoredCreationCredentials, serializeTask } from '../backend/utils/taskCredentials.mjs'

test('generated passwords meet the current Oracle rules and Azure Linux length/complexity requirements', () => {
  const passwords = new Set()
  for (let index = 0; index < 200; index++) {
    const password = generateInstancePassword()
    assert.equal(password.length, 20)
    assert.match(password, /^[A-Za-z2-9!@#%_+=-]+$/)
    for (const category of [/[A-Z]/, /[a-z]/, /\d/, /[!@#%_+=-]/]) assert.match(password, category)
    assert.equal(validateOracleInstancePassword(password), true)
    assert.doesNotThrow(() => validateAwsInstancePassword(password))
    passwords.add(password)
  }
  assert.equal(passwords.size, 200)
})

test('password validation rejects non-text values and line breaks before provisioning', () => {
  for (const password of [null, 123456789, ['Aa12345!'], 'Aa12345!\ninjected']) {
    assert.throws(() => validateOracleInstancePassword(password))
    assert.throws(() => validateAwsInstancePassword(password))
  }
})

test('creation credentials use the submitted username and password and never guess missing historical values', () => {
  assert.deepEqual(getStoredCreationCredentials({ type: 'cloud:createInstance', params: {
    provider: 'azure', adminUsername: 'customuser', adminPassword: 'Test-only-Azure1!'
  } }), { username: 'customuser', password: 'Test-only-Azure1!' })
  for (const [provider, username] of [['oracle', 'root'], ['aws', 'ec2-user']]) {
    assert.deepEqual(getStoredCreationCredentials({ type: 'cloud:createInstance', params: {
      provider, rootPassword: 'Test-only-Linux1!'
    } }), { username, password: 'Test-only-Linux1!' })
  }
  assert.equal(getStoredCreationCredentials({ type: 'cloud:createInstance', params: { provider: 'aws' } }), null)
  assert.equal(getStoredCreationCredentials({ type: 'other', params: { provider: 'oracle', rootPassword: 'Test-only-Linux1!' } }), null)
})

test('public task serialization removes passwords including echoed errors without changing the stored task', () => {
  const task = { type: 'cloud:createInstance', status: 'done', params: {
    provider: 'oracle', rootPassword: 'Test-only-Oracle1!', nested: { adminPassword: 'Nested-only1!' }
  }, error: 'Rejected Test-only-Oracle1!', statusMessage: 'Test-only-Oracle1!',
  result: { instanceId: 'test-instance', password: 'Another-only1!' } }
  const original = structuredClone(task)
  const serialized = serializeTask(task)
  assert.equal(serialized.hasCreationPassword, true)
  assert.equal(serialized.params.rootPassword, undefined)
  assert.equal(serialized.params.nested.adminPassword, undefined)
  assert.equal(serialized.result.password, undefined)
  assert.equal(JSON.stringify(serialized).includes('Test-only-Oracle1!'), false)
  assert.deepEqual(task, original)
  assert.equal(serializeTask({ ...task, status: 'running' }).hasCreationPassword, false)
})
