// @vitest-environment jsdom
/**
 * Tests for the montage half: the worker's montage overrides and the processor they drive.
 *
 * What is covered here is what this package adds to core's montage worker and processor — a
 * registry of several montages with one active at a time, and the switching the commissions do
 * around it. Deriving the signals themselves is not: that path reads its input through a shared
 * memory mutex and computes in Python, neither of which exists here. See ROADMAP.md.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonBiosignalSettings } from '@epicurrents/core/types'
import type { WorkerMessage } from '@epicurrents/core/types'
import { behaviour, interpreter, reset } from './pyodideDouble'
import { LoopbackWorker, settle } from './loopback'

const PyodideMontageProcessor = (await import('#root/src/components/PyodideMontageProcessor')).default

let loopback: LoopbackWorker
let replies: WorkerMessage['data'][]
let request: number

const commission = async (data: { [prop: string]: unknown }) => {
    const rn = ++request
    loopback.postMessage({ rn, ...data } as WorkerMessage['data'])
    await settle(20)
    return replies.find(reply => reply.rn === rn)
}

/** A channel map with nothing in it, which is all the registry cases need. */
const EMPTY_MAP = {
    channels: [],
    channelSpacing: 1,
    electrodes: [],
    groupSpacing: 1,
    isRaw: false,
    layout: [],
    yPadding: 0,
}

/** Set up a montage by name. The channel map is empty, which the registry is indifferent to. */
const setupMontage = async (montage: string) => {
    return await commission({
        action: 'setup-worker',
        config: EMPTY_MAP,
        montage: montage,
        namespace: 'eeg',
        settings: { modules: { eeg: {} } },
        setupChannels: [],
    })
}

/** The processor with a recorded interpreter in place of one. */
const makeProcessor = () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const processor = new PyodideMontageProcessor(run, {} as CommonBiosignalSettings)
    return { processor, run }
}

describe('PyodideMontageProcessor', () => {
    beforeEach(() => {
        reset()
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('has no active montage before one is set up', () => {
        const { processor } = makeProcessor()
        expect(processor.activeMontage).toEqual('')
    })

    it('activates a montage as it is set up and keeps it in the registry', () => {
        const { processor } = makeProcessor()
        processor.setupChannels('first', EMPTY_MAP, [])
        processor.setupChannels('second', EMPTY_MAP, [])
        expect(processor.activeMontage).toEqual('second')
        expect(processor.setMontage('first')).toEqual(true)
        expect(processor.activeMontage).toEqual('first')
    })

    it('refuses a montage it has not been given', () => {
        const { processor } = makeProcessor()
        processor.setupChannels('first', EMPTY_MAP, [])
        expect(processor.setMontage('other')).toEqual(false)
        expect(processor.activeMontage).toEqual('first')
    })

    it('passes the default filters to Python as critical frequencies', async () => {
        const { processor, run } = makeProcessor()
        await processor.setDefaultFilters({ bandreject: [], highpass: 0.5, lowpass: 70, notch: 0 })
        expect(run).toHaveBeenCalledWith('biosignal_set_default_filters()', {
            filters: {
                highpass: { Wn: 0.5 },
                lowpass: { Wn: 70 },
                notch: null,
            },
        })
    })

    it('reports a refused filter update', async () => {
        const run = vi.fn().mockResolvedValue({ success: false, error: 'scipy missing' })
        const refusing = new PyodideMontageProcessor(run, {} as CommonBiosignalSettings)
        await expect(refusing.setDefaultFilters({ bandreject: [], highpass: 0.5, lowpass: 0, notch: 0 }))
            .resolves.toMatchObject({ success: false })
    })

    it('cannot calculate a part before its input has been set up', async () => {
        const { processor, run } = makeProcessor()
        processor.setupChannels('first', EMPTY_MAP, [])
        await expect(processor.calculateSignalsForPart(0, 1)).resolves.toEqual(false)
        expect(run).not.toHaveBeenCalled()
    })

    it('has no input signals before its input has been set up', async () => {
        const { processor } = makeProcessor()
        await expect(processor.getInputSignals()).resolves.toEqual(null)
        await expect(processor.getInputViews()).resolves.toEqual(null)
    })
})

describe('the montage worker', () => {
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

    it('sets up a montage from a setup commission that carries one', async () => {
        expect(await setupMontage('first')).toMatchObject({ success: true })
        // The interpreter is untouched: a setup commission carrying a montage is about the montage.
        expect(interpreter.code).toEqual([])
    })

    it('refuses a montage setup commission that is missing a property', async () => {
        const reply = await commission({ action: 'setup-worker', montage: 'first' })
        expect(reply).toMatchObject({ success: false })
    })

    it('answers a montage setup commission whose handling throws', async () => {
        // The payload validates — every property is there and of the declared type — and the
        // channel map is then rejected deeper in, which is where an unguarded handler would
        // throw and answer nothing at all.
        const reply = await commission({
            action: 'setup-worker',
            config: { channels: [] },
            montage: 'first',
            namespace: 'eeg',
            settings: { modules: { eeg: {} } },
            setupChannels: [],
        })
        expect(reply).toMatchObject({ success: false })
    })

    it('refuses signals for a montage that has not been set up', async () => {
        await setupMontage('first')
        await commission({ action: 'setup-worker', config: {} })
        const reply = await commission({ action: 'get-signals', range: [0, 1], montage: 'second' })
        expect(reply).toMatchObject({ success: false })
        expect(String(reply?.error)).toContain('second')
    })

    it('refuses signals before any montage has been set up', async () => {
        await commission({ action: 'setup-worker', config: {} })
        expect(await commission({ action: 'get-signals', range: [0, 1] })).toMatchObject({
            success: false,
        })
    })

    it('refuses signals before the interpreter is there, montage or no montage', async () => {
        await setupMontage('first')
        const reply = await commission({ action: 'get-signals', range: [0, 1] })
        expect(reply).toMatchObject({ success: false })
        expect(String(reply?.error)).toContain('initialized')
    })

    it('leaves the active montage as it was after filtering another one', async () => {
        await setupMontage('first')
        await setupMontage('second')
        await commission({ action: 'set-filters', filters: '{}', name: 'first' })
        expect(loopback.worker.montage?.activeMontage).toEqual('second')
    })

    it('releases the montage when the worker shuts down', async () => {
        await setupMontage('first')
        expect(await commission({ action: 'shutdown' })).toMatchObject({ success: true })
        expect(loopback.closed).toEqual(true)
    })

    it('answers a run commission once the interpreter is there', async () => {
        await setupMontage('first')
        await commission({ action: 'setup-worker', config: {} })
        behaviour.results.set('one()', 1)
        expect(await commission({ action: 'run-code', code: 'one()' })).toMatchObject({
            success: true,
            result: 1,
        })
    })
})
