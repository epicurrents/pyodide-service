/**
 * A stand-in for the Pyodide interpreter.
 *
 * The real one is a WebAssembly runtime fetched from a distribution folder and driven through
 * proxies, neither of which a test environment has. What the worker layer actually depends on is a
 * small surface — `loadPackage`, `runPython`, `pyimport('micropip')` — and the proxy protocol for a
 * non-primitive result, which is what {@link proxy} reproduces: a result that must be converted
 * with `toJs` and then destroyed, so a test can tell whether the worker released it.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

/** What the interpreter was asked to do, in order. */
export const interpreter = {
    /** Code strings passed to `runPython`. */
    code: [] as string[],
    /** Package lists passed to `loadPackage`. */
    loaded: [] as (string | string[])[],
    /** Package lists passed to micropip. */
    micropip: [] as unknown[],
    /** Proxy results the worker destroyed. */
    destroyed: [] as unknown[],
    /**
     * The globals Python could see at the moment each `runPython` call ran. The worker binds a
     * commission's parameters onto the global scope for the duration of the call, so this is what
     * says whether a parameter arrived — and comparing it against the scope afterwards is what says
     * whether it was released.
     */
    scope: [] as { [key: string]: unknown }[],
}

/** What the interpreter answers. A test sets only the part its case is about. */
export const behaviour = {
    /** Code strings that raise instead of returning. */
    raiseOn: new Set<string>(),
    /** Results by code string; a missing entry answers with `undefined`. */
    results: new Map<string, unknown>(),
    /** Make `loadPackage` reject with this message. */
    packageError: null as string | null,
}

/**
 * Wrap `value` as the interpreter wraps a non-primitive result: the worker has to convert it and
 * then destroy it, and a destroyed proxy is recorded in {@link interpreter}.
 */
export const proxy = (value: unknown) => {
    const handle = {
        toJs: () => value,
        destroy: () => {
            interpreter.destroyed.push(value)
        },
    }
    return handle
}

/** The keys the worker binds onto the global scope, so a test can read them back. */
const scopeSnapshot = (keys: string[]) => {
    const seen = {} as { [key: string]: unknown }
    for (const key of keys) {
        if (key in (globalThis as unknown as { [key: string]: unknown })) {
            seen[key] = (globalThis as unknown as { [key: string]: unknown })[key]
        }
    }
    return seen
}

/** Keys bound by the test's own commissions, watched for the scope snapshot. */
export const watchedKeys = [] as string[]

/** The interpreter API the worker layer uses. */
export const api = {
    loadPackage: (packages: string | string[]) => {
        interpreter.loaded.push(packages)
        if (behaviour.packageError) {
            return Promise.reject(new Error(behaviour.packageError))
        }
        return Promise.resolve()
    },
    pyimport: (name: string) => {
        if (name !== 'micropip') {
            throw new Error(`The double has no module '${name}'.`)
        }
        return {
            install: (packages: unknown) => {
                interpreter.micropip.push(packages)
                return Promise.resolve()
            },
        }
    },
    runPython: (code: string) => {
        interpreter.code.push(code)
        interpreter.scope.push(scopeSnapshot(watchedKeys))
        if (behaviour.raiseOn.has(code)) {
            throw new Error(`Python raised for '${code}'.`)
        }
        return behaviour.results.get(code)
    },
    runPythonAsync: (code: string) => {
        return Promise.resolve(api.runPython(code))
    },
}

/** Put the interpreter where the worker layer expects to find it. */
export const install = () => {
    ;(globalThis as unknown as { pyodide: unknown }).pyodide = api
}

/** Take it away again, as a worker that never completed its setup would have it. */
export const uninstall = () => {
    delete (globalThis as unknown as { pyodide?: unknown }).pyodide
}

/** Forget every recorded interaction and configured answer. */
export const reset = () => {
    interpreter.code.length = 0
    interpreter.loaded.length = 0
    interpreter.micropip.length = 0
    interpreter.destroyed.length = 0
    interpreter.scope.length = 0
    behaviour.raiseOn.clear()
    behaviour.results.clear()
    behaviour.packageError = null
    watchedKeys.length = 0
}
