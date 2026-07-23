/**
 * Pyodide montage worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

import { validateCommissionProps } from '@epicurrents/core/dist/util'
import { MontageWorker } from '@epicurrents/core/dist/workers'
import type {
    CommonBiosignalSettings,
    MontageWorkerCommission,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import PyodideMontageProcesser from '#root/src/components/PyodideMontageProcessor'
import type { PythonWorkerCommission } from '#types'
import { WithPyodide } from '#workers/pyodideWorkerBase'
import { Log } from 'scoped-event-log'

const SCOPE = "PyodideMontageWorker"

export class PyodideMontageWorker extends WithPyodide(MontageWorker) {
    // Montage-specific state; the Pyodide loading state lives in WithPyodide.
    protected _montage = null as PyodideMontageProcesser | null
    protected _namespace = ''
    protected _settings = null as CommonBiosignalSettings | null
    constructor () {
        super()
        // Extend action map with Python commissions.
        // We also need to remap any super class actions to methods redefined in this class.
        // load-packages / run-code / setup-worker are handled by the shared WithPyodide layer.
        this.extendActionMap([
            ['get-signals', this.getSignals],
            ['load-packages', this.loadPackages],
            ['run-code', this.runCode],
            ['set-filters', this.setFilters],
            ['setup-input-mutex', this.setupInputMutex],
            ['setup-montage', this.setupMontage],
            ['setup-worker', this.setupWorker],
        ])
    }

    async clearMontage (msgData?: WorkerMessage['data']) {
        Log.debug(`Clearing current montage.`, SCOPE)
        await this._montage?.releaseCache()
        this._montage = null
        if (msgData) {
            this._success(msgData)
        }
    }

    async getSignals(msgData: WorkerMessage['data']): Promise<boolean> {
        const data = validateCommissionProps(
            msgData as MontageWorkerCommission['get-signals'],
            {
                range: ['Number', 'Number'],
                config: 'Object?',
                montage: 'String?',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        // Check that the correct montage is active, if it is given.
        if (data.montage && this._montage.activeMontage !== data.montage) {
            if (!this._montage.setMontage(data.montage)) {
                return this._failure(msgData, `Given montage ${data.montage} has not been set up.`)
            } else {
                this._name = data.montage
            }
        }
        return super.getSignals(msgData)
    }

    /**
     * Montage override: a ``setup-worker`` that carries a montage sets up the
     * montage instead of (re)loading Pyodide. Every other message defers to the
     * shared handler in ``WithPyodide``.
     */
    async handlePythonMessage (message: WorkerMessage): Promise<boolean> {
        if (message?.data?.action === 'setup-worker' && message.data.montage) {
            return this.setupMontage(message.data)
        }
        return super.handlePythonMessage(message)
    }

    async setFilters (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as MontageWorkerCommission['set-filters'],
            {
                name: 'String',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        if (this._montage.activeMontage === data.name) {
            return super.setFilters(msgData)
        } else {
            // We need to set the right channels to update with the new filters.
            const actMontage = this._montage.activeMontage
            this._montage.setMontage(data.name)
            this._name = data.name
            const success = await super.setFilters(msgData)
            this._montage.setMontage(actMontage)
            this._name = actMontage
            if (success) {
                return this._success(msgData)
            } else {
                return this._failure(msgData)
            }
        }
    }

    async setupInputMutex (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['set-input-mutex'],
            {
                bufferStart: 'Number',
                config: 'Object',
                dataDuration: 'Number',
                input: 'Object',
                montage: 'String',
                recordingDuration: 'Number',
                setupChannels: 'Array',
            },
            this._montage !== null
        )
        if (!data || !this._montage) {
            return this._failure(msgData)
        }
        this._montage.setupChannels(data.montage, data.config, data.setupChannels)
        const cacheSetup = await this._montage.setupMutexWithInput(
            data.input,
            data.bufferStart,
            data.dataDuration,
            data.recordingDuration
        )
        if (cacheSetup) {
            Log.debug(`Mutex setup complete.`, SCOPE)
            // Set the mutex input data buffers as signal source in Pyodide.
            const result = await this._runPythonCode(
                'biosignal_set_buffers()',
                {
                    buffers: await this._montage.getInputViews()
                }
            )
            if (result.success) {
                // Pass the generated shared buffers back to main thread.
                return this._success(msgData, {
                    cacheProperties: cacheSetup,
                })
            } else {
                return this._failure(msgData, `Setting input buffers in Pyodide montege processer failed.`)
            }
        } else {
            return this._failure(msgData, `Setting up mutex in the Pyodide montage processer failed.`)
        }
    }

    async setupMontage (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as PythonWorkerCommission['setup-montage'],
            {
                config: 'Object',
                montage: 'String',
                namespace: 'String',
                settings: 'Object',
                setupChannels: 'Array',
            },
        )
        if (!data) {
            return this._failure(msgData)
        }
        if (!this._settings) {
            this._namespace = data.namespace
            this._settings = data.settings.modules[data.namespace] as unknown as CommonBiosignalSettings
        }
        if (!this._montage) {
            // Create new montage processer.
            Log.debug(`Creating a new processer for montage ${data.montage}.`, SCOPE)
            this._montage = new PyodideMontageProcesser(this._runPythonCode, this._settings)
        }
        this._montage.setupChannels(data.montage, data.config, data.setupChannels)
        return this._success(msgData)
    }
}
export default PyodideMontageWorker
