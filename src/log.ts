export function logEvent(name: string, fields: Record<string, string | number | boolean | null>): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')
  console.log(`${name}${suffix ? ` ${suffix}` : ''}`)
}
