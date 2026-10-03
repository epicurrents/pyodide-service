// @vitest-environment jsdom
/**
 * Tests for the worker half, driven through the same loopback the service tests use but without a
 * service in front of it, so a commission can be sent that the typed service API cannot express.
 *
 * Two properties here are about the transport rather than about Python. A reply must leave through
 * the worker's own channel, because that is the one a base class can redirect — the global
 * `postMessage` is the right destination on a worker thread and the window everywhere else. And the
 * global scope the interpreter reads must be left as it was found, whether the code returned or
 * raised. Note that the second property is why the document-simulation cases leave this
 * environment without a `document` of its own: releasing the simulated one deletes the name, and
 * in a worker — the only place the simulation runs for real — nothing else owns it.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerMessage } from '@epicurrents/core/types'
import { behaviour, interpreter, proxy, reset, watchedKeys } from './pyodideDouble'
import { LoopbackWorker, settle } from './loopback'

let loopback: LoopbackWorker
let replies: WorkerMessage['data'][]
let request: number

/** Send a commission and return the reply to it, or undefined if none arrived. */
const commission = async (data: { [prop: string]: unknown }) => {
    const rn = ++request
    loopback.postMessage({ rn, ...data } as WorkerMessage['data'])
    await settle(20)
    return replies.find(reply => reply.rn === rn)
}

/** A worker with its interpreter installed, which is the state every commission but setup needs. */
const ready = async () => {
    await commission({ action: 'setup-worker' })
}

describe('the Pyodide worker layer', () => {
    beforeEach(() => {
        reset()
        request = 0
        replies = []
        loopback = new LoopbackWorker()
        loopback.addEventListener('message', event => {
            replies.push((event as MessageEvent).data)
        })
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('the setup gate', () => {
        it('refuses a commission issued before the interpreter has loaded', async () => {
            const reply = await commission({ action: 'run-code', code: 'one()' })
            expect(reply).toMatchObject({ success: false })
            expect(reply?.error).toContain('initialized')
        })

        it('answers the shutdown commission before the interpreter has loaded', async () => {
            const reply = await commission({ action: 'shutdown' })
            expect(reply).toMatchObject({ action: 'shutdown', success: true })
            expect(loopback.closed).toEqual(true)
        })

        it('answers an unknown action with a failure', async () => {
            await ready()
            const reply = await commission({ action: 'fly' })
            expect(reply).toMatchObject({ success: false })
        })
    })

    describe('run-code', () => {
        it('returns the result of the code', async () => {
            await ready()
            behaviour.results.set('one()', 1)
            expect(await commission({ action: 'run-code', code: 'one()' })).toMatchObject({
                success: true,
                result: 1,
            })
        })

        it('converts a proxy result and destroys the proxy', async () => {
            await ready()
            behaviour.results.set('dict()', proxy({ channels: [1, 2] }))
            expect(await commission({ action: 'run-code', code: 'dict()' })).toMatchObject({
                success: true,
                result: { channels: [1, 2] },
            })
            expect(interpreter.destroyed).toEqual([{ channels: [1, 2] }])
        })

        it('passes a result that carries its own success through whole', async () => {
            await ready()
            behaviour.results.set('own()', proxy({ success: true, result: 'mine' }))
            expect(await commission({ action: 'run-code', code: 'own()' })).toMatchObject({
                success: true,
                result: 'mine',
            })
        })

        it('reports the cause when the code raises', async () => {
            await ready()
            behaviour.raiseOn.add('boom()')
            const reply = await commission({ action: 'run-code', code: 'boom()' })
            expect(reply).toMatchObject({ success: false })
            expect(String(reply?.error)).toContain('Python raised')
        })

        it('answers a commission with no code through its own channel', async () => {
            await ready()
            const toWindow = vi.spyOn(window, 'postMessage')
            const reply = await commission({ action: 'run-code' })
            expect(reply).toMatchObject({ success: false })
            expect(toWindow).not.toHaveBeenCalled()
        })

        it('releases the parameters it bound once the code has run', async () => {
            await ready()
            watchedKeys.push('fs', 'data')
            await commission({ action: 'run-code', code: 'psd()', fs: 100, data: [1] })
            expect(interpreter.scope[0]).toEqual({ fs: 100, data: [1] })
            expect('fs' in globalThis).toEqual(false)
            expect('data' in globalThis).toEqual(false)
        })

        it('releases the parameters it bound when the code raises', async () => {
            await ready()
            behaviour.raiseOn.add('boom()')
            await commission({ action: 'run-code', code: 'boom()', fs: 100 })
            expect('fs' in globalThis).toEqual(false)
        })

        it('removes the simulated document once the code has run', async () => {
            await ready()
            await commission({ action: 'run-code', code: 'plot()', simulateDocument: true })
            expect((globalThis as { document?: unknown }).document).toBeUndefined()
        })

        it('removes the simulated document when the code raises', async () => {
            await ready()
            behaviour.raiseOn.add('plot()')
            await commission({ action: 'run-code', code: 'plot()', simulateDocument: true })
            expect((globalThis as { document?: unknown }).document).toBeUndefined()
        })

        it('does not bind a parameter named after the interpreter', async () => {
            await ready()
            watchedKeys.push('pyodide')
            behaviour.results.set('one()', 1)
            await commission({ action: 'run-code', code: 'one()', pyodide: 'not the interpreter' })
            // The interpreter is still there for the next commission, which is what the refusal is
            // for: the release deletes the names it bound, this one among them.
            expect(await commission({ action: 'run-code', code: 'one()' })).toMatchObject({
                success: true,
                result: 1,
            })
        })

        it('does not bind a parameter that reaches for the prototype', async () => {
            await ready()
            watchedKeys.push('__proto__polluted')
            await commission({ action: 'run-code', code: 'one()', ['__proto__polluted']: 1 })
            expect(interpreter.scope[0]).toEqual({})
        })
    })

    describe('load-packages', () => {
        it('loads the packages it is given', async () => {
            await ready()
            expect(await commission({ action: 'load-packages', packages: ['mne'] })).toMatchObject({
                success: true,
            })
            expect(interpreter.loaded).toContainEqual(['mne'])
        })

        it('refuses a commission carrying no packages to load', async () => {
            await ready()
            const reply = await commission({ action: 'load-packages', packages: [] })
            expect(reply).toMatchObject({ success: false })
            expect(interpreter.loaded).toEqual([])
        })

        it('reports the cause when a package cannot be loaded', async () => {
            await ready()
            behaviour.packageError = 'no such package'
            const reply = await commission({ action: 'load-packages', packages: ['nope'] })
            expect(reply).toMatchObject({ success: false })
            expect(String(reply?.error)).toContain('no such package')
        })
    })
})
