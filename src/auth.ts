export function isBasicAuthValid(
  authorization: string | null,
  passwordProtection?: string
): boolean {
  if (!passwordProtection) return true

  const expected = `Basic ${btoa(passwordProtection)}`
  if (!authorization || authorization.length !== expected.length) return false

  const actualBytes = new TextEncoder().encode(authorization)
  const expectedBytes = new TextEncoder().encode(expected)
  let difference = 0

  for (let index = 0; index < actualBytes.length; index++) {
    difference |= actualBytes[index] ^ expectedBytes[index]
  }

  return difference === 0
}
