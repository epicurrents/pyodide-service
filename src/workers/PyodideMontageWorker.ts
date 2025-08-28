/**
 * Pyodide montage worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

import { validateCommissionProps } from '@epicurrents/core/dist/util'
import { MontageWorker } from '@epicurrents/core/dist/workers'
import type {
    CommonBiosignalSettings,
    MontageWorkerCommission,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import PyodideMontageProcesser from '#root/src/components/PyodideMontageProcessor'
import type { PythonWorkerCommission, RunCodeResult } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = "PyodideMontageWorker"

export class PyodideMontageWorker extends MontageWorker {
    protected _initialized = false
    protected _loadingDone = false
    protected _loadWaiters = [] as (() => void)[]
    protected _montage = null as PyodideMontageProcesser | null
    protected _namespace = ''
    protected _settings = null as CommonBiosignalSettings | null
    constructor () {
        super()
        // Extend action map with Python commissions.
        // We also need to remap any super class actions to methods redefined in this class.
        this.extendActionMap([
            ['get-signals', this.getSignals],
            ['load-packages', this.loadPackages],
            ['run-code', this.runCode],
            ['set-filters', this.setFilters],
            ['setup-input-mutex', this.setupInputMutex],
            ['setup-montage', this.setupMontage],
            ['setup-worker', this.setupWorker],
            ['update-input-signals', this.updateInputSignals],
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

    async clearMontage (msgData?: WorkerMessage['data']) {
        Log.debug(`Clearing current montage.`, SCOPE)
        await this._montage?.releaseCache()
        this._montage = null
        if (msgData) {
            this._success(msgData)
        }
    }

    async getSignals(msgData: WorkerMessage['data']): Promise<boolean> {
        const data = validateCommissionProps(
            msgData as MontageWorkerCommission['get-signals'],
            {
                range: ['Number', 'Number'],
                config: 'Object?',
                montage: 'String?',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        // Check that the correct montage is active, if it is given.
        if (data.montage && this._montage.activeMontage !== data.montage) {
            if (!this._montage.setMontage(data.montage)) {
                return this._failure(msgData, `Given montage ${data.montage} has not been set up.`)
            } else {
                this._name = data.montage
            }
        }
        return super.getSignals(msgData)
    }

    async handlePythonMessage (message: WorkerMessage) {
        if (!message?.data?.action) {
            return this._failure(message.data || {}, `Worker commission did not contain data or an action.`)
        }
        if (message.data.action === 'setup-worker') {
            if (message.data.montage) {
                // Try montage setup.
                return this.setupMontage(message.data)
            }
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

    async setFilters (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as MontageWorkerCommission['set-filters'],
            {
                name: 'String',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        if (this._montage.activeMontage === data.name) {
            return super.setFilters(msgData)
        } else {
            // We need to set the right channels to update with the new filters.
            const actMontage = this._montage.activeMontage
            this._montage.setMontage(data.name)
            this._name = data.name
            const success = await super.setFilters(msgData)
            this._montage.setMontage(actMontage)
            this._name = actMontage
            if (success) {
                return this._success(msgData)
            } else {
                return this._failure(msgData)
            }
        }
    }

    async setupInputMutex (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['set-input-mutex'],
            {
                bufferStart: 'Number',
                config: 'Object',
                dataDuration: 'Number',
                input: 'Object',
                montage: 'String',
                recordingDuration: 'Number',
                setupChannels: 'Array',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        this._montage.setupChannels(data.montage, data.config, data.setupChannels)
        const cacheSetup = await this._montage.setupMutexWithInput(
            data.input,
            data.bufferStart,
            data.dataDuration,
            data.recordingDuration
        )
        if (cacheSetup) {
            Log.debug(`Mutex setup complete.`, SCOPE)
            // Set the mutex input data buffers as signal source in Pyodide.
            const result = await this._runPythonCode(
                'biosignal_set_buffers()',
                {
                    buffers: await this._montage.getInputViews()
                }
            )
            if (result.success) {
                // Pass the generated shared buffers back to main thread.
                return this._success(msgData, {
                    cacheProperties: cacheSetup,
                })
            } else {
                return this._failure(msgData, `Setting input buffers in Pyodide montege processer failed.`)
            }
        } else {
            return this._failure(msgData, `Setting up mutex in the Pyodide montage processer failed.`)
        }
    }

    async setupMontage (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['setup-montage'],
            {
                config: 'Object',
                montage: 'String',
                namespace: 'String',
                settings: 'Object',
                setupChannels: 'Array',
            },
        )
        if (!data) {
            return this._failure(msgData)
        }
        if (!this._settings) {
            this._namespace = data.namespace
            this._settings = data.settings.modules[data.namespace] as unknown as CommonBiosignalSettings
        }
        if (!this._montage) {
            // Create new montage processer.
            Log.debug(`Creating a new processer for montage ${data.montage}.`, SCOPE)
            this._montage = new PyodideMontageProcesser(this._runPythonCode, this._settings)
        }
        this._montage.setupChannels(data.montage, data.config, data.setupChannels)
        return this._success(msgData)
    }

    async setupWorker (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['setup-worker'],
            {
                config: 'Object?',
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
        this._initialized = true
        return this._success(msgData)
    }
    /**
     * Update the content of the python input signal arrays to match the shared array buffer content.
     * @param msgData - Data part of the commission message.
     * @returns True on success, false on failure.
     */
    async updateInputSignals (msgData: WorkerMessage['data']) {
        if (!this._montage) {
            // Montage may not be set up if the current modality does not support SAB/Pyodide.
            return this._failure(msgData, 'Cannot update input signals in Pyodide worker, montage is not set up.')
        }
        const data = validateCommissionProps(msgData, {})
        if (!data) {
            return this._failure(msgData)
        }
        const updateInput = await this._montage?.updateInputSignals()
        if (updateInput.success) {
            return this._success(msgData)
        } else {
            return this._failure(msgData, updateInput.error)
        }
    }
}
export default PyodideMontageWorker
