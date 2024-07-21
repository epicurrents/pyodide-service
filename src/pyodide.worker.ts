/**
 * Pyodide worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

/* eslint-disable */

import { Log } from 'scoped-ts-log'

importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js")

const SCOPE = "PyodideWorker"

async function loadPyodideAndPackages (config?: { indexURL?: string, packages?: string[] }) {
    // Load main Pyodide from CDN, but packages locally to avoid throttling.
    (self as any).pyodide = await loadPyodide({
        indexURL: config?.indexURL,
    })
    // Load packages that are common to all contexts.
    const packages = ['numpy', 'scipy']
    if (config?.packages?.length) {
        packages.push(...config.packages)
    }
    await (self as any).pyodide.loadPackage(packages)
}
let initialized = false
// Allow waiting for the loading process to complete.
let loadingDone = false
const loadWaiters = [] as (() => void)[]
const awaitLoad = () => {
    if (loadingDone) {
        return Promise.resolve()
    }
    const promise = new Promise<void>((resolve) => {
        loadWaiters.push(resolve)
    })
    return promise
}

self.onmessage = async (event) => {
    const { rn, action, ...context } = event.data
    if (action === 'initialize') {
        initialized = true
        loadPyodideAndPackages(context.config).then(() => {
            loadingDone = true
            for (const resolve of loadWaiters) {
                resolve()
            }
            postMessage({
                rn: rn,
                action: 'initialize',
                success: true,
            })
        })
        return
    }
    // Initialize must be called before anything else.
    if (!initialized) {
        postMessage({
            rn: rn,
            action: action,
            error: 'Pyodide must be initialized before any other commissions are issued.',
            success: false,
        })
        return
    }
    // Make sure loading is done.
    await awaitLoad()
    // Bind properties to allow pyodide access to them.
    for (const key of Object.keys(context)) {
        if (key.includes('__proto__')) {
            Log.warn(`Code param ${key} contains insecure field '_proto__', parameter was ignored.`, SCOPE)
            continue
        }
        (self as any)[key] = context[key]
    }
    if (action === 'load-packages') {
        if (!context.packages) {
            postMessage({
                rn: rn,
                action: 'load-packages',
                error: 'Load-packages requires a non-empty array of packages to load.',
                success: false,
            })
            return
        }
        try {
            await (self as any).pyodide.loadPackage(context.packages)
            self.postMessage({
                rn: rn,
                success: true,
                action: 'load-packages',
            })
        } catch (error) {
            self.postMessage({
                rn: rn,
                success: false,
                action: 'load-packages',
                error: error,
            })
        }
    } else if (action === 'run-code') {
        if (!context.code) {
            postMessage({
                rn: rn,
                action: 'run-code',
                error: 'Run-code requires a non-empty code string to run.',
                success: false,
            })
            return
        }
        try {
            if (context.simulateDocument) {
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
            const runCode = (self as any).pyodide.runPython(context.code)
            const results = await runCode
            // Undo document simulation.
            if (context.simulateDocument) {
                ;(self as any).document = undefined
                ;(self as any).window = undefined
            }
            self.postMessage({
                rn: rn,
                success: true,
                action: 'run-code',
                result: results,
            })
        } catch (error) {
            self.postMessage({
                rn: rn,
                success: false,
                action: 'run-code',
                error: error,
            })
        }
    }
    // Unbind properties.
    for (const key of Object.keys(context)) {
        if (key.includes('__proto__')) {
            continue
        }
        (self as any)[key] = undefined
    }
}
