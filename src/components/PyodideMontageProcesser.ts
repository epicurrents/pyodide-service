/**
 * Pyodide montage processer.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { MontageProcesser } from '@epicurrents/core/dist/assets'
import {
    shouldDisplayChannel,
    getFilterPadding,
    safeObjectFrom,
} from '@epicurrents/core/dist/util'
import { 
    BiosignalFilters,
    type CommonBiosignalSettings,
    type ConfigChannelFilter,
    type ConfigMapChannels,
    type MontageChannel,
    type SetupChannel,
    type SignalCachePart,
    type SignalPart,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-ts-log'
import { PythonSignalDataReader } from '#types/biosignal'

const SCOPE = "MontageProcesser"

export default class PyodideMontageProcesser extends MontageProcesser implements PythonSignalDataReader {
    protected _activeMontage = ''
    protected _montageSetups = {} as {
        [montage: string]: ConfigMapChannels
    }
    protected _runCode: RunPythonCode

    constructor (runCode: RunPythonCode, settings: CommonBiosignalSettings) {
        super(settings)
        this._runCode = runCode
    }
    /**
     * Get montage signals for the given part.
     * @param start - Part start (in seconds, included).
     * @param end - Part end (in seconds, excluded).
     * @param cachePart - Should the caculated signals be cached (default true).
     * @param config - Additional configuration (optional).
     * @returns False if an error occurred and depending on the value of parameter `cachePart`:
     *          - If true, returns true if caching was successful.
     *          - If false, calculated signals as SignalCachePart.
     */
    async calculateSignalsForPart (
        start: number,
        end: number,
        cachePart = true,
        config?: ConfigChannelFilter & { excludeActiveFromAvg?: boolean }
    ) {
        // Check that cache is ready.
        if (!this._mutex) {
            Log.error("Cannot return signal part, signal cache has not been set up yet.", SCOPE)
            return false
        }
        const cacheStart = this._recordingTimeToCacheTime(Math.max(0, start))
        const cacheEnd = this._recordingTimeToCacheTime(Math.min(end, this._totalRecordingLength))
        // Check that cache has the part that we need.
        const inputRangeStart = await this._mutex.inputRangeStart
        const inputRangeEnd = await this._mutex.inputRangeEnd
        if (
            inputRangeStart === null || cacheStart < inputRangeStart ||
            inputRangeEnd === null || (cacheEnd > inputRangeEnd && inputRangeEnd < this._totalDataLength)
        ) {
            // TODO: Signal that the required part must be loaded by the file loader first.
            Log.error("Cannot return signal part, requested raw signals have not been loaded yet.", SCOPE)
            return false
        }
        const montageChannels = [] as SignalPart[]
        // Float32Arrays cannot be passed to Pyodide as a property of an object, we have to separate them.
        const outputSignals = [] as Float32Array[]
        // Filter channels, if needed.
        const channels = (config?.include?.length || config?.exclude?.length)
                       ? [] as MontageChannel[]
                       : this._channels
        // Prioritize include -> only process those channels.
        if (config?.include?.length) {
            for (const c of config.include) {
                channels.push(this._channels[c])
            }
        } else if (config?.exclude?.length) {
            for (let i=0; i<this._channels.length; i++) {
                if (!config.exclude.includes(i)) {
                    channels.push(this._channels[i])
                }
            }
        }
        // Get the input signals
        const padding = this._settings.filterPaddingSeconds || 0
        // Check for possible gaps in this range.
        const filterRangeStart = Math.max(cacheStart - padding, 0)
        const filterRangeEnd = Math.min(cacheEnd + padding, this._totalDataLength)
        const dataGaps = this.getDataGaps([filterRangeStart, filterRangeEnd], true)
        channel_loop:
        for (let i=0; i<channels.length; i++) {
            const chan = channels[i]
            const maxSamples = Math.floor(this._totalDataLength*chan.samplingRate)
            // Initialize the signal response with an empty data array.
            const sigProps = {
                data: new Float32Array(),
                samplingRate: chan.samplingRate,
            }
            // Remove missing and inactive channels.
            if (!shouldDisplayChannel(chan, false, this._settings)) {
                montageChannels.push(sigProps)
                outputSignals.push(new Float32Array())
                continue
            }
            // Check if whole range is just data gap.
            for (const gap of dataGaps) {
                const gapStartRecTime = this._cacheTimeToRecordingTime(gap.start)
                if (gapStartRecTime <= start && gapStartRecTime + gap.duration >= end) {
                    montageChannels.push(sigProps)
                    outputSignals.push(new Float32Array())
                    continue channel_loop
                }
            }
            // Get filter padding for the channel.
            const {
                filterLen,
                filterStart, filterEnd,
                rangeStart, rangeEnd,
            } = getFilterPadding(
                [cacheStart, cacheEnd] || [],
                maxSamples,
                chan,
                this._settings,
                this._filters
            )
            // Range of the filter padded part without data gaps.
            const filterRange = filterEnd - filterStart
            // The total range of the filter padded part inluding gaps.
            const totalRange = Math.ceil((end - start)*chan.samplingRate) + 2*filterLen
            let dataStart = filterStart
            let dataEnd = filterEnd
            // Calculate signal indices (relative to the retrieved data part) for data gaps.
            const gapIdxs = [] as number[][]
            for (const gap of dataGaps) {
                const gapStart = Math.round(gap.start*chan.samplingRate) - filterStart
                const gapLen = Math.round(gap.duration*chan.samplingRate)
                if (gapStart >= totalRange) {
                    break
                } else if (gapStart + gapLen <= 0) {
                    continue
                }
                // Apply a maximum of padded signal part length of gap.
                const startPos = Math.max(gapStart, 0)
                const endPos = Math.min(gapStart + gapLen, totalRange)
                if (filterLen) {
                    // Adjust data (=padding) starting and ending positions, if gap is withing filter padding range.
                    if (startPos >= 0 && startPos < filterLen) {
                        const corr = Math.min(endPos, filterLen) - startPos
                        dataStart += corr
                    } else if (gap.start < start) {
                        // If a data gap crosses or is adjacent to the requested range start, we cannot determine its
                        // position by cache coordinates; we need to compare actual gap and range start times.
                        const relStart = Math.max(gap.start - start, -padding)
                        const maxDur = Math.min(gap.duration, padding)
                        if (relStart <= 0 && maxDur >= -relStart) {
                            const corr = Math.round(-relStart*chan.samplingRate)
                            dataStart += corr
                        }
                    } else if (startPos >= rangeEnd - filterStart && startPos < filterRange) {
                        dataEnd -= Math.min(endPos, filterRange) - startPos
                    }
                }
                gapIdxs.push([startPos, endPos])
            }
            // Adjust start and end to cached signal range.
            const cacheStartPos = Math.round(inputRangeStart*chan.samplingRate)
            const relStart = dataStart - cacheStartPos
            const relEnd = dataEnd - cacheStartPos
            // The amount of signal data points that have to be removed from the start of the filter-padded signal.
            const trimStart = rangeStart - dataStart
            // We will pass all the information required to construct the channel signal to the Pyodide script.
            Object.assign(sigProps, {
                active: chan.active,
                common_ref: chan.averaged,
                // Set an appropariate size for the response signal.
                // This will be used as an output buffer for the Python script to store the signals in.
                data_gaps: gapIdxs,
                end: relEnd,
                filter_len: filterLen,
                filters: {
                    highpass: chan.highpassFilter !== null 
                              ? chan.highpassFilter
                              : this._settings.filterChannelTypes[chan.type]?.includes('highpass')
                                ? this._filters.highpass
                                : null,
                    lowpass: chan.lowpassFilter !== null 
                             ? chan.lowpassFilter
                             : this._settings.filterChannelTypes[chan.type]?.includes('lowpass')
                               ? this._filters.lowpass
                               : null,
                    notch: chan.notchFilter !== null
                           ? chan.notchFilter
                           : this._settings.filterChannelTypes[chan.type]?.includes('notch')
                             ? this._filters.notch
                             : null,
                },
                reference: [...chan.reference],
                start: relStart,
                trim_end: rangeEnd - rangeStart + trimStart,
                trim_start: trimStart,
                type: chan.type,
            })
            montageChannels.push(sigProps)
            outputSignals.push(
                // Set an appropariate size for the response signal.
                // This will be used as an output buffer for the Python script to store the signals in.
                new Float32Array(rangeEnd - rangeStart)
            )
        }
        const calculateSigs = await this._runCode(
            `biosignal_calculate_signals()`,
            safeObjectFrom({ 
                channels: montageChannels,
                output: outputSignals,
            })
        )
        if (!calculateSigs.success) {
            Log.error(
                [`Calcualting signals in the Pyodide worker failed.`, calculateSigs.error].flat(),
                SCOPE
            )
            return false
        }
        // Combine channel properties with signal data.
        for (let i=0; i<montageChannels.length; i++) {
            Object.assign(montageChannels[i], { data: outputSignals[i] })
        }
        if (cachePart) {
            // We only assign the signals to the mutex and they will be read from there.
            await this._mutex.insertSignals({
                start: cacheStart,
                end: cacheEnd,
                signals: montageChannels
            })
            const updated = await this.getSignalUpdatedRange()
            postMessage({
                action: 'cache-signals',
                range: [updated.start, updated.end]
            })
            return true
        }
        // Since everything returned by this method will be transferred from the Workerto the main thread,
        // we should minimize the amount of properties to avoid needless overhead.
        return montageChannels.map(c => { 
            return { 
                data: c.data,
                originalSamplingRate: c.samplingRate,
                samplingRate: c.samplingRate,
            }
        }) as SignalCachePart['signals']
    }
    /**
     * Get up-to-date input signals from the mutex data cache.
     * @returns - Input signals as an array of Float32Arrays, or null if mutex is not set up.
     */
    async getInputSignals (): Promise<Float32Array[] | null>  {
        if (!this._mutex) {
            return null
        }
        return this._mutex.inputSignals
    }
    /**
     * Get Float32Array views of the input channels.
     * @returns - Input views as an array of Float32Arrays, or null if mutex is not set up.
     */
    async getInputViews (): Promise<Float32Array[] | null>  {
        if (!this._mutex) {
            return null
        }
        return this._mutex.inputSignalViews
    }
    /**
     * Set default filters.
     * @param filters - Filter parameters.
     */
    async setDefaultFilters (filters: BiosignalFilters) {
        // Construct a filters object to pass to Pyodide.
        const params = {
            highpass: filters.highpass ? {
                Wn: filters.highpass
            } : null,
            lowpass: filters.lowpass ? {
                Wn: filters.lowpass
            } : null,
            notch: filters.notch ? {
                Wn: filters.notch
            } : null
        }
        const result = await this._runCode(
            `biosignal_set_default_filters()`,
            safeObjectFrom({ 
                filters: params,
            })
        )
        if (!result.success) {
            Log.error(
                [`Setting default filters in Pyodide worker failed.`, result.error].flat(),
                SCOPE
            )
        }
        return result
    }
    /**
     * Set the given `montage` as active in the processer.
     * @param montage - Name of the montage.
     * @returns True on success, false if montage cannot be found.
     */
    setMontage (montage: string) {
        if (this._activeMontage === montage) {
            return true
        }
        if (Object.keys(this._montageSetups).includes(montage)) {
            this.mapChannels(this._montageSetups[montage])
            this._activeMontage = montage
            return true
        }
        return false
    }
    setupChannels(montage: string, config: ConfigMapChannels, setupChannels: SetupChannel[]): void {
        super.setupChannels(montage, config, setupChannels)
        this._activeMontage = montage
        if (!Object.keys(this._montageSetups).includes(montage)) {
            // Save new setup properties.
            this._montageSetups[montage] = { ...config }
        }
    }
    /**
     * Update Pyodide input signals arrays to the content of the shared array buffer from the input mutex.
     * @returns Code execution result.
     */
    async updateInputSignals () {
        const result = await this._runCode(
            `biosignal_update_input()`,
            {}
        )
        if (!result.success) {
            Log.error(
                [`Updating input signals in Pyodide failed.`, result.error].flat(),
                SCOPE
            )
        }
        return result
    }
}
