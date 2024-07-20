/**
 * Pyodide service types.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

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