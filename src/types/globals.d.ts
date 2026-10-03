/**
 * Declarations for the Vite import forms this package uses. Everything else it declares is a
 * module type in [index.ts](./index.ts): an ambient declaration is visible to every file whether it
 * asked for it or not, and `skipLibCheck` keeps the compiler from reporting what is wrong inside
 * one — a broken type here reaches its use sites as a silent `any`.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

declare module '*?raw' {
    const content: string
    export default content
}

/**
 * Worker bundled and inlined by the build. The bundle is self-contained and carries its own copy of
 * every dependency, so the constructed worker resolves nothing at run time except the Pyodide
 * runtime it loads from the configured index URL.
 */
declare module '*?worker&inline' {
    const InlinedWorker: new (options?: { name?: string }) => Worker
    export default InlinedWorker
}
