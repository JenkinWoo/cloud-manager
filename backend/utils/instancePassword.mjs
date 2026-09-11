import { randomInt } from 'node:crypto'
import { validateOracleInstancePassword } from './oraclePassword.mjs'

const GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%_-+=']

export function generateInstancePassword() {
  const alphabet = GROUPS.join('')
  const characters = GROUPS.map((group) => group[randomInt(group.length)])
  while (characters.length < 20) characters.push(alphabet[randomInt(alphabet.length)])
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1)
    ;[characters[index], characters[other]] = [characters[other], characters[index]]
  }
  return characters.join('')
}

export function validateAwsInstancePassword(password) {
  try {
    validateOracleInstancePassword(password)
  } catch (error) {
    throw new Error(error.message.replace(/Oracle/g, 'AWS'))
  }
}
