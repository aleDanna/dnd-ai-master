import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '#data': fileURLToPath(new URL('./data', import.meta.url)),
};

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/db/migrate.ts'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['tests/components/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/setup-dom.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'tests/e2e/**',
            'tests/components/**',
          ],
        },
      },
    ],
  },
});
