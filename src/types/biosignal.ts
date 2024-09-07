/**
 * Pyodide service biosignal script types.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { BiosignalFilters, SignalDataReader, SignalPart } from '@epicurrents/core/dist/types'

/**
 * An object containing parameters for a Butterworth filter.
 */
export type BiosignalFilterParams = {
    /**
     * Type of the filter.
     * @remarks
     * There are also shorter versions of these values, but they are not very clearly documented.
     */
    btype: 'bandpass' | 'bandstop' | 'highpass' | 'lowpass'
    /** Filter order, an integer usually in the range of 3-9. */
    N: number
    /** 
     * Critical frequency of the filter as:
     * - pair of floats for `bandpass` ( [low, high] )
     * - a single float for the rest.
     */
    Wn: number | [number, number]
}

export type PyodideSignalPart = SignalPart & {
    /** Signal indices of data gaps as [`start`, `end`] */
    dataGaps: number[][]
    filters: BiosignalFilters
}

/**
 * A name and associated channels of a biosignal montage.
 */
export type BiosignalMontage = {
    channels: BiosignalMontageChannel[]
    name: string
}

/**
 * A very simple presentation of a single channel for montage calculations.
 */
export type BiosignalMontageChannel = {
    /** Index of the active channel in the `input` array. */
    active: number
    /** 
     * Indices of reference channels in the `input` array.
     * A mean of channel values is used as a reference.
     * @remarks
     * This could be extended to allow giving a weight for each reference channel.
     */
    reference: number[]
    /** Sampling rate of all the input signals and the derived signal. */
    sampling_rate: number
}

export interface PythonSignalDataReader extends SignalDataReader {
    /** Name of the currently active montage. */
    readonly activeMontage: string
}