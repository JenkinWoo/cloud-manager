import assert from 'node:assert/strict'
import { test } from 'node:test'
import AwsProvider from '../backend/providers/compute/AwsProvider.mjs'

test('AWS sends the exact submitted password without interpolating shell metacharacters', async () => {
  const provider = new AwsProvider({ credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' } })
  const password = "Aa12!$()'\\#@%"
  let request
  provider.client.send = async (command) => {
    request = command.input
    return { Instances: [{ InstanceId: 'test-instance' }] }
  }
  await provider.createInstance({ imageId: 'test-ami', rootPassword: password })
  const userData = Buffer.from(request.UserData, 'base64').toString('utf8')
  assert.equal(userData.includes(password), false)
  const encoded = userData.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1]
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), `ec2-user:${password}\n`)
})
