"""
Biosignal processing functions. Some of the methods in this file are concepts still under development.
"""

import numpy as np
from scipy import signal

_biosignal = {
    'available_montages': dict(),
    'buffers': None,
    'data_fields': {
        'sampling_rate': 0,
        'updated_start': 1,
        'updated_end': 2,
    },
    'data_pos': 3,
    'empty_field': -16777215,
    'filters': {
        'highpass': None,
        'lowpass': None,
        'notch': None,
        'N_pass': 6,
        'N_stop': 9, # Use a higher N for bandstop filters.
    },
    'input': None,
    'montage': None,
    'output': None,
    'series_canvas': None,
    'topomap_canvas': None,
}
"""
Global variables used in these methods.
- `available_montages`: Dictionary of available montages with the montage name as key and list of channels as value (NYI).
- `buffers`: List of JS proxies pointing to the shared array buffers holding the input signals, or None if not set. These cannot be directly used but must first be assigned to a numpy array.
- `data_fields`: Dictionary of data field names and positions (float32 index) within the input arrays.
- `data_pos`: Starting position (float32 index) of the signal data in the input arrays.
- `empty_field`: Value that denotes an empty (meta) field in the input data array buffers.
- `filters`: Dictionary of default filter params; None for filter types if not set.
    - `highpass`: Critical frequency of the highpass filter, or None if not set.
    - `lowpass`: Critical frequency of the lowpass filter, or None if not set.
    - `notch`: Critical frequency of the notch filter, or None if not set.
    - `N_pass`: Default Butterworth filter N value for bandpass type filters.
    - `N_stop`: Default Butterworth filter N value for bandstop type filters.
- `input`: List of per-channel float32 numpy arrays mirroring the SAB content for each channel, or None if `biosignal_set_buffers` has not been called.
   Each entry is allocated lazily on first access by `_ensure_input_array(idx)`; only the channel-and-range slices that a compute step actually touches are copied from the live SAB into this array (see `_refresh_channel_range`).
   Unrefreshed positions hold zeros — every read path must refresh its required range first.
- `montage`: Currently active montage from `available_montages`, or None if not set (NYI).
- `output`: List of output signals where processing results should be written, or None if not set.
"""

def _ensure_input_array (channel_idx):
    """Lazily allocate the full-channel-sized numpy backing for a single channel.

    `_biosignal['input']` starts as a list of `None`s after `biosignal_set_buffers`;
    each entry is materialised on first access here. Allocation is full-channel size
    so existing absolute-index access in `biosignal_get_signals` keeps working unchanged.
    Unrefreshed positions hold zeros — refresh the relevant slice before reading.
    """
    arr = _biosignal['input'][channel_idx]
    if arr is None:
        buf = _biosignal['buffers'][channel_idx]
        arr = np.zeros(len(buf), dtype=np.float32)
        _biosignal['input'][channel_idx] = arr
    return arr

def _refresh_channel_range (channel_idx, start, end):
    """Copy the metadata header (`updated_start` / `updated_end` etc.) and the requested
    data range `[start:end]` from the live SAB into the channel's numpy backing.

    Pyodide 0.25 cannot alias an external SharedArrayBuffer into Python-visible memory,
    so every refresh is a copy. The header must always be refreshed so load-status checks
    in `biosignal_get_signals` see live values.
    """
    target = _ensure_input_array(channel_idx)
    buf = _biosignal['buffers'][channel_idx]
    header_len = _biosignal['data_pos']
    # Header (sampling_rate, updated_start, updated_end) — small, always refreshed.
    buf.subarray(0, header_len).assign_to(target[0:header_len])
    # Data range — clamp to SAB bounds; callers handle out-of-bounds via np.pad.
    buf_len = len(buf)
    s = max(int(start), header_len)
    e = min(int(end), buf_len)
    if e > s:
        buf.subarray(s, e).assign_to(target[s:e])

def biosignal_add_montage ():
    """
    Add a montage to the `montages` dictionary.

    Parameters
    ----------
    Parameters required to be present from JS side:

    name : str
        Unique name for the montage. If a montage with this name already exists, it will be overwritten.
    channels : list
        List of channel objects (dictionaries) with the following structure:
        - `active` (int): Index of the active channel in global `input` channel list.
        - `refereces` (int[]): Indices of reference channels in the global `input` channels list.
        - `sampling_rate` (float): Signal sampling rate of this channel.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    from js import name, channels
    montage = [None]*len(channels)
    for idx, chan in enumerate(channels):
        montage[idx] = chan.to_py()
    _biosignal['available_montages'][name] = montage
    return { 'success': True }

def biosignal_calculate_signals ():
    """
    Calculate signals from the global `input` using the given `signals` definitions.
    Computed signals are set to the `data` of the signals dictionary.

    Parameters
    ----------
    Parameters required to be present from JS side:

    channels : dict[]
        Properties of the channel derivations. Must include the following properties:
        - `active` (int): Index of the active channel in the `input` list.
        - `common_ref` (boolean): Does this channel use a common reference for this signal type.
        - `data` (Float32Array): Buffer to insert the derived signals into.
        - `data_gaps` (int[][]):  List of gaps in the singal data as [start index, end index].
        - `end` (int): Ending index (excluded) of the signal data in the input buffer, including filter padding.
            In case of index exceeding signal length, that amount of zeroes is added to the end of the signal as padding.
        - `filter_len` (int): Length of the filter part at the start and end of the signal array, in data points.
        - `filters` (dict): Channel filter critical frequencies as:\\
                            -- highpass (float or None to use default for signal type)\\
                            -- lowpass (float or None to use default for signal type)\\
                            -- notch (float or None to use default for signal type)
        - `reference` (int[]): List of channel indices to average as a reference signal.
        - `start` (int): Starting index (included) of the signal data in the input buffer, including filter padding.
            In case of a negative index, that amount of zeroes is added to the start of the signal as padding
        - `type` (str): Type of the signal.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    from js import channels, output
    input_sigs = _biosignal['input']
    if input_sigs is None or len(input_sigs) == 0:
        return {
            'success': False,
            'error': "Cannot calculate signals, input has not been set."
        }
    # We need to extract the channel properties from these Proxies before they are automatically destroyed.
    py_channels = [None]*len(channels)
    for idx, channel in enumerate(channels):
        py_channels[idx] = channel.to_py()
    signals = biosignal_get_signals(py_channels)
    for idx, sig in enumerate(signals):
        if sig is None:
            continue
        chan = py_channels[idx]
        # Remove possible filter paddings from start and end.
        if chan['filter_len'] > 0:
            sig = sig[chan['trim_start']:chan['trim_end']]
        if len(sig) > len(output[idx]):
            # Fit the signal part into available output buffer by removing extra elements from the end.
            end_pos = -1*(len(sig) - len(output[idx]))
            sig = sig[:end_pos]
        elif len(sig) < len(output[idx]):
            # This should not happen, but prevent execution error by padding the end with zeroes.
            print('Warning: Calculated signal data was insufficient for output array length.')
            np.pad(sig, (0, len(output[idx]) - len(sig)), 'constant')
        # Filtering breaks contiguity, so make sure the result can be assigned.
        output[idx].assign(np.ascontiguousarray(sig, dtype='f'))
    return {
        'success': True
    }

def biosignal_filter_signal (sig, fs, filters = None):
    """
    Filter the given signal.\\
    Uses a Butterworth filter and forward + backward filtering passes under the hood.

    Parameters
    ----------

    sig : 1darray
        Numpy 1-dimensional array containing the signal to filter.
    fs : float
        Signal sampling frequency.
    filters : dict
        Optional filters to override the default filters in the form of\\
        `{ 'highpass': float, 'lowpass': float, 'notch': float }`

    Returns
    -------
    { 'success': bool, 'value': Filtered signal (if success), 'error': Error message (if an error occurred) }
    """
    if filters is None:
        filters = _biosignal['filters']
    try:
        if filters is not None:
            # Apply each filter individually.
            if filters['highpass'] is not None:
                sos_hp = biosignal_get_filter_coefficients(
                    'highpass',
                    filters['highpass']['Wn'],
                    fs,
                    filters['highpass']['N']
                )
                sig = signal.sosfiltfilt(sos_hp, sig)
            if filters['lowpass'] is not None:
                sos_lp = biosignal_get_filter_coefficients(
                    'lowpass',
                    filters['highpass']['Wn'],
                    fs,
                    filters['highpass']['N']
                )
                sig = signal.sosfiltfilt(sos_lp, sig)
            if filters['notch'] is not None:
                sos_notch = biosignal_get_filter_coefficients(
                    'notch',
                    filters['highpass']['Wn'],
                    fs,
                    filters['highpass']['N']
                )
                sig = signal.sosfiltfilt(sos_notch, sig)
        return {
            'success': True,
            'value': np.array(sig, dtype='f'),
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }

def biosignal_get_filter_coefficients (btype, Wn, fs, N=None):
    """
    Get SOS filter coefficients for the given filter.

    Parameters
    ----------
    btype : str
        Type of the filter (`highpass`, `lowpass`, or `notch`).
    Wn : float
        Critical frequency of the filter.
    fs : float
        Sampling frequency of the source signal.
    N : int
        Order of the filter (default for filter type used, if None).

    Returns
    -------
    SOS filter coefficients.
    """
    N_pass = _biosignal['filters']['N_pass']
    N_stop = _biosignal['filters']['N_stop']
    if btype == 'highpass':
        return signal.butter(N or N_pass, Wn, 'highpass', output='sos', fs=fs)
    if btype == 'lowpass':
        return signal.butter(N or N_pass, Wn, 'lowpass', output='sos', fs=fs)
    if btype == 'notch':
        return signal.butter(N or N_stop, [(Wn - 1), (Wn + 1)], 'bandstop', output='sos', fs=fs)
    return None

def biosignal_get_signals (channels):
    """
    Get signals according to the derivations in given `channels`.

    Parameters
    ----------
    channels : dict[]
        Properties of the channel derivations. Must include the following properties:
        - `active` (int): Index of the active channel in the `input` list.
        - `common_ref` (boolean): Is the reference of this channel shared by other channels of the same type.
        - `data` (Float32Array): Buffer to insert the derived signals into.
        - `data_gaps` (int[][]):  List of gaps in the singal data as [start index, end index].
        - `end` (int): Ending index (excluded) of the signal data in the input buffer, including filter padding.
            In case of index exceeding signal length, that amount of zeroes is added to the end of the signal as padding.
        - `filter_len` (int): Length of the filter part at the start and end of the signal array, in data points.
        - `filters` (dict): Channel filter critical frequencies as:\\
                            -- highpass (float or None to use default for signal type)\\
                            -- lowpass (float or None to use default for signal type)\\
                            -- notch (float or None to use default for signal type)
        - `reference` (int[]): List of channel indices to average as a reference signal.
        - `start` (int): Starting index (included) of the signal data in the input buffer, including filter padding.
            In case of a negative index, that amount of zeroes is added to the start of the signal as padding
        - `type` (str): Type of the signal.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    if _biosignal['buffers'] is None or _biosignal['input'] is None:
        return [None]*len(channels)
    input_sigs = _biosignal['input']
    # Cache common ref values (speeds up average reference calculations).
    common_ref = {}
    # Cache filter coefficients by sampling rate and filter frequency.
    hp_coeffs = {}
    lp_coeffs = {}
    notch_coeffs = {}
    signals = [None]*len(channels)
    # Per-call dedup of slice refreshes: when many montage channels share an active or
    # reference at the same range (e.g. average reference), copy that slice only once.
    refreshed = set()
    def _refresh(ch_idx, s, e):
        key = (ch_idx, s, e)
        if key in refreshed:
            return
        _refresh_channel_range(ch_idx, s, e)
        refreshed.add(key)
    for idx, chan in enumerate(channels):
        if 'active' not in chan:
            # Empty channel.
            continue
        # Determine the SAB range needed for this derivation (active and references share it).
        # Use the buffer length directly so we don't depend on `act` being allocated yet.
        buf_len = len(_biosignal['buffers'][chan['active']])
        act_len = buf_len - _biosignal['data_pos']
        # Store possibly needed pad amounts for range that exceeds imput signal range.
        pad_start = 0
        if chan['start'] < 0:
            pad_start = -1*chan['start']
        pad_end = 0
        if chan['end'] > act_len:
            pad_end = chan['end'] - act_len
        start_pos = _biosignal['data_pos'] + chan['start'] + pad_start
        end_pos = _biosignal['data_pos'] + chan['end'] - pad_end
        # Slice-refresh active and reference channels before any read. The header
        # (sampling_rate / updated_start / updated_end) is always refreshed inside
        # `_refresh_channel_range`, so the load-status check below sees live values.
        _refresh(chan['active'], start_pos, end_pos)
        for ref_idx in chan['reference']:
            _refresh(ref_idx, start_pos, end_pos)
        act = input_sigs[chan['active']]
        sig_fs = act[_biosignal['data_fields']['sampling_rate']]
        updated_start = act[_biosignal['data_fields']['updated_start']]
        if updated_start > start_pos or updated_start == _biosignal['empty_field']:
            # Pyodide does not support multithreading at the time of writing this. If a a request for signals is received before
            # the raw data has not been loaded we cannot simply wait to finish execution once data is available.
            # This is not ideal and should be improved when(/if) Pyodide implements threading.
            # Multithreading issue: https://github.com/pyodide/pyodide/issues/237.
            print('Pyodide: Requested signals have not been loaded yet (signal start ' + str(updated_start) + ' is out of range).')
            return signals
        updated_end = act[_biosignal['data_fields']['updated_end']]
        if updated_end < act_len and updated_end < end_pos:
            print('Pyodide: Requested signals have not been loaded yet (signal end ' + str(updated_end) + ' is out of range).')
            return signals
        # Calculate the channel derivation.
        sig_act = np.pad(act[start_pos:end_pos], (pad_start, pad_end), 'constant')
        # Insert possible data gaps.
        for gap in chan['data_gaps']:
            sig_act = np.concatenate((
                sig_act[:gap[0]],
                np.zeros(gap[1] - gap[0], dtype='f'),
                sig_act[gap[0]:]
            ))
        # Use common reference if possible to save computation time.
        if chan['common_ref'] and chan['type'] in common_ref:
            sig_ref = common_ref[chan['type']]
        else:
            sig_ref = np.zeros(len(sig_act), dtype='f')
            ref_chans = list()
            if len(chan['reference']) == 1:
                sig_ref = np.pad(
                    input_sigs[chan['reference'][0]][start_pos:end_pos],
                    (pad_start, pad_end),
                    'constant'
                )
            elif len(chan['reference']) > 1:
                for ref_ch in chan['reference']:
                    ref_chans.append(
                        np.pad(
                            input_sigs[ref_ch][start_pos:end_pos],
                            (pad_start, pad_end),
                            'constant'
                        )
                    )
                sig_ref = np.mean(ref_chans, axis=0)
            if len(chan['reference']) > 0:
                # Insert possible data gaps.
                for gap in chan['data_gaps']:
                    sig_ref = np.concatenate((
                        sig_ref[:gap[0]],
                        np.zeros(gap[1] - gap[0], dtype='f'),
                        sig_ref[gap[0]:]
                    ))
            # Save this if montage uses common reference.
            if chan['common_ref']:
                common_ref[chan['type']] = sig_ref
        sig = sig_act - sig_ref
        # Check if we should filter this signal.
        filt_hp = None
        filt_lp = None
        filt_notch = None
        if chan['filters'] is not None:
            # Use default or individual filters as needed.
            # None means use default, 0 means do not filter.
            if chan['filters']['highpass']:
                filt_key = (sig_fs, chan['filters']['highpass'])
                if filt_key in hp_coeffs:
                    filt_hp = hp_coeffs[filt_key]
                else:
                    filt_hp = biosignal_get_filter_coefficients(
                        'highpass', chan['filters']['highpass'], sig_fs
                    )
                    hp_coeffs[filt_key] = filt_hp
            if chan['filters']['lowpass']:
                filt_key = (sig_fs, chan['filters']['lowpass'])
                if filt_key in lp_coeffs:
                    filt_lp = lp_coeffs[filt_key]
                else:
                    filt_lp = biosignal_get_filter_coefficients(
                        'lowpass', chan['filters']['lowpass'], sig_fs
                    )
                    lp_coeffs[filt_key] = filt_lp
            if chan['filters']['notch']:
                filt_key = (sig_fs, chan['filters']['notch'])
                if filt_key in notch_coeffs:
                    filt_notch = notch_coeffs[filt_key]
                else:
                    filt_notch = biosignal_get_filter_coefficients(
                        'notch', chan['filters']['notch'], sig_fs
                    )
                    notch_coeffs[filt_key] = filt_notch
        if filt_hp is not None:
            sig = signal.sosfiltfilt(filt_hp, sig)
        if filt_lp is not None:
            sig = signal.sosfiltfilt(filt_lp, sig)
        if filt_notch is not None:
            sig = signal.sosfiltfilt(filt_notch, sig)
        # Remove data gaps in reverse order.
        for gap in reversed(chan['data_gaps']):
            gap_start = gap[0]
            gap_end = gap[1]
            if (gap_start == gap_end):
                continue
            sig = np.delete(sig, np.s_[gap_start:gap_end])
        signals[idx] = sig
    return signals

def biosignal_set_buffers ():
    """
    Set the `buffers` where signal data is read from.

    Parameters
    ----------
    Parameters required to be present from JS side:

    buffers : TypedArray[]
        List of views to the shared buffers that hold the input signals.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import buffers
        # Explicitly release old per-channel numpy arrays before replacing the list.
        # Without this, large arrays from long recordings (up to ~30 MB/channel) linger
        # until Python's GC runs, causing memory to grow with each opened recording.
        if _biosignal['input'] is not None:
            for i in range(len(_biosignal['input'])):
                _biosignal['input'][i] = None
        # Clear montage registry — channel indices are SAB-specific and invalid for the new recording.
        _biosignal['available_montages'].clear()
        _biosignal['montage'] = None
        _biosignal['buffers'] = buffers
        # Lazy per-channel allocation: each entry materialises on first access via
        # `_ensure_input_array`. Channels never touched by a compute step (e.g. a trend that
        # only reads two derivations) never allocate their full-channel numpy buffer.
        _biosignal['input'] = [None]*len(_biosignal['buffers'])
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set input buffer:', str(e)]
        }

def biosignal_set_default_filters ():
    """
    Set new default filter parameters.

    TODO: Precomputing coefficients for commonly used filters may save computing time
    when a large number of signals need to be filtered?

    Parameters
    ----------
    Parameters required to be present from JS side:

    filters : dict
        A dictionary of filter parameters as a dictionary containing the following properties:
        - `highpass`, `lowpass` and `notch` (dict|None):\\
        -- `Wn` (float): Critical frequency of the filter.\\
        -- `N` (int): Order of the filter (usually between 3-9, optional).

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import filters
        params = filters.to_py()
        if 'highpass' in params:
            highpass = params['highpass']
            if highpass is not None:
                if 'Wn' not in highpass:
                    return { 'success': False, 'error': "Highpass filter is missing parameter 'Wn'." }
                if 'N' not in highpass:
                    highpass['N'] = None
                _biosignal['filters']['highpass'] = highpass
            else:
                _biosignal['filters']['highpass'] = None
        if 'lowpass' in params:
            lowpass = params['lowpass']
            if lowpass is not None:
                if 'Wn' not in lowpass:
                    return { 'success': False, 'error': "Lowpass filter is missing parameter 'Wn'." }
                if 'N' not in lowpass:
                    lowpass['N'] = None
                _biosignal['filters']['lowpass'] = lowpass
            else:
                _biosignal['filters']['lowpass'] = None
        if 'notch' in params:
            notch = params['notch']
            if notch is not None:
                if 'Wn' not in notch:
                    return { 'success': False, 'error': "Notch filter is missing parameter 'Wn'." }
                if 'N' not in notch:
                    notch['N'] = None
                _biosignal['filters']['notch'] = notch
            else:
                _biosignal['filters']['notch'] = None
        return { 'success': True }
    except Exception as e:
        return { 'success': False, 'error': str(e) }

def biosignal_set_filter ():
    """
    Set new filter paramaters for a single filter type.

    Parameters
    ----------
    Parameters required to be present from JS side:

    btype : str
        Filter type; either 'lowpass', 'highpass' or 'notch'.
    Wn : float
        Critical frequency of the filter.
    fs : float
        Sampling frequency of the signal.
    N : int
        Order of the filter (usually between 3-9, None will use default for filter type).

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import Wn, btype, N
        if btype not in _biosignal['filters']:
            return { 'success': False, 'error': "Uknown filter type '" + str(btype) + "'." }
        _biosignal['filters'][btype] = {
            'Wn': Wn,
            'N': N or None,
        }
        return { 'success': True }
    except Exception as e:
        return { 'success': False, 'error': str(e) }

def biosignal_set_montage ():
    """
    Set currently active `montage`.

    Parameters
    ----------
    Parameters required to be present from JS side:

    name : str
        Name of the montage in the `available_montages` dictionary.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    from js import name
    if name not in _biosignal['available_montages']:
        return {
            'success': False,
            'error': "Cannot set montage, '" + name + "' cannot be found."
        }
    _biosignal['montage'] = _biosignal['available_montages'][name]
    return { 'success': True }

def biosignal_set_montage_filters ():
    """
    Set channel filters in currently active `montage`.

    Parameters
    ----------
    Parameters required to be present from JS side:

    name : str
        Name of the montage in the `available_montages` dictionary.
    filters : dict[]
        Filters for each channel in the montage.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    from js import montage, filters
    if montage not in _biosignal['available_montages']:
        return {
            'success': False,
            'error': "Cannot set filters for montage, '" + montage + "' cannot be found."
        }
    mtg = _biosignal['available_montages'][montage]
    flt = filters.to_py()
    for idx, chan in enumerate(mtg):
        chan['filters']['highpass']= flt[idx]['highpass']
        chan['filters']['lowpass'] = flt[idx]['lowpass']
        chan['filters']['notch'] = flt[idx]['notch']
    return { 'success': True }

def biosignal_set_output ():
    """
    Set the `output` buffers where signal processing results are set.

    Parameters
    ----------
    Parameters required to be present from JS side:

    buffers : TypedArray[]
        List of views to the shared buffers that should hold the output.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import buffers
        output = [None]*len(buffers)
        for idx, buf in enumerate(buffers):
            output[idx] = buf
        _biosignal['output'] = output
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set output buffer:', str(e)]
        }

def set_series_canvas ():
    """
    Set the canvas element for the series plot.

    Parameters
    ----------
    Parameters required to be present from JS side:

    canvas : Canvas
        Canvas element to draw the series plot on.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import canvas
        _biosignal['series_canvas'] = canvas
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set series canvas:', str(e)]
        }

def biosignal_set_topomap_canvas ():
    """
    Set the canvas element for the topomap plot.

    Parameters
    ----------
    Parameters required to be present from JS side:

    canvas : Canvas
        Canvas element to draw the topomap plot on.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    try:
        from js import canvas
        _biosignal['topomap_canvas'] = canvas
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set topomap canvas:', str(e)]
        }

def biosignal_refresh_channels ():
    """
    Eagerly refresh a specified set of channel-and-range slices in `input` from the live SAB.

    `biosignal_get_signals` already refreshes the slice it needs on demand, so callers that
    consume signals through that entry point need not call this. Use this primitive for
    workloads that read the same channel repeatedly in many small windows (e.g. trend
    computation scanning a full channel across many epochs, or source-localization epoch
    extraction across scattered event timestamps) — preloading the full needed range once
    avoids the per-call refresh overhead of slice copies inside the inner loop.

    JS params
    ---------
    specs : list of [channel_idx, start, end]
        Each entry triggers a slice refresh of `input[channel_idx][start:end]` from the SAB.
        The metadata header is always refreshed alongside each entry. `start` may be less
        than the data-position offset and `end` may exceed the channel length — both are
        clamped to valid SAB bounds, and out-of-bounds positions retain the zeros from
        lazy allocation (callers handle their own padding).

    Returns
    -------
    { 'success': bool, 'error': str (if an error occurred) }
    """
    if _biosignal['buffers'] is None or _biosignal['input'] is None:
        return { 'success': False, 'error': 'Buffers have not been set.' }
    try:
        from js import specs
        specs_py = specs.to_py()
        for entry in specs_py:
            _refresh_channel_range(int(entry[0]), int(entry[1]), int(entry[2]))
        return { 'success': True }
    except Exception as e:
        return { 'success': False, 'error': str(e) }
