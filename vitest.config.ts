import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests are plain TypeScript run
// in Node and need none of the app's plugins. The explicit include keeps a run
// from the main checkout out of the task worktrees under .claude/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
