import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
          setupFiles: ['tests/setup/vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'contract',
          include: ['tests/contracts/**/*.test.ts'],
          setupFiles: ['tests/setup/vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/setup/vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'property',
          include: ['tests/properties/**/*.test.ts'],
          setupFiles: ['tests/setup/vitest.setup.ts'],
          testTimeout: 20000,
        },
      },
    ],
  },
});
