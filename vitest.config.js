// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defineConfig } = require('vitest/config');
module.exports = defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
