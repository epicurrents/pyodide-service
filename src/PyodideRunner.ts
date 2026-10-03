/**
 * Pyodide runner. This class extends service but performs its actions in the main thread instead of using workers.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

import { GenericService } from '@epicurrents/core'
import {
    type PythonInterpreterService,
    type RunCodeResult,
    type ScriptState,
} from '#types'
import { DEFAULT_PYODIDE_INDEX_URL } from './constants'
import type { PyodideAPI } from 'pyodide'
import { Log } from 'scoped-event-log'

import biosignal from './scripts/biosignal.py?raw'
const DEFAULT_SCRIPTS = new Map([
    ['biosignal', biosignal],
])

const SCOPE = 'PyodideRunner'

/**
 * The window as this class uses it: the arbitrary names a run binds onto it, which is how Pyodide's
 * ``from js import x`` reads a parameter. Every access goes through this one declaration rather
 * than casting the global away at each site.
 */
const scope = () => window as unknown as { [name: string]: unknown }
// const MOUNT_DIR = '/mount_dir' // This would be used as mount root in the WASM virtual filesystem.

export default class PyodideRunner extends GenericService implements PythonInterpreterService {
    /** Did the interpreter load. Read by {@link initialSetup} once the load has settled. */
    protected _loaded = false
    protected _loadPromise: Promise<boolean> | null
    protected _loadWaiters: ((result: boolean) => void)[] = []
    protected _pyodide: PyodideAPI | null = null
    /**
     * Some scripts are run only once and kept in memory.
     * This property lists names of scripts that should not be run multiple times and their loading state.
     */
    protected _scripts = {} as { [name: string]: ScriptState }

    constructor (config?: { indexURL?: string, packages?: string[] }) {
        super(SCOPE)
        this._loadPromise = this.initialize(config)
        // Nothing awaits the constructor, so the waiters are the only channel the result has — and
        // the load is a remote fetch, so the failing branch is the one that must reach them. Left
        // unsettled they wait for the session, and every call that awaits the setup waits with them.
        void this._loadPromise.then(
            () => {
                this._settleLoad(true)
            },
            (reason: unknown) => {
                Log.error(
                    `Loading the Pyodide runtime failed: ${reason instanceof Error ? reason.message : 'unknown'}.`,
                    SCOPE
                )
                this._settleLoad(false)
            }
        )
    }

    get initialSetup () {
        if (!this._loadPromise) {
            return Promise.resolve(this._loaded)
        }
        const promise = new Promise<boolean>((resolve) => {
            this._loadWaiters.push(resolve)
        })
        return promise
    }

    /**
     * Record the outcome of the interpreter load and release everything waiting for it.
     * @param result - Did the interpreter load.
     */
    protected _settleLoad (result: boolean) {
        this._loaded = result
        this._loadPromise = null
        while (this._loadWaiters.length) {
            this._loadWaiters.shift()?.(result)
        }
    }

    async initialize (config?: { indexURL?: string, packages?: string[] }) {
        const indexURL = config?.indexURL || DEFAULT_PYODIDE_INDEX_URL
        // Load Pyodide from the served / CDN distribution at runtime. The @vite-ignore hint keeps the
        // ~200 kB loader (and its Node-only code paths) out of the bundle; the `pyodide` dependency is
        // retained for its type exports only, imported above with `import type`.
        const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`) as typeof import('pyodide')
        this._pyodide = await loadPyodide({ indexURL })
        // Load packages that are common to all contexts.
        await this._pyodide?.loadPackage(['numpy', 'scipy'].concat(...(config?.packages || [])))
        return true
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

    /**
     * Load the given packages into the Python interpreter.
     * @param packages - Array of package names to load.
     */
    async loadPackages (packages: string[]) {
        await this.initialSetup
        if (!this._pyodide) {
            Log.error(`Cannot load packages, the Python interpreter is not available.`, SCOPE)
            return false
        }
        await this._pyodide.loadPackage(packages)
        return true
    }

    // There is no channel to post to, so nothing is awaited; the signature is the interface's.
    // eslint-disable-next-line @typescript-eslint/require-await
    async postMessage (_message: unknown, _scriptDeps?: string[], _transferList?: Transferable[]) {
        // This is not a worker, no messages to post.
        return
    }

    /**
     * Run the provided piece of `code` with the given `parameters`.
     * @param code - Python code as a string.
     * @param params - Parameters for execution passed to the python script.
     * @param scriptDeps - Scripts that this core depends on.
     */
    async runCode (
        code: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = []
    ): Promise<RunCodeResult> {
        await this.initialSetup
        const invalidScriptStates = ['not_loaded', 'error']
        for (const dep of scriptDeps) {
            if (this._scripts[dep]) {
                if (invalidScriptStates.includes(this._scripts[dep].state)) {
                    return {
                        success: false,
                        error: `Cannot run code, dependency script '${dep}' has not been loaded.`
                    }
                } else if (this._scripts[dep].state === 'loading') {
                    if (!(await this.awaitAction(`script:${dep}`))) {
                        return {
                            success: false,
                            error: `Cannot run code, dependency script loading failed.`
                        }
                    }
                }
            }
        }
        if (!this._pyodide) {
            // Without this the call returns the interpreter's answer to nothing at all, which is
            // `undefined` with a success beside it — a result the caller cannot tell from a real one.
            return {
                success: false,
                error: `Cannot run code, the Python interpreter is not available.`
            }
        }
        const bound = [] as string[]
        for (const key in params) {
            // Check for prototype injection attempt.
            if (key.includes('__proto__')) {
                Log.warn(`Code param ${key} contains insecure field '__proto__', parameter was ignored.`, SCOPE)
                continue
            }
            scope()[key] = params[key]
            bound.push(key)
        }
        try {
            const result: unknown = await this._pyodide.runPythonAsync(code)
            return {
                success: true,
                result: result,
            }
        } catch (e) {
            return {
                success: false,
                error: e as string
            }
        } finally {
            // The parameters are bound onto the window, which outlives the call. Anything left
            // there keeps whatever it refers to alive for the session — the signal arrays of a
            // montage derivation, in the heaviest case — and shadows the window property of the
            // same name for every later reader.
            for (const key of bound) {
                delete scope()[key]
            }
        }
    }

    /**
     * Load and run the `script` using the given `parameters`.
     * @param name - Name of the script.
     * @param script - Script contents.
     * @param params - Parameters for execution passed to the python script.
     */
    async runScript (
        name: string,
        script: string,
        params: { [key: string]: unknown } = {},
        scriptDeps: string[] = []
    ): Promise<RunCodeResult> {
        const state = this._scripts[name]?.state
        if (state === 'loaded') {
            Log.debug(`Script ${name} has already been loaded.`, SCOPE)
            return { success: true }
        }
        if (state === 'loading') {
            // The run already in flight is the one that will answer. Reporting success here instead
            // tells the caller the definitions are available while the script is still running.
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
        // The recorded state is what every dependent reads, so it records what happened: a script
        // marked loaded after a failed run sends its dependents to call definitions the interpreter
        // does not have.
        if (this._scripts[name]) {
            this._scripts[name].state = response.success ? 'loaded' : 'error'
        }
        this._notifyWaiters(`script:${name}`, response.success)
        return response
    }

    /**
     * This is an experiment for local file system read access.
     * @param script - Script to execute.
     */
    async runWithReadAccess (script: string) {
        if (typeof window.showDirectoryPicker !== 'function') {
            Log.error(`File system access not available, cannot open folder.`, SCOPE)
            return
        }
        try {
            // This is an experiment for possible local file access implementation.
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' })
            Log.debug(`Opened directory ${dirHandle.name} for ${script}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Unable to read directory.`, SCOPE, e as Error)
        }
    }

    /**
     * This is an experiment for local file system read/write access.
     * @param script - Script to execute.
     */
    async runWithReadWriteAccess (script: string) {
        if (typeof window.showDirectoryPicker !== 'function') {
            Log.error(`File system access not available, cannot open folder.`, SCOPE)
            return
        }
        try {
            // This is an experiment for possible local file access implementation.
            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
            Log.debug(`Opened directory ${dirHandle.name} for ${script}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Unable to read and write directory.`, SCOPE, e as Error)
        }
    }

    // The signature is the one a caller expects of it; there is nothing to await yet.
    // eslint-disable-next-line @typescript-eslint/require-await
    async setupBiosignalRecording () {
        return {
            success: false,
            error: `Not yet implemented.`
        }
    }

}
