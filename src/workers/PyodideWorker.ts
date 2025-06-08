/**
 * This is an example Pyodide worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

import { validateCommissionProps } from '@epicurrents/core/dist/util'
import { BaseWorker } from '@epicurrents/core/dist/workers'
import type { CommonBiosignalSettings, WorkerMessage } from '@epicurrents/core/dist/types'
import PyodideMontageProcesser from '#root/src/components/PyodideMontageProcessor'
import type { PythonWorkerCommission, RunCodeResult } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = "PyodideMontageWorker"

export class PyodideWorker extends BaseWorker {
    protected _initialized = false
    protected _loadingDone = false
    protected _loadWaiters = [] as (() => void)[]
    protected _montage = null as PyodideMontageProcesser | null
    protected _namespace = ''
    protected _settings = null as CommonBiosignalSettings | null
    constructor () {
        super()
        // Extend action map with Python commissions.
        this.extendActionMap([
            ['load-packages', this.loadPackages],
            ['run-code', this.runCode],
            ['setup-worker', this.setupWorker],
        ])
    }

    protected _awaitLoad = () => {
        if (this._loadingDone) {
            return Promise.resolve()
        }
        const promise = new Promise<void>((resolve) => {
            this._loadWaiters.push(resolve)
        })
        return promise
    }

    protected _runPythonCode = async (
        code: string,
        context: { [key: string]: unknown },
        simulateDocument = false
    ): Promise<RunCodeResult> => {
        const unbindProps = () => {
            // Unbind properties.
            for (const key of Object.keys(context)) {
                if (key.includes('__proto__')) {
                    continue
                }
                delete (self as any)[key]
            }
        }
        try {
            // Bind properties to allow pyodide access to them.
            for (const key of Object.keys(context)) {
                if (key.includes('__proto__')) {
                    Log.warn(`Code param ${key} contains insecure field '_proto__', parameter was ignored.`, SCOPE)
                    continue
                }
                (self as any)[key] = context[key]
            }
            if (simulateDocument) {
                // Create some dummy object to pass as window and document (only needed for matplotlib).
                const createDummyEl = (..._params: unknown[]) => {
                    return {
                        id: 'dummyEl',
                        style: {},
                        appendChild: (..._params: unknown[]) => {},
                        createElement: createDummyEl,
                        createTextNode: createDummyEl,
                        getContext: (..._params: unknown[]) => {
                            return { draw: () => {}, putImageData: (..._params: unknown[]) => {} }
                        },
                        getElementById: (..._params: unknown[]) => { return createDummyEl() },
                    }
                }
                ;(self as any).document = createDummyEl()
                ;(self as any).window = {
                    setTimeout: (..._params: unknown[]) => { return 1 },
                }
            }
            const runCode = (self as any).pyodide.runPython(code)
            const result = await runCode
            // Undo document simulation.
            if (simulateDocument) {
                ;(self as any).document = undefined
                ;(self as any).window = undefined
            }
            // For more complex data types, Pyodide returns proxies which are prone to memory leaks.
            const resultIsProxy = !!result && typeof result === 'object'
            const response = resultIsProxy
                            // Convert Map (Pyodide's default conversion type for dict) into Object.
                            // Setting create_proxies to false prevents the creation no nested proxies.
                            ? result.toJs({ dict_converter : Object.fromEntries, create_proxies : false })
                            : result
            if (resultIsProxy) {
                // Destroy the proxy to remove the reference to contained data.
                result.destroy()
            }
            unbindProps()
            if (typeof response === 'object' && response.success !== undefined) {
                // Return the complete response if it contains the success property.
                return response
            }
            return {
                success: true,
                result: response,
            }
        } catch (error) {
            unbindProps()
            return {
                success: false,
                error: error as string,
            }
        }
    }

    async handlePythonMessage (message: WorkerMessage) {
        if (!message?.data?.action) {
            return this._failure(message.data || {}, `Worker commission did not contain data or an action.`)
        }
        if (message.data.action === 'setup-worker') {
            return this.setupWorker(message.data)
        }
        // Initialize must be called before anything else.
        if (!this._initialized) {
            return this._failure(
                message.data,
                'Pyodide must be initialized before any other commissions are issued.'
            )
        }
        // Make sure loading is done.
        await this._awaitLoad()
        return this.handleMessage(message)
    }

    async loadPackages (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['load-packages'],
            {
                packages: 'Array',
            }
        )
        if (!data) {
            return this._failure(msgData)
        }
        if (!data.packages) {
            return this._failure(msgData, 'Load-packages requires a non-empty array of packages to load.')
        }
        try {
            await (self as any).pyodide.loadPackage(msgData.packages)
            return this._success(msgData)
        } catch (error) {
            return this._failure(msgData, error as string)
        }
    }

    async loadPyodideAndPackages (config?: { indexURL?: string, packages?: string[] }) {
        // Load main Pyodide from CDN, but packages locally to avoid throttling.
        (self as any).pyodide = await loadPyodide({
            indexURL: config?.indexURL,
        })
        // Load packages that are common to all contexts.
        const packages = ['numpy', 'scipy']
        if (config?.packages?.length) {
            packages.push(...config.packages)
        }
        await (self as any).pyodide.loadPackage(packages)
    }

    async runCode (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['run-code'],
            {
                code: 'String',
            }
        )
        if (!data) {
            return this._failure(msgData)
        }
        if (!data.code) {
            return this._failure(msgData, `'run-code' requires a non-empty code string to run.`)
        }
        // Separate arbitrary code parameters from the required properties.
        const { action, code, rn, ...params } = data
        let simDoc = false
        if (params.simulateDocument) {
            // Extract reserved parameter simulateDocument and remove it from params.
            simDoc = true
            delete params.simulateDocument
        }
        const response = await this._runPythonCode(code, params, simDoc)
        if (response.error) {
            return this._failure(msgData, response.error)
        } else {
            return this._success(msgData, { result: response.result })
        }
    }
    /**
     * Perform worker setup before any other commissions.
     * @param msgData - Optional worker setup properties.
     * @returns Success or failure response.
     */
    async setupWorker (msgData: WorkerMessage['data']) {
        this._initialized = true
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['setup-worker'],
            {
                config: ['Object', 'undefined'],
            }
        )
        if (!data) {
            return this._failure(msgData)
        }
        await this.loadPyodideAndPackages(data.config)
        this._loadingDone = true
        for (const resolve of this._loadWaiters) {
            resolve()
        }
        return this._success(msgData)
    }
}
export default PyodideWorker
