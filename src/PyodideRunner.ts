/**
 * Pyodide runner.
 * @package    @epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { loadPyodide } from 'pyodide/pyodide.js'
import { Log } from 'scoped-ts-log'

const SCOPE = 'PyodideRunner'

export default class PyodideRunner {
    protected _loadPromise: Promise<void> | null
    protected _loadWaiters: (() => void)[] = []
    protected _pyodide: Pyodide | null = null

    constructor () {
        this._loadPromise = this.loadPyodideAndPackages()
        this._loadPromise.then(() => {
            // Notify possible waithers that loading is done.
            for (const resolve of this._loadWaiters) {
                resolve()
            }
            this._loadPromise = null
        })
    }

    get loadPromise () {
        if (!this._loadPromise) {
            return Promise.resolve()
        }
        const promise = new Promise<void>((resolve) => {
            this._loadWaiters.push(resolve)
        })
        return promise
    }

    async loadPyodideAndPackages () {
        // Load main Pyodide
        this._pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.19.1/full/",
        })
        // Load packages that are common to all contexts.
        await this._pyodide?.loadPackage(['numpy'])
    }

    async loadPackages (packages: string[]) {
        await this.loadPromise
        await this._pyodide?.loadPackage(packages)
    }

    async runCode (code: string, params?: { [key: string]: unknown }) {
        await this.loadPromise
        if (params) {
            for (const key in params) {
                // Check for prototype injection attempt.
                if (key.includes('__proto__')) {
                    Log.warn(`Code param ${key} contains insecure field '__proto__', parameter was ignored.`, SCOPE)
                    continue
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any)[key] = params[key]
            }
        }
        const results = await this._pyodide?.runPythonAsync(code)
        return results
    }
}
