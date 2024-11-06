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
    type ScriptState,
    type UpdateInputSignalsResponse,
} from '#types'
import { loadPyodide } from 'pyodide/pyodide.js'
import { Log } from 'scoped-event-log'

import biosignal from './scripts/biosignal.py?raw'
const DEFAULT_SCRIPTS = new Map([
    ['biosignal', biosignal],
])

const SCOPE = 'PyodideRunner'
// const MOUNT_DIR = '/mount_dir' // This would be used as mount root in the WASM virtual filesystem.

export default class PyodideRunner extends GenericService implements PythonInterpreterService {
    protected _loadPromise: Promise<boolean> | null
    protected _loadWaiters: ((result: boolean) => void)[] = []
    protected _pyodide: Pyodide | null = null
    /**
     * Some scripts are run only once and kept in memory.
     * This property lists names of scripts that should not be run multiple times and their loading state.
     */
    protected _scripts = {} as { [name: string]: ScriptState }

    constructor (config?: { indexURL?: string, packages?: string[] }) {
        super(SCOPE)
        this._loadPromise = this.initialize(config)
        this._loadPromise.then(() => {
            // Notify possible waithers that loading is done.
            for (const resolve of this._loadWaiters) {
                resolve(true)
            }
            this._loadPromise = null
        })
    }

    get initialSetup () {
        if (!this._loadPromise) {
            return Promise.resolve(true)
        }
        const promise = new Promise<boolean>((resolve) => {
            this._loadWaiters.push(resolve)
        })
        return promise
    }

    async initialize (config?: { indexURL?: string, packages?: string[] }) {
        // Load main Pyodide
        this._pyodide = await loadPyodide({
            indexURL: config?.indexURL || "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
        })
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
        await this._pyodide?.loadPackage(packages)
        return true
    }

    /**
     * Run the provided piece of `code` with the given `parameters`.
     * @param code - Python code as a string.
     * @param params - Parameters for execution passed to the python script.
     * @param scriptDeps - Scripts that this core depends on.
     */
    async runCode (code: string, params?: { [key: string]: unknown }, scriptDeps: string[] = []) {
        await this.initialSetup
        const invalidScriptStates = ['not_loaded', 'error']
        for (const dep of scriptDeps) {
            if (this._scripts[dep]) {
                if (invalidScriptStates.includes(this._scripts[dep].state)) {
                    return {
                        success: false,
                        error: `Cannot run code, dependency script has not loaded yet.`
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
        try {
            const result = await this._pyodide?.runPythonAsync(code)
            return {
                success: true,
                result: result,
            }
        } catch (e) {
            return {
                success: false,
                error: e as string
            }
        }
    }

    /**
     * Load and run the `script` using the given `parameters`.
     * @param name - Name of the script.
     * @param script - Script contents.
     * @param params - Parameters for execution passed to the python script.
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
        this._initWaiters(`script:${name}`)
        const newScript = {
            params: { ...params },
            state: 'loading',
        } as ScriptState
        this._scripts[name] = newScript
        const response = await this.runCode(script, params)
        if (name in this._scripts) {
            Log.debug(`Script ${name} loaded.`, SCOPE)
            this._scripts[name].state = 'loaded'
            this._notifyWaiters(`script:${name}`, true)
        }
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
            const dirHandle = await window.showDirectoryPicker({ mode: "read" })
            console.log(dirHandle.name, script)
        } catch (e: unknown) {
            Log.error("Unable to read directory.", SCOPE, e as Error)
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
            const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" })
            console.log(dirHandle.name, script)
        } catch (e: unknown) {
            Log.error("Unable to read and write directory.", SCOPE, e as Error)
        }
    }

    async setupBiosignalRecording () {
        return {
            success: false,
            error: `Not yet implemented.`
        }
    }
    
    async updateInputSignals () {
        await this.initialSetup
        const commission = this._commissionWorker('update-input-signals')
        const response = await commission.promise as UpdateInputSignalsResponse
        return response
    }
}
