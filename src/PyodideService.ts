/**
 * Pyodide service.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericService } from '@epicurrents/core'
import {
    type SetupMutexResponse,
    type SetupWorkerResponse,
    type WorkerResponse,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { type MutexExportProperties } from 'asymmetric-io-mutex'

import biosignal from './scripts/biosignal.py?raw'
import {
    type PythonInterpreterService,
    type RunCodeResult,
    type ScriptState,
    type UpdateInputSignalsResponse,
} from '#types'
const DEFAULT_SCRIPTS = new Map([
    ['biosignal', biosignal],
])

const SCOPE = 'PyodideService'

export default class PyodideService extends GenericService implements PythonInterpreterService {
    protected _callbacks = [] as ((...results: unknown[]) => unknown)[]
    protected _loadedPackages = [] as string[]
    /**
     * Some scripts are run only once and kept in memory.
     * This property lists names of scripts that should not be run multiple times and their loading state.
     */
    protected _scripts = {} as { [name: string]: ScriptState }

    constructor () {
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to core application runtime was not found.`, SCOPE)
        }
        const overrideWorker = window.__EPICURRENTS__?.RUNTIME?.WORKERS.get('pyodide')
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

    async awaitDependecies (dependencies: string[]) {
        const invalidScriptStates = ['not_loaded', 'error']
        for (const dep of dependencies) {
            if (this._scripts[dep]) {
                if (invalidScriptStates.includes(this._scripts[dep].state)) {
                    Log.error(`Cannot run code, dependency script has not loaded yet.`, SCOPE)
                    return false
                } else if (this._scripts[dep].state === 'loading') {
                    // If any dependency is still loading, wait for all to load.
                    const results = await Promise.all(dependencies.map(dep => this.awaitAction(`script:${dep}`)))
                    if (results.some(result => !result)) {
                        Log.error(`Dependency script loading failed.`, SCOPE)
                        return false
                    }
                }
            }
        }
        return true
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

    async loadDefaultScript (name: string) {
        const script = DEFAULT_SCRIPTS.get(name)
        if (script) {
            try {
                await this.runScript(name, script, {})
            } catch (e: unknown) {
                return { success: false, error: e as string }
            }
            return { success: true }
        }
        return { success: false, error: `Default script '${name}' was not found.` }
    }

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
        return response as boolean
    }

    async postMessage (message: unknown, scriptDeps: string[] = [], transferList?: Transferable[]) {
        await this.initialSetup
        if (scriptDeps.length) {
            if (!(await this.awaitDependecies(scriptDeps))) {
                Log.error(`Cannot post message, dependency script loading failed.`, SCOPE)
                return
            }
        }
        if (this._worker) {
            if (transferList) {
                this._worker.postMessage(message, transferList)
            } else {
                this._worker.postMessage(message)
            }
        }
    }

    async runCode (
        code: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = [],
        transferList?: Transferable[]
    ) {
        await this.initialSetup
        if (!(await this.awaitDependecies(scriptDeps))) {
            return {
                success: false,
                error: `Cannot run code, dependency script loading failed.`
            }
        }
        const commission = this._commissionWorker(
            'run-code',
            new Map<string, unknown>([
                ['code', code],
                ...Object.entries(params)
            ]),
            undefined,
            { transferList }
        )
        return commission.promise as Promise<RunCodeResult>
    }

    async runScript (
        name: string,
        script: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = []
    ) {
        if (name in this._scripts) {
            if (
                this._scripts[name].state === 'loaded'
            ) {
                Log.debug(`Script '${name}' has already been loaded.`, SCOPE)
                return {
                    success: true,
                }
            } else if (
                this._scripts[name].state === 'loading'
            ) {
                return this.awaitAction(`script:${name}`) as Promise<RunCodeResult>
            }
        }
        Log.debug(`Loading script ${name}.`, SCOPE)
        this._initWaiters(`script:${name}`)
        const newScript = {
            params: { ...params },
            state: 'loading',
        } as ScriptState
        this._scripts[name] = newScript
        const response = await this.runCode(script, params, scriptDeps)
        if (name in this._scripts) {
            Log.debug(`Script ${name} loaded.`, SCOPE)
            this._scripts[name].state = 'loaded'
            this._notifyWaiters(`script:${name}`, true)
        }
        return response
    }

    async setInputMutex (
        input: MutexExportProperties,
        dataDuration: number,
        recordingDuration: number,
        bufferStart = 0,
    ) {
        if (this._scripts['biosignal'].state === 'error') {
            Log.error(`Cannot set input mutex, biosignal script setup failed.`, SCOPE)
            return { success: false }
        }
        if (this._scripts['biosignal'].state === 'not_loaded') {
            Log.debug(`Loading biosignals scripts before setting up recording.`, SCOPE)
            if (!(await this.loadDefaultScript('biosignal'))) {
                Log.error(`Cannot set input mutex, biosignal script setup failed.`, SCOPE)
                return { success: false }
            }
        }
        const commission = this._commissionWorker(
            'setup-input-mutex',
            new Map<string, unknown>([
                ['bufferStart', bufferStart],
                ['dataDuration', dataDuration],
                ['input', input],
                ['recordingDuration', recordingDuration],
            ])
        )
        const response = await commission.promise as SetupMutexResponse
        return response
    }

    async setupWorker (config?: { indexURL?: string, packages?: string[] }) {
        // Set up a map for initialization waiters.
        this._initWaiters('setup-worker')
        const commission = this._commissionWorker(
            'setup-worker',
            new Map<string, unknown>([
                ['config', config],
            ])
        )
        const response = await commission.promise as SetupWorkerResponse
        if (config?.packages?.length) {
            this._loadedPackages.push(...config.packages)
        }
        // Notify possible waiters that loading is done.
        this._notifyWaiters('setup-worker', true)
        return response
    }

    async updateInputSignals () {
        await this.initialSetup
        const commission = this._commissionWorker('update-input-signals')
        const response = await commission.promise as UpdateInputSignalsResponse
        return response
    }
}
