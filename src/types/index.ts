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

/**
 * Code execution result from Pyodide.
 */
export type RunCodeResult = {
    /** Was the code execution successful. */
    success: boolean
    /** Possible resulted error as string a array of strings with the Python error as the second element. */
    error?: string | string[]
    /** Possible return value from the script. */
    value?: unknown
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