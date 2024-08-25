/**
 * Pyodide service types.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

declare global {
    interface Window extends Omit<typeof Window, "document"> {}
    var document: DummyElement | undefined
    const pyodide: Pyodide
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

declare type Pyodide = {
    loadPackage (packages: string | string[]): Promise<void>
    mountNativeFS (path: string, handle: FileSystemDirectoryHandle): Promise<void>
    runPythonAsync (code: string): Promise<string>
}

declare module 'pyodide/pyodide.js' {
    export function loadPyodide (config: { indexURL: string }): Promise<Pyodide>
}

declare module '*.py' {
    const content: string
    export default content
}

declare const loadPyodide: (params: unknown) => Promise<unknown>

declare type RunPythonCode = (
    code: string,
    params: { [key: string]: unknown },
    simulateDocument?: boolean
) => Promise<RunCodeResult>