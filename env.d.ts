/// <reference types="@cloudflare/workers-types" />

declare namespace NodeJS {
  interface ProcessEnv {
    UPTIMEFLARE_D1?: D1Database
  }
}
