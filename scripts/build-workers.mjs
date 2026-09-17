/**
 * Standalone worker bundles — the escape hatch from inlining.
 *
 * `dist/` inlines the worker as a Blob, which requires `worker-src blob:` in the consumer's content
 * security policy. A consumer that cannot grant it serves these files instead and registers a
 * URL-based factory, which takes precedence over the inlined default.
 *
 * The bundle is self-contained, because a worker resolves no bare specifiers of its own, and an ES
 * module, because it loads the Pyodide runtime through a dynamic `import()` that only a module
 * worker can perform — a consumer serving this file constructs it with `{ type: 'module' }`.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */
import { build } from 'vite'
import { ALIASES, abs, minifyWorkerOutput } from '../vite.shared.mjs'

const WORKERS = ['pyodide']

for (const name of WORKERS) {
    await build({
        configFile: false,
        logLevel: 'warn',
        build: {
            lib: {
                entry: abs(`./src/${name}.worker.ts`),
                formats: ['es'],
                fileName: () => `${name}.worker.js`,
            },
            minify: false,
            outDir: abs('./umd'),
            emptyOutDir: false,
            target: 'esnext',
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                },
            },
        },
        plugins: [minifyWorkerOutput()],
        resolve: {
            alias: ALIASES,
        },
    })
    console.log(`built umd/${name}.worker.js`)
}
