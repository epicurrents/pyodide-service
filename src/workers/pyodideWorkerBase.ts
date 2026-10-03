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

import type { WorkerMessage } from '@epicurrents/core/types'
import type { PyodideAPI } from 'pyodide'
import type { PythonWorkerCommission, RunCodeResult } from '#types'
import { DEFAULT_PYODIDE_INDEX_URL } from '../constants'
import { Log } from 'scoped-event-log'

const SCOPE = 'pyodideWorkerBase'

/**
 * The worker's global scope as this layer uses it: the interpreter the setup commission installs on
 * it, and the arbitrary names a run binds onto it, which is how Pyodide's ``from js import x``
 * reads a parameter. The index signature is what the binding needs; it is also why every access
 * here goes through this one declaration rather than casting the global away at each site.
 */
interface PyodideScope {
    pyodide: PyodideAPI
    [name: string]: unknown
}

/** The worker global, typed as {@link PyodideScope}. */
const scope = () => self as unknown as PyodideScope

/**
 * Names a commission may not bind onto the global scope. A binding is released after the call by
 * deleting the name it was bound under, so a parameter called `pyodide` would replace the
 * interpreter for the duration of the run and then delete it — leaving every later commission to
 * fail on an interpreter that is no longer there.
 */
const RESERVED_NAMES = new Set(['pyodide'])

/**
 * A non-primitive Python result arrives as a proxy into the interpreter's heap: it has to be
 * converted to plain data and then released, or the data behind it stays allocated.
 */
type PyodideProxy = {
    destroy: () => void
    toJs: (options: {
        create_proxies: boolean
        dict_converter: (entries: Iterable<[PropertyKey, unknown]>) => object
    }) => unknown
}

/** The one micropip member this layer calls, which Pyodide hands over as an untyped module proxy. */
type Micropip = {
    install: (packages: string[]) => Promise<void>
}

// ──────────────────────────────────────────────────────────────────────────
// `this`-free runtime helpers (worker global scope only).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Load the Pyodide loader script, runtime, and packages, all from a single
 * configured location.
 *
 * ``indexURL`` drives BOTH the loader (``pyodide.mjs``) and the runtime, so one
 * path — and one pinned version — is the single source of truth. The loader is a dynamic ``import()`` (deferred to here,
 * not module top-level, because the config only arrives with the init message);
 * this is a ``type: 'module'`` worker, required by Pyodide ≥0.27/314.
 *
 * All packages load from the Pyodide distribution at ``indexURL`` via
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
    // inlineWorker call in the setup). The `@vite-ignore` comment keeps the bundler from
    // trying to bundle/resolve the runtime URL — it must stay a native dynamic import
    // of the vendored (or CDN) asset.
    const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`) as typeof import('pyodide')
    const pyodide = scope().pyodide = await loadPyodide({ indexURL })

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
            const micropip = pyodide.pyimport('micropip') as unknown as Micropip
            await micropip.install(extras)
        }
    }
}

/**
 * Run a Python snippet in the worker's Pyodide instance, binding ``context``
 * entries as globals for the duration of the call and releasing them on every
 * path out of it, the one where the code raises included — the global scope
 * outlives the call, so a binding left behind outlives it too.
 *
 * A name the worker itself depends on is refused rather than bound, because the
 * release deletes the names it bound.
 * ``simulateDocument`` stands up a dummy ``window``/``document`` for matplotlib.
 * Pyodide proxies (returned for non-primitive results) are converted to plain
 * objects and destroyed to avoid memory leaks.
 */
export async function runPythonCode (
    code: string,
    context: { [key: string]: unknown },
    simulateDocument = false,
): Promise<RunCodeResult> {
    const bound = [] as string[]
    const release = () => {
        // Unbind the properties that were bound, which is not every property given: a name that
        // was refused is a name something else owns, and deleting it would take that instead.
        for (const key of bound) {
            delete scope()[key]
        }
        if (simulateDocument) {
            delete scope().document
            delete scope().window
        }
    }
    try {
        // Bind properties to allow pyodide access to them.
        for (const key of Object.keys(context)) {
            if (key.includes('__proto__')) {
                Log.warn(`Code param ${key} contains insecure field '__proto__', parameter was ignored.`, SCOPE)
                continue
            }
            if (RESERVED_NAMES.has(key)) {
                Log.warn(`Code param ${key} is reserved by the worker, parameter was ignored.`, SCOPE)
                continue
            }
            scope()[key] = context[key]
            bound.push(key)
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
            scope().document = createDummyEl()
            scope().window = {
                setTimeout: (..._params: unknown[]) => { return 1 },
            }
        }
        const result = await (scope().pyodide.runPython(code) as unknown)
        // For more complex data types, Pyodide returns proxies which are prone to memory leaks.
        const resultIsProxy = !!result && typeof result === 'object'
        const response = resultIsProxy
                        // Convert Map (Pyodide's default conversion type for dict) into Object.
                        // Setting create_proxies to false prevents the creation of nested proxies.
                        ? (result as PyodideProxy).toJs({
                            dict_converter: Object.fromEntries,
                            create_proxies: false,
                        })
                        : result
        if (resultIsProxy) {
            // Destroy the proxy to remove the reference to contained data.
            ;(result as PyodideProxy).destroy()
        }
        if (response && typeof response === 'object' && 'success' in response) {
            // Return the complete response if it contains the success property.
            return response as RunCodeResult
        }
        return {
            success: true,
            result: response,
        }
    } catch (error) {
        // The reason is carried as a string, which is what the reply type declares and what the
        // consumer formats. A Pyodide error object posted in its place survives the clone and then
        // reads as an empty message wherever it is interpolated.
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    } finally {
        // The bindings and the simulated document live on the worker's global scope, which outlives
        // the call, so releasing them belongs on every path out of it. Code that raises is the path
        // that matters: it is also the one that leaves the largest arrays behind.
        release()
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
    _validate <T extends WorkerMessage['data']> (
        data: T, requiredProps: { [name: string]: string | string[] }, requiredSetup?: boolean
    ): false | T
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

        /**
         * Run a handler this layer routes itself, answering the commission if it throws.
         *
         * The base class guards every handler in its action map, because a commission nobody
         * answers leaves the awaiting promise pending for the life of the session. The actions
         * routed here are reached before that guard, so they carry their own.
         * @param message - The message being handled.
         * @param handler - The handler to run for it.
         */
        async _answer (message: WorkerMessage, handler: () => Promise<boolean>) {
            const base = this as unknown as WorkerHelpers
            try {
                return await handler()
            } catch (e: unknown) {
                const reason = e instanceof Error ? e.message : String(e)
                Log.error(`Action '${message.data.action}' threw in the worker: ${reason}`, SCOPE)
                return base._failure(
                    message.data,
                    `Action '${message.data.action}' failed in the worker: ${reason}`
                )
            }
        }

        /** Route a Python commission; setup must precede everything else. */
        async handlePythonMessage (message: WorkerMessage): Promise<boolean> {
            const base = this as unknown as WorkerHelpers
            if (!message?.data?.action) {
                return base._failure(message.data || {}, `Worker commission did not contain data or an action.`)
            }
            if (message.data.action === 'setup-worker') {
                return this._answer(message, () => this.setupWorker(message.data))
            }
            if (!this._isInitialised && message.data.action !== 'shutdown') {
                return base._failure(
                    message.data,
                    'Pyodide must be initialized before any other commissions are issued.'
                )
            }
            if (!this._isInitialised) {
                // Shutting down is the one commission that must not require the interpreter. The
                // service terminates the worker only once this one comes back successful, so
                // refusing it leaves the thread running for the life of the page — and a worker
                // whose runtime never loaded is exactly the one a caller wants to be rid of.
                return base.handleMessage(message)
            }
            await this._awaitLoad()
            return base.handleMessage(message)
        }

        async loadPackages (msgData: WorkerMessage['data']) {
            const base = this as unknown as WorkerHelpers
            const data = base._validate(
                msgData as PythonWorkerCommission['load-packages'],
                {
                    packages: 'Array',
                }
            )
            if (!data) {
                return base._failure(msgData)
            }
            if (!data.packages.length) {
                return base._failure(msgData, `'load-packages' requires a non-empty array of packages to load.`)
            }
            try {
                await scope().pyodide.loadPackage(data.packages)
                return base._success(msgData)
            } catch (error) {
                return base._failure(msgData, (error as Error)?.message ?? String(error))
            }
        }

        async runCode (msgData: WorkerMessage['data']) {
            const base = this as unknown as WorkerHelpers
            const data = base._validate(
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
            const data = base._validate(
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
