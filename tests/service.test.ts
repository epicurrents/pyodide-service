// @vitest-environment jsdom
/**
 * Tests for the main-thread half of the service, driven against the real worker.
 *
 * The cases are about the service's side of the commission contract: what it sends, what it answers
 * when a commission is refused, and what it remembers afterwards. The worker is the real one (see
 * loopback.ts), so a commission the worker would not accept fails here rather than passing against
 * a double built to accept it.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { behaviour, interpreter, reset, watchedKeys } from './pyodideDouble'
import { LoopbackWorker, settle } from './loopback'

const { EventBus } = await import('@epicurrents/core')
const PyodideService = (await import('#root/src/PyodideService')).default

let loopback: LoopbackWorker

/** Has the promise settled, or is its caller still waiting on it? */
const settled = async (promise: Promise<unknown>) => {
    const pending = Symbol('pending')
    const outcome = await Promise.race([
        promise.then(value => value, error => error as unknown),
        settle(40).then(() => pending),
    ])
    return outcome !== pending
}

const makeService = async () => {
    const service = new PyodideService()
    await settle()
    return service
}

/** A service with its interpreter set up, which is the state every commission but setup needs. */
const readyService = async () => {
    const service = await makeService()
    await service.setupWorker({ packages: ['mne'] })
    return service
}

describe('PyodideService', () => {
    beforeEach(() => {
        reset()
        loopback = new LoopbackWorker()
        ;(window as unknown as { __EPICURRENTS__: unknown }).__EPICURRENTS__ = {
            // `APP` and `EVENT_BUS` are what every asset's constructor looks for, and the service is
            // an asset; without them it falls back to a bus of its own and logs the absence.
            APP: {},
            EVENT_BUS: new EventBus(),
            RUNTIME: {
                SETTINGS: {
                    app: {},
                    modules: {},
                    _CLONABLE: { app: {}, modules: {} },
                    removeAllPropertyUpdateHandlersFor: () => undefined,
                },
                getWorkerOverride: () => loopback as unknown as Worker,
            },
        }
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('setup', () => {
        it('passes the configuration to the worker', async () => {
            await readyService()
            expect(loopback.postedFor('setup-worker')[0].config).toEqual({ packages: ['mne'] })
        })

        it('reports a failed setup instead of rejecting', async () => {
            const service = await makeService()
            loopback.failSetup = true
            await expect(service.setupWorker({})).resolves.toEqual(false)
        })

        it('does not record the configured packages as loaded when the setup fails', async () => {
            const service = await makeService()
            loopback.failSetup = true
            await service.setupWorker({ packages: ['mne'] })
            loopback.failSetup = false
            await service.setupWorker({})
            await service.loadPackages(['mne'])
            expect(interpreter.loaded).toContainEqual(['mne'])
        })

        it('resolves the initial setup once the worker has answered', async () => {
            const service = await readyService()
            await expect(service.initialSetup).resolves.toEqual(true)
        })
    })

    describe('runCode', () => {
        it('runs the code and returns the result', async () => {
            const service = await readyService()
            behaviour.results.set('two()', 2)
            await expect(service.runCode('two()')).resolves.toMatchObject({ success: true, result: 2 })
        })

        it('binds the parameters as Python globals for the duration of the call', async () => {
            const service = await readyService()
            watchedKeys.push('fs')
            await service.runCode('psd()', { fs: 100 })
            expect(interpreter.scope[0]).toEqual({ fs: 100 })
            expect('fs' in globalThis).toEqual(false)
        })

        it('resolves a refused commission with its cause rather than rejecting', async () => {
            const service = await readyService()
            behaviour.raiseOn.add('boom()')
            await expect(service.runCode('boom()')).resolves.toMatchObject({
                success: false,
                error: expect.stringContaining('Python raised'),
            })
        })
    })

    describe('runScript', () => {
        it('runs a script once and reports the second call as loaded', async () => {
            const service = await readyService()
            await service.runScript('psd', 'psd_script()')
            await service.runScript('psd', 'psd_script()')
            expect(interpreter.code.filter(code => code === 'psd_script()')).toHaveLength(1)
        })

        it('runs a failed script again instead of reporting it loaded', async () => {
            const service = await readyService()
            behaviour.raiseOn.add('psd_script()')
            await expect(service.runScript('psd', 'psd_script()')).resolves.toMatchObject({ success: false })
            behaviour.raiseOn.clear()
            await expect(service.runScript('psd', 'psd_script()')).resolves.toMatchObject({ success: true })
            expect(interpreter.code.filter(code => code === 'psd_script()')).toHaveLength(2)
        })

        it('settles the dependents of a failed script instead of leaving them waiting', async () => {
            const service = await readyService()
            behaviour.raiseOn.add('psd_script()')
            await service.runScript('psd', 'psd_script()')
            const dependent = service.runCode('psd_welch()', {}, ['psd'])
            expect(await settled(dependent)).toEqual(true)
            await expect(dependent).resolves.toMatchObject({ success: false })
        })

        it('joins a load already in flight instead of running the script twice', async () => {
            const service = await readyService()
            const first = service.runScript('psd', 'psd_script()')
            const second = service.runScript('psd', 'psd_script()')
            await expect(first).resolves.toMatchObject({ success: true })
            await expect(second).resolves.toMatchObject({ success: true })
            expect(interpreter.code.filter(code => code === 'psd_script()')).toHaveLength(1)
        })

        it('accepts a dependency that has loaded beside one still loading', async () => {
            const service = await readyService()
            await service.runScript('first', 'first_script()')
            // The second script is still in flight: its commission has been sent and not answered,
            // which is the state a dependent has to wait through.
            const loading = service.runScript('second', 'second_script()')
            const dependent = service.runCode('needs_both()', {}, ['first', 'second'])
            await loading
            await expect(dependent).resolves.toMatchObject({ success: true })
        })
    })

    describe('loadPackages', () => {
        it('loads the packages it has not loaded before', async () => {
            const service = await readyService()
            await expect(service.loadPackages(['scipy'])).resolves.toEqual(true)
            // Nothing left to load is success, and no commission at all: a commission for an empty
            // list is one the worker refuses, which would report a loaded package as missing.
            await expect(service.loadPackages(['scipy'])).resolves.toEqual(true)
            expect(interpreter.loaded.filter(packages => Array.isArray(packages))).toHaveLength(1)
            expect(loopback.postedFor('load-packages')).toHaveLength(1)
        })

        it('reports a refused load instead of rejecting, and tries again later', async () => {
            const service = await readyService()
            behaviour.packageError = 'no such package'
            await expect(service.loadPackages(['nope'])).resolves.toEqual(false)
            behaviour.packageError = null
            await service.loadPackages(['nope'])
            expect(interpreter.loaded.filter(packages => Array.isArray(packages))).toHaveLength(2)
        })
    })

    describe('the commission map', () => {
        it('releases a commission once it has been settled', async () => {
            const service = await readyService()
            await service.runCode('one()')
            await service.runCode('two()')
            // The map is read directly: nothing public reports it, and an entry left behind is a
            // resolve/reject pair held for the life of the service, one per commission sent.
            const commissions = (service as unknown as {
                _commissions: Map<string, Map<number, unknown>>
            })._commissions
            expect(commissions.get('run-code')?.size ?? 0).toEqual(0)
        })
    })

    describe('postMessage', () => {
        it('posts nothing when a dependency failed to load', async () => {
            const service = await readyService()
            behaviour.raiseOn.add('psd_script()')
            await service.runScript('psd', 'psd_script()')
            const before = loopback.posted.length
            await service.postMessage({ action: 'whatever' }, ['psd'])
            expect(loopback.posted).toHaveLength(before)
        })
    })

    describe('shutdown', () => {
        it('releases the worker once it has answered', async () => {
            const service = await readyService()
            await service.shutdown()
            expect(loopback.closed).toEqual(true)
            expect(loopback.terminated).toEqual(true)
        })

        it('reports a failure for a call made after the service has been shut down', async () => {
            const service = await readyService()
            await service.shutdown()
            // There is no worker to carry the commission, and the base class answers that with
            // null rather than with a rejection, so this is the one path where the absence of a
            // reply has to be turned into one.
            await expect(service.runCode('one()')).resolves.toMatchObject({ success: false })
            await expect(service.setupWorker({})).resolves.toEqual(false)
            await expect(service.loadPackages(['numpy'])).resolves.toEqual(false)
            await expect(service.setInputMutex({} as never, 10, 100)).resolves.toMatchObject({
                success: false,
            })
            // The setup above answered nothing, so its waiters are the ones that would otherwise
            // leave `initialSetup` — and every call that awaits it — waiting for the session.
            await expect(service.initialSetup).resolves.toBeFalsy()
        })

        it('releases a worker whose interpreter was never set up', async () => {
            const service = await makeService()
            await service.shutdown()
            expect(loopback.terminated).toEqual(true)
        })
    })

    describe('setInputMutex', () => {
        it('returns the shared buffers the worker answers with', async () => {
            const service = await readyService()
            loopback.answering.set('setup-input-mutex', { cacheProperties: { start: 0, end: 10 } })
            await expect(service.setInputMutex({} as never, 10, 100)).resolves.toMatchObject({
                success: true,
                cacheProperties: { start: 0, end: 10 },
            })
        })

        it('reports the refusal when no montage has been set up', async () => {
            const service = await readyService()
            await expect(service.setInputMutex({} as never, 10, 100)).resolves.toMatchObject({
                success: false,
            })
            expect(loopback.postedFor('setup-input-mutex')).toHaveLength(1)
        })

        it('refuses when the biosignal script cannot be loaded', async () => {
            const service = await readyService()
            behaviour.raiseOn.add(await import('#root/src/scripts/biosignal.py?raw').then(m => m.default))
            await expect(service.setInputMutex({} as never, 10, 100)).resolves.toMatchObject({ success: false })
        })
    })
})
