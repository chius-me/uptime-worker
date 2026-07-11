declare module 'node:fs/promises' {
  export function readFile(path: URL, encoding: string): Promise<string>
}

interface ImportMeta {
  url: string
}
