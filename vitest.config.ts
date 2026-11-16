import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: ['./vitest.setup.no-network.ts'],
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/*.int.test.ts', '**/*.net.test.ts'],
        },
      },
      {
        test: {
          name: 'int',
          include: ['**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
          env: {
            TEST_DATABASE_URL:
              process.env.TEST_DATABASE_URL ??
              'postgres://assistant_test:assistant_test@127.0.0.1:54329/assistant_test',
          },
        },
      },
      {
        // PF10: real-socket tests (loopback servers only), opt-in with `npx vitest run --project net`. No no-network setup:
        // these tests pin test hostnames to loopback IPs, which the hostname-based unit guard cannot tell apart.
        test: {
          name: 'net',
          include: ['**/*.net.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
        },
      },
    ],
  },
});
