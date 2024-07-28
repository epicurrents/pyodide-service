import { AssetService, SafeObject } from '@epicurrents/core/dist/types'
import {
    BiosignalFilterParams,
    BiosignalMontage,
    BiosignalMontageChannel,
} from './biosignal'

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
     * @param params - Parameters for execution passed to the python script.
     * @param scriptDeps - Scripts that this core depends on.
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    runCode (code: string, params: SafeObject, scriptDeps: string[]): Promise<RunCodeResult>
    /**
     * Load and run the `script` using the given `parameters`.
     * @param name - Name of the script.
     * @param script - Script contents.
     * @param params - Parameters for execution passed to the python script.
     * @remarks
     * Reserved `params` are:
     * * `simulateDocument` - Create document and window objects into pyodide's self scope.
     */
    runScript (name: string, script: string, params: { [key: string]: unknown }): Promise<RunCodeResult>
    /**
     * Set up generic biosignal scripts in Pyodide. If SharedArrayBuffer is supported, input signal buffers from the
     * recording's raw data mutex will be set up in Pyodide as well.
     * @param signals - Possible signal data as Float32Arrays.
     * @param dataPos - Starting position of signal data in the data array (default 0).
     * @param dataFields - Possible data fields contained in the signal array as { name: position }.
     * @param filterPadding - Amount of seconds to add as padding when filterin signals.
     * @return Promise that resolves with SetupScriptResult.
     */
    setupBiosignalRecording (
        signals?: Float32Array[], dataPos?: number, dataFields?: unknown[], filterPadding?: 0
    ): Promise<SetupScriptResult>
}

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