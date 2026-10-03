/**
 * A worker stand-in that runs the real worker on this thread.
 *
 * The defect this is built to catch is a disagreement between the two halves: the service sending a
 * commission the worker will not accept, or the worker replying under a key the service does not
 * read. Neither half can see that on its own, and a scripted double of either hides it by
 * construction — it answers what the test author believed the other half wanted. So the service is
 * driven against the actual worker class, with the thread boundary replaced by an event dispatch,
 * and the entry point is `handlePythonMessage` because that is what `pyodide.worker.ts` calls.
 *
 * One thing is replaced rather than run: the setup commission ends in a dynamic `import()` of
 * `pyodide.mjs` from a distribution folder, which no test environment serves. {@link setupWorker}
 * installs the interpreter double and flips the same two flags the real one flips, so every other
 * commission runs against the real code with a real initialisation state behind it.
 * @package    epicurrents/pyodide-service
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { WorkerMessage } from '@epicurrents/core/types'
import { PyodideMontageWorker } from '#workers/PyodideMontageWorker'
import { install, uninstall } from './pyodideDouble'

/** Let the microtask queue drain, which is where every reply and commission lands. */
export const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve()
    }
}

/**
 * Give the worker the loopback's transport: replies are dispatched back as messages rather than
 * posted across a thread boundary, and closing is recorded instead of ending the thread.
 */
const asLoopback = (channel: EventTarget, failSetup: () => boolean) => {
    return new (class extends PyodideMontageWorker {
        closed = false
        /** The processor the montage commissions act on, which is otherwise internal. */
        get montage () {
            return this._montage
        }
        protected override _postMessage (reply: WorkerMessage['data']) {
            queueMicrotask(() => {
                channel.dispatchEvent(new MessageEvent('message', { data: reply }))
            })
        }
        protected override _close () {
            this.closed = true
        }
        override async setupWorker (msgData: WorkerMessage['data']) {
            if (failSetup()) {
                // The real failure path: the waiters are released so nothing queued behind the
                // setup hangs, and the initialised flag stays down.
                this._loadingDone = true
                for (const resolve of this._loadWaiters) {
                    resolve()
                }
                uninstall()
                return this._failure(msgData, `The Pyodide runtime could not be loaded.`)
            }
            install()
            this._loadingDone = true
            for (const resolve of this._loadWaiters) {
                resolve()
            }
            this._isInitialised = true
            return this._success(msgData)
        }
    })()
}

/** The worker the loopback drives, with the two things a test reads off it. */
type LoopbackTarget = PyodideMontageWorker & {
    closed: boolean
    montage: { activeMontage: string } | null
}

/**
 * A `Worker` as far as `GenericService` is concerned, delivering each commission to a real
 * {@link PyodideMontageWorker} and each reply back as a `message` event.
 */
export class LoopbackWorker extends EventTarget {
    /** Commissions posted to the worker, in order. */
    posted = [] as WorkerMessage['data'][]
    /** Make the next setup commission fail, as an unreachable distribution folder would. */
    failSetup = false
    /**
     * Actions answered here with a successful reply instead of being delivered to the worker.
     *
     * For the commissions whose precondition is shared memory: the worker refuses them without a
     * montage and a mutex, which is state this environment cannot produce, so naming the action
     * here is how the service's handling of a successful reply gets exercised at all. The reply is
     * built the way the worker builds one, from the request number and the action it answers.
     */
    answering = new Map<string, { [prop: string]: unknown }>()
    terminated = false
    onerror: ((event: unknown) => void) | null = null
    onmessageerror: ((event: unknown) => void) | null = null
    readonly worker: LoopbackTarget

    constructor () {
        super()
        this.worker = asLoopback(this, () => this.failSetup) as LoopbackTarget
    }

    /** Has the worker closed its own context, which only the shutdown commission does. */
    get closed () {
        return this.worker.closed
    }

    /** Every commission posted for the given action. */
    postedFor (action: string) {
        return this.posted.filter(data => data.action === action)
    }

    postMessage (data: WorkerMessage['data']) {
        this.posted.push(data)
        const canned = this.answering.get(data.action)
        if (canned) {
            queueMicrotask(() => {
                this.dispatchEvent(new MessageEvent('message', {
                    data: { rn: data.rn, action: data.action, success: true, ...canned },
                }))
            })
            return
        }
        void this.worker.handlePythonMessage({ data } as WorkerMessage)
    }

    terminate () {
        this.terminated = true
    }
}
