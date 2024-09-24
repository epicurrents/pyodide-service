import { AppSettings, AssetService, ConfigMapChannels, SafeObject, SetupChannel, WorkerMessage } from '@epicurrents/core/dist/types'
import {
    BiosignalFilterParams,
    BiosignalMontage,
    BiosignalMontageChannel,
} from './biosignal'
import { MutexExportProperties } from 'asymmetric-io-mutex'

export {
    BiosignalFilterParams,
    BiosignalMontage,
    BiosignalMontageChannel,
}

export type LoadPackagesResult = boolean

export interface PythonInterpreterService extends Omit<
    AssetService,  'requestMemory' | 'setBufferRange' | 'setupMutex'
> {
    /**
     * Load a default script by the given `name`.
     * @param name - Name of the script.
     * @returns Promise that resolves with true on success, false otherwise.
     */
    loadDefaultScript (name: string): Promise<SetupScriptResult>
    /**
    * Load the given packages in the Python interpreter.
    * @param packages - Array of package names to load.
    */
    loadPackages (packages: string[]): Promise<LoadPackagesResult>
    /**
     * Run the provided piece of `code` with the given parameters.
     * @param code - Python code as a string.
     * @param params - Parameters for execution passed to the python script (optional).
     * @param scriptDeps - Scripts that this code depends on (optional).
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    runCode (code: string, params?: SafeObject, scriptDeps?: string[]): Promise<RunCodeResult>
    /**
     * Load and run the `script` using the given `parameters`.
     * @param name - Name of the script.
     * @param script - Script contents.
     * @param params - Parameters for execution passed to the python script (optional).
     * @param scriptDeps - Scripts that this script depends on (optional).
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    runScript (
        name: string,
        script: string,
        params?: { [key: string]: unknown },
        scriptDeps?: string[]
    ): Promise<RunCodeResult>
    /**
     * Update Pyodide input signals arrays to the content of the shared array buffer from the input mutex.
     * @returns True on success, false on failure.
     */
    updateInputSignals (): Promise<UpdateInputSignalsResponse>
}
export type PythonWorkerCommission = {
    'load-packages': WorkerMessage['data'] & {
        packages: string[]
    }
    'run-code': WorkerMessage['data'] & {
        code: string
    }
    'set-input-mutex': WorkerMessage['data'] & {
        bufferStart: number
        config: ConfigMapChannels
        dataDuration: number
        input: MutexExportProperties
        montage: string
        recordingDuration: number
        setupChannels: SetupChannel[]
    }
    'setup-montage': WorkerMessage['data'] & {
        config: ConfigMapChannels
        montage: string
        namespace: string
        settings: AppSettings
        setupChannels: SetupChannel[]
    }
    'setup-worker':  WorkerMessage['data'] & {
        config?: {
            indexURL?: string
            packages?: string[]
        }
    }
}
export type PythonWorkerCommissionAction = keyof PythonWorkerCommission
/**
 * Code execution result from Pyodide.
 */
export type RunCodeResult = {
    /** Was the code execution successful. */
    success: boolean
    /** Possible resulted error as string a array of strings with the Python error as the second element. */
    error?: string | string[]
    /** Possible result of the operation. */
    result?: unknown
}

export type ScriptLoadingState = 'error' | 'loaded' | 'loading' | 'not_loaded'
export type ScriptState = {
    /**
     * Variable names and values to use in the python script.
     */
    params: { [key: string]: unknown }
    /**
     * Script loading state.
     */
    state: ScriptLoadingState
}

/**
 * Result of a script setup commission.
 */
export type SetupScriptResult = {
    /** Was setup successful or not. */
    success: boolean
    /** Possible resulted error as string a array of strings with the Python error as the second element. */
    error?: string | string[]
}
export type UpdateInputSignalsResponse = boolean