/**
 * Pyodide service.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericService } from '@epicurrents/core'
import { type AssetService, type WorkerResponse } from '@epicurrents/core/dist/types'
import { Log } from 'scoped-ts-log'

const SCOPE = 'PyodideService'

type LoadingState = 'error' | 'loaded' | 'loading' | 'not_loaded'
type ScriptState = {
    params: { [key: string]: unknown }
    state: LoadingState
}
export default class PyodideService extends GenericService implements AssetService {
    protected _callbacks = [] as ((...results: unknown[]) => unknown)[]
    protected _loadedPackages = [] as string[]
    /**
     * Some scripts are run only once and kept in memory.
     * This property lists names of scripts that should not be run multiple times and their loading state.
     */
    protected _scripts = {} as { [name: string]: ScriptState }

    constructor () {
        if (!window.__EPICURRENTS_RUNTIME__) {
            Log.error(`Reference to application runtime was not found!`, SCOPE)
        }
        const overrideWorker = window.__EPICURRENTS_RUNTIME__?.WORKERS.get('pyodide')
        const worker = overrideWorker ? overrideWorker() : new Worker(
            new URL(
                /* webpackChunkName: 'pyodide.worker' */
                `./pyodide.worker`,
                import.meta.url
            ),
            { type: 'module' }
        )
        Log.registerWorker(worker)
        super(SCOPE, worker)
        worker.addEventListener('message', this.handleWorkerResponse.bind(this))
    }

    handleWorkerResponse (message: WorkerResponse) {
        const data = message.data
        if (!data || !data.action) {
            return false
        }
        const commission = this._getCommissionForMessage(message)
        if (commission) {
            if (data.action === 'run-code') {
                if (data.success) {
                    commission.resolve(data)
                } else if (commission.reject) {
                    commission.reject(data.error as string)
                }
                return true
            } else {
                return super._handleWorkerCommission(message)
            }
        }
        return false
    }

    /**
     * Load the given packages into the Python interpreter.
     * @param packages - Array of package names to load.
     */
    async loadPackages (packages: string[]) {
        packages = packages.filter(pkg => (this._loadedPackages.indexOf(pkg) === -1))
        const commission = this._commissionWorker(
            'load-packages',
            new Map<string, unknown>([
                ['packages', packages],
            ])
        )
        const response = await commission.promise
        this._loadedPackages.push(...packages)
        return response
    }

    /**
     * Run the provided piece of `code` with the given `parameters`.
     * @param code - Python code as a string.
     * @param params - Parameters for execution passed to the python script.
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    async runCode (code: string, params: { [key: string]: unknown }) {
        const commission = this._commissionWorker(
            'run-code',
            new Map<string, unknown>([
                ['code', code],
                ...Object.entries(params)
            ])
        )
        return commission.promise
    }

    /**
     * Load and run the `script` using the given `parameters`.
     * @param name - Name of the script.
     * @param script - Script contents.
     * @param params - Parameters for execution passed to the python script.
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    async runScript (name: string, script: string, params: { [key: string]: unknown }) {
        if (name in this._scripts) {
            if (
                this._scripts[name].state === 'loading' ||
                this._scripts[name].state === 'loaded'
            ) {
                Log.info(`Script ${name} is already loading or has been loaded.`, SCOPE)
                return {
                    success: true,
                }
            }
        }
        Log.debug(`Loading script ${name}.`, SCOPE)
        this._scripts[name] = {
            params: { ...params },
            state: 'loading',
        }
        const commission = this._commissionWorker(
            'run-code',
            new Map<string, unknown>([
                ['code', script],
                ...Object.entries(params)
            ])
        )
        const response = await commission.promise
        if (name in this._scripts) {
            Log.debug(`Script ${name} loaded.`, SCOPE)
            this._scripts[name].state = 'loaded'
        }
        return response
    }
}
