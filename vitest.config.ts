import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Edge functions run on Deno and are tested separately; keep Vitest to the
    // Node-side contract and harness logic.
    include: ['packages/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
