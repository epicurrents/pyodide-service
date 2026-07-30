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
export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/'

/**
 * Load the Pyodide loader script, runtime, and packages, all from a single
 * configured location.
 *
 * ``indexURL`` (the viewer's ``SETUP.pyodideAssetPath``) drives BOTH the loader
 * (``pyodide.mjs``) and the runtime, so one path — and one pinned version — is the
 * single source of truth. The loader is a dynamic ``import()`` (deferred to here,
 * not module top-level, because the config only arrives with the init message);
 * this is a ``type: 'module'`` worker, required by Pyodide ≥0.27/314.
 *
 * All packages load from the Pyodide **distribution** at ``indexURL`` via
 * ``loadPackage`` — including mne. mne is un-bundled from upstream Pyodide since
 * 0.28, so this deployment re-adds it to its *own* ``pyodide-lock.json`` (mne's
 * wheel + pure-Python dependency closure co-located in the dist folder). Because
 * the lock encodes dependencies, ``loadPackage`` resolves the whole tree from the
 * folder offline — no micropip, no PyPI. See ``recordings``/deploy docs for the
 * lock-extension build step.
 */
export async function loadPyodideRuntime (
    config?: { indexURL?: string, packages?: string[] },
): Promise<void> {
    // Resolve to an absolute, same-origin URL first: `import()` and Pyodide's own
    // `new URL(indexURL)` both need an absolute base, and a root-relative configured
    // path (e.g. /vendor/pyodide/…/) would otherwise throw. `self.location.origin`
    // is the app origin even when the worker runs from a blob: URL.
    const toAbsolute = (u: string) => new URL(u, self.location.origin).href
    let indexURL = toAbsolute(config?.indexURL ?? DEFAULT_PYODIDE_INDEX_URL)
    if (!indexURL.endsWith('/')) {
        indexURL += '/'
    }
    // Pyodide ≥0.27/314 ships an ES module and dropped classic-worker support, so we
    // dynamic-import pyodide.mjs (this is a `type: 'module'` worker — see the
    // inlineWorker call in the setup). The `webpackIgnore` comment keeps webpack from
    // trying to bundle/resolve the runtime URL — it must stay a native dynamic import
    // of the vendored (or CDN) asset.
    const { loadPyodide } = await import(/* webpackIgnore: true */ `${indexURL}pyodide.mjs`)
    const pyodide = (self as any).pyodide = await loadPyodide({ indexURL })

    // Package loading depends on whether the distribution is self-hosted.
    //
    // Self-hosted (config.indexURL set): this deployment's own pyodide-lock.json
    // co-locates mne + its full dependency closure alongside numpy/scipy, so a
    // single loadPackage resolves everything from the lock — offline, no PyPI.
    //
    // Upstream CDN (no config.indexURL — the DEFAULT_PYODIDE_INDEX_URL fallback):
    // the official distribution lock carries numpy/scipy but NOT mne (un-bundled
    // since 0.28). So load the distribution packages via loadPackage, then
    // micropip-install the extras from PyPI. micropip transparently uses the dist
    // lock for any extra that IS in it (e.g. matplotlib) and PyPI for the rest
    // (mne + its deps), so it copes with a mixed list. This path needs the network
    // — acceptable, since reaching the CDN already does; offline compute requires
    // the self-hosted branch.
    const extras = config?.packages ?? []
    if (config?.indexURL) {
        await pyodide.loadPackage(['numpy', 'scipy', ...extras])
    } else {
        await pyodide.loadPackage(['numpy', 'scipy'])
        if (extras.length) {
            await pyodide.loadPackage('micropip')
            const micropip = pyodide.pyimport('micropip')
            await micropip.install(extras)
        }
    }
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
            try {
                await loadPyodideRuntime(data.config)
            } catch (e: unknown) {
                // The runtime load is a remote fetch (pyodide.mjs + packages). On failure, unblock
                // any queued waiters so their awaiting run-code/load-packages commissions do not hang;
                // _isInitialised stays false, so they then fail the not-initialised guard cleanly
                // rather than running against a half-loaded runtime.
                this._loadingDone = true
                for (const resolve of this._loadWaiters) {
                    resolve()
                }
                Log.error(`Loading the Pyodide runtime failed: ${(e as Error).message}.`, SCOPE)
                return base._failure(msgData, (e as Error).message)
            }
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
