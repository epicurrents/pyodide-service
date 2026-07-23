/**
 * Shared Pyodide worker layer: the `this`-free runtime helpers plus the mixin
 * that composes them onto a worker base.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 *
 * Pyodide is licenced under MPL-2.0. Source: https://github.com/pyodide/pyodide/
 *
 * ``PyodideWorker`` and ``PyodideMontageWorker`` need the same Pyodide behaviour
 * but sit on different core bases (``BaseWorker`` vs ``MontageWorker``), so the
 * shared layer is a mixin rather than a common superclass — a class extending
 * ``PyodideWorker`` could not also keep the ``MontageWorker`` signal machinery.
 * ``WithPyodide(Base)`` composes the Pyodide layer onto either base:
 *
 *     class PyodideWorker        extends WithPyodide(BaseWorker)    {}
 *     class PyodideMontageWorker extends WithPyodide(MontageWorker) {}
 *
 * The montage worker overrides ``handlePythonMessage`` to add its setup-montage
 * branch and adds its own signal methods; everything else is inherited from here.
 * The two module-level functions below (``loadPyodideRuntime``, ``runPythonCode``)
 * are the parts that touch nothing but the worker global scope — no ``this`` —
 * kept as plain functions the mixin delegates to.
 */

import { validateCommissionProps } from '@epicurrents/core/dist/util'
import type { WorkerMessage } from '@epicurrents/core/dist/types'
import type { PythonWorkerCommission, RunCodeResult } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = 'pyodideWorkerBase'

// ──────────────────────────────────────────────────────────────────────────
// `this`-free runtime helpers (worker global scope only).
// ──────────────────────────────────────────────────────────────────────────

/** Default upstream Pyodide location, used when no ``indexURL`` is configured. */
export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/'

/**
 * Load the Pyodide loader script, runtime, and the packages common to every
 * context, all from a single configured location.
 *
 * ``indexURL`` (the viewer's ``SETUP.pyodideAssetPath``) drives BOTH the loader
 * script and the runtime, so one path — and one pinned version — is the single
 * source of truth. ``importScripts`` is called here rather than at worker module
 * top-level because the config only arrives with the init message, and it is
 * legal at any time in a classic (iife) worker.
 */
export async function loadPyodideRuntime (
    config?: { indexURL?: string, packages?: string[] },
): Promise<void> {
    const indexURL = config?.indexURL ?? DEFAULT_PYODIDE_INDEX_URL
    importScripts(`${indexURL}pyodide.js`)
    ;(self as any).pyodide = await loadPyodide({ indexURL })
    const packages = ['numpy', 'scipy']
    if (config?.packages?.length) {
        packages.push(...config.packages)
    }
    await (self as any).pyodide.loadPackage(packages)
}

/**
 * Run a Python snippet in the worker's Pyodide instance, binding ``context``
 * entries as globals for the duration of the call and cleaning them up after.
 *
 * ``simulateDocument`` stands up a dummy ``window``/``document`` for matplotlib.
 * Pyodide proxies (returned for non-primitive results) are converted to plain
 * objects and destroyed to avoid memory leaks.
 */
export async function runPythonCode (
    code: string,
    context: { [key: string]: unknown },
    simulateDocument = false,
): Promise<RunCodeResult> {
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

// ──────────────────────────────────────────────────────────────────────────
// The mixin.
// ──────────────────────────────────────────────────────────────────────────

// Abstract construct signature: the core bases (e.g. BaseWorker) are `abstract`,
// and a plain `new (...) => T` signature rejects abstract classes as arguments.
// `abstract new` accepts both; the concrete subclasses (PyodideWorker,
// PyodideMontageWorker) remain instantiable as normal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = object> = abstract new (...args: any[]) => T

/**
 * The BaseWorker response/dispatch helpers the mixin calls. Declared locally and
 * accessed via a cast because they are ``protected`` on the core bases, which a
 * generic mixin constraint cannot see structurally.
 */
interface WorkerHelpers {
    _success (msgData: WorkerMessage['data'], data?: object): boolean
    _failure (msgData: WorkerMessage['data'], reason?: string): boolean
    handleMessage (message: WorkerMessage): Promise<boolean>
}

export function WithPyodide<TBase extends Constructor> (Base: TBase) {
    // Named + `abstract` (TS2797: a mixin over an abstract construct signature must
    // itself be abstract, which a class *expression* can't express). Members are
    // public (TS4094: the library's .d.ts emit can't carry protected/private members
    // of the returned mixin class); the leading underscore still marks them internal.
    abstract class PyodideCapable extends Base {
        _isInitialised = false
        _loadingDone = false
        _loadWaiters = [] as (() => void)[]

        /** Resolve once Pyodide setup has finished (or immediately if already done). */
        _awaitLoad = () => {
            if (this._loadingDone) {
                return Promise.resolve()
            }
            return new Promise<void>((resolve) => {
                this._loadWaiters.push(resolve)
            })
        }

        /**
         * Run Python in this worker's Pyodide. Kept as a field (not a method) so it
         * can be passed as a callback; the body is the shared ``runPythonCode``.
         */
        _runPythonCode = (
            code: string,
            context: { [key: string]: unknown },
            simulateDocument = false,
        ): Promise<RunCodeResult> => runPythonCode(code, context, simulateDocument)

        /** Route a Python commission; setup must precede everything else. */
        async handlePythonMessage (message: WorkerMessage): Promise<boolean> {
            const base = this as unknown as WorkerHelpers
            if (!message?.data?.action) {
                return base._failure(message.data || {}, `Worker commission did not contain data or an action.`)
            }
            if (message.data.action === 'setup-worker') {
                return this.setupWorker(message.data)
            }
            if (!this._isInitialised) {
                return base._failure(
                    message.data,
                    'Pyodide must be initialized before any other commissions are issued.'
                )
            }
            await this._awaitLoad()
            return base.handleMessage(message)
        }

        async loadPackages (msgData: WorkerMessage['data']) {
            const base = this as unknown as WorkerHelpers
            const data = validateCommissionProps(
                msgData as PythonWorkerCommission['load-packages'],
                {
                    packages: 'Array',
                }
            )
            if (!data) {
                return base._failure(msgData)
            }
            if (!data.packages) {
                return base._failure(msgData, 'Load-packages requires a non-empty array of packages to load.')
            }
            try {
                await (self as any).pyodide.loadPackage(msgData.packages)
                return base._success(msgData)
            } catch (error) {
                return base._failure(msgData, error as string)
            }
        }

        async runCode (msgData: WorkerMessage['data']) {
            const base = this as unknown as WorkerHelpers
            const data = validateCommissionProps(
                msgData as PythonWorkerCommission['run-code'],
                {
                    code: 'String',
                }
            )
            if (!data) {
                return base._failure(msgData)
            }
            if (!data.code) {
                return base._failure(msgData, `'run-code' requires a non-empty code string to run.`)
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
                return base._failure(
                    msgData,
                    Array.isArray(response.error) ? response.error.join('. ') : response.error
                )
            } else if ('result' in response) {
                return base._success(msgData, { result: response.result })
            } else {
                return base._success(msgData, { result: response })
            }
        }

        /**
         * Load Pyodide + packages, then mark the worker ready. ``_isInitialised``
         * is set LAST, after loading completes, so no commission slips past the
         * ``handlePythonMessage`` guard mid-setup.
         */
        async setupWorker (msgData: WorkerMessage['data']) {
            const base = this as unknown as WorkerHelpers
            const data = validateCommissionProps(
                msgData as PythonWorkerCommission['setup-worker'],
                {
                    config: 'Object?',
                }
            )
            if (!data) {
                return base._failure(msgData)
            }
            await loadPyodideRuntime(data.config)
            this._loadingDone = true
            for (const resolve of this._loadWaiters) {
                resolve()
            }
            this._isInitialised = true
            return base._success(msgData)
        }
    }
    return PyodideCapable
}
