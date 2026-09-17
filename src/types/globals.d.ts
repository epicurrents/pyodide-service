/**
 * Pyodide service types.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

declare global {
    interface Window extends Omit<typeof Window, "document"> {}
    var document: DummyElement | undefined
    const pyodide: import('pyodide').PyodideAPI
    const pyodideParams: { [key: string]: unknown }
    var window: DummyWindow | undefined
}

/**
 * A "dummy" Elemement containing the minimum amount of mock properties to avoid errors in the Worker scope.
 */
type DummyElement = {
    id: string
    style: { [key: string]: string }
    appendChild: (..._params: unknown[]) => unknown
    createElement: () => DummyElement
    createTextNode: () => DummyElement
    getContext: (..._params: unknown[]) => {
        draw: () => unknown
        putImageData: (..._params: unknown[]) => unknown
    }
    getElementById: (..._params: unknown[]) => () => DummyElement
}
/**
 * A "dummy" Window cotaining the minimum amount of mock properties to avoid errors in the Worker scope.
 */
type DummyWindow = {
    setTimeout: (..._params: unknown[]) => number
}

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

declare type RunPythonCode = (
    code: string,
    params: { [key: string]: unknown },
    simulateDocument?: boolean
) => Promise<RunCodeResult>