const ALLOWED_SPECIALS = "!#$%&'()*+,-./:;<=>?@[\\]^_{|}~"
const ALLOWED_SPECIALS_REGEX = /[!#$%&'()*+,\-./:;<=>?@[\\\]^_{|}~]/
const INVALID_CHAR_REGEX = new RegExp(`[^A-Za-z\\d${escapeForCharClass(ALLOWED_SPECIALS)}]`)

function escapeForCharClass(value) {
  return value.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')
}

export function validateOracleInstancePassword(password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('Oracle 实例密码不能为空')
  }

  if (password.length < 8 || password.length > 100) {
    throw new Error('Oracle 实例密码长度必须为 8 到 100 位')
  }

  if (!/[a-z]/.test(password)) {
    throw new Error('Oracle 实例密码必须至少包含 1 个小写字母')
  }

  if (!/[A-Z]/.test(password)) {
    throw new Error('Oracle 实例密码必须至少包含 1 个大写字母')
  }

  if (!/\d/.test(password)) {
    throw new Error('Oracle 实例密码必须至少包含 1 个数字')
  }

  if (!ALLOWED_SPECIALS_REGEX.test(password)) {
    throw new Error(`Oracle 实例密码必须至少包含 1 个特殊字符，允许字符: ${ALLOWED_SPECIALS}`)
  }

  if (INVALID_CHAR_REGEX.test(password)) {
    throw new Error(`Oracle 实例密码包含不支持的字符，允许字符: ${ALLOWED_SPECIALS}`)
  }

  return true
}

export function getOraclePasswordRuleText() {
  return '8-100 位，至少包含 1 个大写字母、1 个小写字母、1 个数字和 1 个特殊字符'
}
