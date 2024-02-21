/**
 * Pyodide service types.
 * @package    @epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

declare type Pyodide = {
    runPythonAsync (code: string): Promise<string>
    loadPackage (packages: string | string[]): Promise<void>
}

declare module 'pyodide/pyodide.js' {
    export function loadPyodide (config: { indexURL: string }): Promise<Pyodide>
}

declare const loadPyodide: (params: unknown) => Promise<unknown>