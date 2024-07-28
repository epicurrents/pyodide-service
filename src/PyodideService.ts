/**
 * Pyodide service.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericService } from '@epicurrents/core'
import { type WorkerResponse } from '@epicurrents/core/dist/types'
import { Log } from 'scoped-ts-log'

import biosignal from './scripts/biosignal.py'
import { PythonInterpreterService, RunCodeResult, ScriptState } from '#types'
import { SetupWorkerResponse } from '@epicurrents/core/dist/types/service'
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
        // Set up a map for initializxation waiters.
        this._initWaiters('init')
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

    async runCode (code: string, params: { [key: string]: unknown }, scriptDeps: string[] = []) {
        await this.initialSetup
        const invalidScriptStates = ['not_loaded', 'error']
        for (const dep of scriptDeps) {
            if (this._scripts[dep]) {
                if (invalidScriptStates.includes(this._scripts[dep].state)) {
                    Log.error(`Cannot run code, dependency script has not loaded yet.`, SCOPE)
                    return { success: false }
                } else if (this._scripts[dep].state === 'loading') {
                    Log.debug(`Waiting for dependency script '${dep}' to load before executing code.`, SCOPE)
                    if (!(await this.awaitAction(`script:${dep}`))) {
                        Log.error(`Cannot run code, dependency script loading failed.`, SCOPE)
                        return { success: false }
                    } else {
                        Log.debug(`Script ${dep} loaded, executing code.`, SCOPE)
                    }
                }
            }
        }
        const commission = this._commissionWorker(
            'run-code',
            new Map<string, unknown>([
                ['code', code],
                ...Object.entries(params)
            ])
        )
        return commission.promise as Promise<RunCodeResult>
    }

    async runScript (name: string, script: string, params: { [key: string]: unknown }) {
        if (name in this._scripts) {
            if (
                this._scripts[name].state === 'loading' ||
                this._scripts[name].state === 'loaded'
            ) {
                Log.debug(`Script ${name} is already loading or has been loaded.`, SCOPE)
                return {
                    success: true,
                }
            }
        }
        Log.debug(`Loading script ${name}.`, SCOPE)
        this._initWaiters(`script:${name}`)
        const newScript = {
            params: { ...params },
            state: 'loading',
        } as ScriptState
        this._scripts[name] = newScript
        const commission = this._commissionWorker(
            'run-code',
            new Map<string, unknown>([
                ['code', script],
                ...Object.entries(params)
            ])
        )
        const response = await commission.promise as RunCodeResult
        if (name in this._scripts) {
            Log.debug(`Script ${name} loaded.`, SCOPE)
            this._scripts[name].state = 'loaded'
            this._notifyWaiters(`script:${name}`, true)
        }
        return response
    }

    async setupBiosignalRecording (
        signals?: Float32Array[],
        dataPos = 0,
        dataFields = [] as unknown[],
        filterPadding = 0,
    ) {
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to core application runtime was not found.`, SCOPE)
            return { success: false }
        }
        if (this._scripts['biosignal'].state === 'error') {
            Log.error(`Cannot set up biosignal recording, biosignal script setup failed.`, SCOPE)
            return { success: false }
        }
        if (this._scripts['biosignal'].state === 'not_loaded') {
            Log.debug(`Loading biosignals scripts before setting up recording.`, SCOPE)
            if (!(await this.loadDefaultScript('biosignal'))) {
                Log.error(`Cannot set up biosignal recording, biosignal script setup failed.`, SCOPE)
                return { success: false }
            }
        }
        const response = await this.runCode(
            `biosignal_setup()`,
            {
                data_pos: dataPos,
                data_fields: dataFields,
                filter_padding: filterPadding,
                signals: signals,
            },
            ['biosignal']
        )
        if (!response.success) {
            Log.error(`Failed to set biosignal recording in pyodide.`, SCOPE)
        }
        return response
    }

    async setupWorker (config?: { indexURL?: string, packages?: string[] }) {
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
        this._notifyWaiters('setup', true)
        return response
    }
}
