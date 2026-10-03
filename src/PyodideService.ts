/**
 * Pyodide service.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericService } from '@epicurrents/core'
import {
    type SetupMutexResponse,
    type WorkerResponse,
} from '@epicurrents/core/types'
import { Log } from 'scoped-event-log'
import { type MutexExportProperties } from 'asymmetric-io-mutex'

import biosignal from './scripts/biosignal.py?raw'
import InlinePyodideWorker from './pyodide.worker.ts?worker&inline'
import {
    type PythonInterpreterService,
    type RunCodeResult,
    type ScriptState,
} from '#types'
const DEFAULT_SCRIPTS = new Map([
    ['biosignal', biosignal],
])

const SCOPE = 'PyodideService'

export default class PyodideService extends GenericService implements PythonInterpreterService {
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
        const worker = window.__EPICURRENTS__?.RUNTIME?.getWorkerOverride('pyodide')
                       || new InlinePyodideWorker()
        super(SCOPE, worker)
        // The handler is asynchronous for the part it delegates to the base class, and a listener
        // returns nothing, so the promise is dropped deliberately rather than by omission.
        worker.addEventListener('message', (message: MessageEvent) => {
            void this.handleWorkerResponse(message as WorkerResponse)
        })
    }

    /**
     * Settle a commission with the failure that ended it, in the shape the awaiting method promises.
     *
     * Every public method here resolves a result object carrying a `success` property, and the
     * consumers are written to read it. A rejection reaches them as an unhandled one instead, which
     * is why the commission failures are translated rather than propagated — and the commission can
     * be rejected by the service as well as refused by the worker, since a worker-level error
     * rejects everything in flight at once.
     *
     * A commission sent when there is no worker to carry it is the other case this covers: the base
     * class has nothing to post it to and no caller callbacks to reject, so it answers null, which
     * is neither a result nor an error. A service is in that state after it has been shut down.
     * @param reason - Rejection reason from the commission.
     */
    protected _failed (reason: unknown): { success: false, error: string } {
        const error = typeof reason === 'string'
                      ? reason
                      : reason instanceof Error
                        ? reason.message
                        : 'Unknown error'
        return {
            success: false,
            error: error || 'Unknown error',
        }
    }

    /**
     * Wait until every script in `dependencies` has loaded.
     *
     * A name this service has never been asked to load is not waited for. Nothing here knows which
     * scripts exist, so an unknown name can only mean the caller loads it by some other route; the
     * alternative is refusing every run whose dependency is managed elsewhere.
     * @param dependencies - Names of the scripts to wait for.
     * @returns Promise that resolves true once every known dependency has loaded, false if one failed.
     */
    async awaitDependencies (dependencies: string[]) {
        const loading = [] as string[]
        for (const dep of dependencies) {
            const state = this._scripts[dep]?.state
            if (!state || state === 'loaded') {
                continue
            }
            if (state === 'loading') {
                loading.push(dep)
                continue
            }
            Log.error(`Cannot run code, dependency script '${dep}' has not been loaded.`, SCOPE)
            return false
        }
        if (!loading.length) {
            return true
        }
        // Only the scripts actually still loading are waited for. Waiting on the others as well
        // would await an action that has already completed, and a completed action has no waiter
        // list left to join — that resolves undefined, which reads as a failed dependency.
        const results = await Promise.all(loading.map(dep => this.awaitAction(`script:${dep}`)))
        if (results.some(result => !result)) {
            Log.error(`Dependency script loading failed.`, SCOPE)
            return false
        }
        return true
    }

    async handleWorkerResponse (message: WorkerResponse) {
        const data = message.data
        if (!data || !data.action) {
            return false
        }
        const commission = this._getCommissionForMessage(message)
        if (!commission) {
            return false
        }
        switch (data.action) {
            case 'load-packages':
            case 'run-code':
            case 'setup-input-mutex': {
                // These three are answered with the reply itself, failures included: each is
                // awaited by a method that promises a result object, and the reply is that object.
                // The entry is dropped here because nothing else drops it — the base class releases
                // the commissions it settles, and these never reach it.
                this._releaseCommission(message)
                commission.resolve(data)
                return true
            }
            default: {
                return await super._handleWorkerCommission(message)
            }
        }
    }

    async loadDefaultScript (name: string) {
        const script = DEFAULT_SCRIPTS.get(name)
        if (!script) {
            return { success: false, error: `Default script '${name}' was not found.` }
        }
        const response = await this.runScript(name, script, {})
        if (!response.success) {
            return { success: false, error: response.error }
        }
        return { success: true }
    }

    async loadPackages (packages: string[]) {
        const pending = packages.filter(pkg => !this._loadedPackages.includes(pkg))
        if (!pending.length) {
            return true
        }
        try {
            const commission = this._commissionWorker(
                'load-packages',
                new Map<string, unknown>([
                    ['packages', pending],
                ])
            )
            const response = await commission.promise as RunCodeResult
            if (!response?.success) {
                Log.error(`Loading packages failed: ${String(response?.error)}.`, SCOPE)
                return false
            }
            // Recorded only once the interpreter has them. A package marked loaded after a failed
            // load is filtered out of every later attempt, so the failure is never retried.
            this._loadedPackages.push(...pending)
            return true
        } catch (e: unknown) {
            Log.error(`Loading packages failed: ${this._failed(e).error}.`, SCOPE)
            return false
        }
    }

    async postMessage (message: unknown, scriptDeps: string[] = [], transferList?: Transferable[]) {
        await this.initialSetup
        if (scriptDeps.length && !(await this.awaitDependencies(scriptDeps))) {
            Log.error(`Cannot post message, dependency script loading failed.`, SCOPE)
            return
        }
        if (!this._worker) {
            return
        }
        if (transferList) {
            this._worker.postMessage(message, transferList)
        } else {
            this._worker.postMessage(message)
        }
    }

    async runCode (
        code: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = [],
        transferList?: Transferable[]
    ): Promise<RunCodeResult> {
        await this.initialSetup
        if (!(await this.awaitDependencies(scriptDeps))) {
            return {
                success: false,
                error: `Cannot run code, dependency script loading failed.`
            }
        }
        try {
            const commission = this._commissionWorker(
                'run-code',
                new Map<string, unknown>([
                    ['code', code],
                    ...Object.entries(params)
                ]),
                undefined,
                { transferList }
            )
            const response = await commission.promise as RunCodeResult | null
            return response ?? this._failed(`The Pyodide worker is not available.`)
        } catch (e: unknown) {
            return this._failed(e)
        }
    }

    async runScript (
        name: string,
        script: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = []
    ): Promise<RunCodeResult> {
        const state = this._scripts[name]?.state
        if (state === 'loaded') {
            Log.debug(`Script '${name}' has already been loaded.`, SCOPE)
            return { success: true }
        }
        if (state === 'loading') {
            // The run already in flight is the one that will answer; joining its waiters is what
            // keeps a second caller from running the same script again.
            if (await this.awaitAction(`script:${name}`)) {
                return { success: true }
            }
            return { success: false, error: `Loading script '${name}' failed.` }
        }
        Log.debug(`Loading script ${name}.`, SCOPE)
        this._initWaiters(`script:${name}`)
        this._scripts[name] = {
            params: { ...params },
            state: 'loading',
        } as ScriptState
        const response = await this.runCode(script, params, scriptDeps)
        // The recorded state is what every dependent reads. A script marked loaded after a failed
        // run sends its dependents to call definitions the interpreter does not have, and one left
        // loading never settles them at all, because the waiters are notified from here only.
        if (this._scripts[name]) {
            this._scripts[name].state = response.success ? 'loaded' : 'error'
        }
        this._notifyWaiters(`script:${name}`, response.success)
        return response
    }

    async setInputMutex (
        input: MutexExportProperties,
        dataDuration: number,
        recordingDuration: number,
        bufferStart = 0,
    ): Promise<SetupMutexResponse> {
        // The Python-side global state must exist before the shared buffers are wired into it, and a
        // service that has not run the script yet holds no entry for it at all.
        if (this._scripts['biosignal']?.state !== 'loaded') {
            Log.debug(`Loading biosignal script before setting up recording.`, SCOPE)
            const loaded = await this.loadDefaultScript('biosignal')
            if (!loaded.success) {
                Log.error(`Cannot set input mutex, biosignal script setup failed.`, SCOPE)
                return { success: false }
            }
        }
        try {
            const commission = this._commissionWorker(
                'setup-input-mutex',
                new Map<string, unknown>([
                    ['bufferStart', bufferStart],
                    ['dataDuration', dataDuration],
                    ['input', input],
                    ['recordingDuration', recordingDuration],
                ])
            )
            const response = await commission.promise as SetupMutexResponse | null
            return response ?? { success: false }
        } catch (e: unknown) {
            Log.error(`Setting up the input mutex failed: ${this._failed(e).error}.`, SCOPE)
            return { success: false }
        }
    }

    async setupWorker (config?: { indexURL?: string, packages?: string[] }) {
        // Set up a map for initialization waiters. The base class notifies and clears them when the
        // reply arrives, so the only path that has to do it here is the one where no reply can come.
        this._initWaiters('setup-worker')
        try {
            const commission = this._commissionWorker(
                'setup-worker',
                new Map<string, unknown>([
                    ['config', config],
                ])
            )
            const success = await commission.promise === true
            if (success && config?.packages?.length) {
                this._loadedPackages.push(...config.packages)
            }
            if (!success) {
                // The base class notifies these waiters from the reply, so the one case that has to
                // notify them here is the one where no reply can arrive. Left waiting, they are
                // what `initialSetup` resolves from, and every call that awaits it waits with them.
                this._notifyWaiters('setup-worker', false)
            }
            return success
        } catch (e: unknown) {
            Log.error(`Setting up the Pyodide worker failed: ${this._failed(e).error}.`, SCOPE)
            this._notifyWaiters('setup-worker', false)
            return false
        }
    }

}
