// @vitest-environment jsdom
/**
 * Tests for the main-thread runner, the variant that holds its own interpreter instead of
 * commissioning a worker.
 *
 * What it stands in for is replaced in one place only: `initialize` ends in a dynamic `import()` of
 * `pyodide.mjs` from a distribution folder, which no test environment serves, so the subclass below
 * hands over the interpreter double instead. Everything the runner then does with it is the real
 * code, including the part that matters most here — it binds a call's parameters onto the window,
 * where anything it fails to release outlives the call.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PyodideAPI } from 'pyodide'
import { api, behaviour, interpreter, reset, watchedKeys } from './pyodideDouble'
import { settle } from './loopback'

const { EventBus } = await import('@epicurrents/core')
const PyodideRunner = (await import('#root/src/PyodideRunner')).default

/** The runner with its interpreter handed over rather than fetched. */
class TestRunner extends PyodideRunner {
    override async initialize () {
        this._pyodide = api as unknown as PyodideAPI
        return true
    }
}

const makeRunner = async () => {
    const runner = new TestRunner()
    await runner.initialSetup
    await settle()
    return runner
}

describe('PyodideRunner', () => {
    beforeEach(() => {
        reset()
        ;(window as unknown as { __EPICURRENTS__: unknown }).__EPICURRENTS__ = {
            APP: {},
            EVENT_BUS: new EventBus(),
            RUNTIME: {
                SETTINGS: {
                    app: {},
                    modules: {},
                    _CLONABLE: { app: {}, modules: {} },
                    removeAllPropertyUpdateHandlersFor: () => undefined,
                },
            },
        }
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('runs the code and returns the result', async () => {
        const runner = await makeRunner()
        behaviour.results.set('two()', 2)
        await expect(runner.runCode('two()')).resolves.toMatchObject({ success: true, result: 2 })
    })

    it('reports the cause when the code raises', async () => {
        const runner = await makeRunner()
        behaviour.raiseOn.add('boom()')
        await expect(runner.runCode('boom()')).resolves.toMatchObject({ success: false })
    })

    it('binds the parameters for the call and releases them afterwards', async () => {
        const runner = await makeRunner()
        watchedKeys.push('fs')
        await runner.runCode('psd()', { fs: 100 })
        expect(interpreter.scope[0]).toEqual({ fs: 100 })
        expect('fs' in window).toEqual(false)
    })

    it('releases the parameters it bound when the code raises', async () => {
        const runner = await makeRunner()
        behaviour.raiseOn.add('boom()')
        await runner.runCode('boom()', { fs: 100 })
        expect('fs' in window).toEqual(false)
    })

    it('does not bind a parameter that reaches for the prototype', async () => {
        const runner = await makeRunner()
        watchedKeys.push('__proto__polluted')
        await runner.runCode('one()', { ['__proto__polluted']: 1 })
        expect(interpreter.scope[0]).toEqual({})
    })

    it('runs a script once and reports the second call as loaded', async () => {
        const runner = await makeRunner()
        await runner.runScript('psd', 'psd_script()', {})
        await runner.runScript('psd', 'psd_script()', {})
        expect(interpreter.code.filter(code => code === 'psd_script()')).toHaveLength(1)
    })

    it('runs a failed script again instead of reporting it loaded', async () => {
        const runner = await makeRunner()
        behaviour.raiseOn.add('psd_script()')
        await expect(runner.runScript('psd', 'psd_script()', {})).resolves.toMatchObject({ success: false })
        behaviour.raiseOn.clear()
        await expect(runner.runScript('psd', 'psd_script()', {})).resolves.toMatchObject({ success: true })
        expect(interpreter.code.filter(code => code === 'psd_script()')).toHaveLength(2)
    })

    it('waits for a script already loading instead of reporting it loaded', async () => {
        const runner = await makeRunner()
        behaviour.raiseOn.add('psd_script()')
        const first = runner.runScript('psd', 'psd_script()', {})
        const second = runner.runScript('psd', 'psd_script()', {})
        await first
        await expect(second).resolves.toMatchObject({ success: false })
    })

    it('loads packages through the interpreter', async () => {
        const runner = await makeRunner()
        await expect(runner.loadPackages(['mne'])).resolves.toEqual(true)
        expect(interpreter.loaded).toContainEqual(['mne'])
    })

    it('settles the setup and refuses to run when the interpreter cannot be loaded', async () => {
        class FailingRunner extends PyodideRunner {
            // The annotation is the base class signature: a body that only throws is inferred as
            // returning never, which does not satisfy it.
            override async initialize (): Promise<boolean> {
                // The real one fetches the runtime; this is the failing fetch, which is the branch
                // that leaves nothing for a waiter to resolve from.
                throw new Error('the distribution could not be reached')
            }
        }
        const runner = new FailingRunner()
        await expect(runner.initialSetup).resolves.toEqual(false)
        // Again once the load has settled, which is the branch that answers from the record of it
        // rather than from a waiter.
        await settle()
        await expect(runner.initialSetup).resolves.toEqual(false)
        await expect(runner.runCode('one()')).resolves.toMatchObject({ success: false })
        await expect(runner.loadPackages(['mne'])).resolves.toEqual(false)
        expect(interpreter.code).toEqual([])
    })

    it('reports a default script that does not exist', async () => {
        const runner = await makeRunner()
        await expect(runner.loadDefaultScript('nope')).resolves.toMatchObject({ success: false })
    })
})
