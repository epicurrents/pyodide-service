import { defineConfig } from 'vitest/config'
import { ALIASES } from './vite.shared.mjs'

export default defineConfig({
    resolve: {
        alias: ALIASES,
    },
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reportsDirectory: 'tests/coverage',
            /*
             * Report on every source file, not only the ones a test happened to import. The default
             * scores an untested module as absent rather than as zero, which flatters the total by
             * exactly the modules most in need of a test.
             */
            include: ['src/**/*.ts'],
        },
    },
})
