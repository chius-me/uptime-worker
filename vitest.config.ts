import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          exclude: ['node_modules/**', 'tests/worker.integration.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.toml' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
                TEST_PASSWORD_PROTECTION: 'secret-from-binding',
              },
            },
          })),
        ],
        test: {
          name: 'worker-integration',
          include: ['tests/worker.integration.test.ts'],
          exclude: ['node_modules/**'],
        },
      },
    ],
  },
})
