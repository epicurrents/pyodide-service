"""
Biosignal processing functions.
"""

import numpy as np
from scipy import signal

biosignal = {
    'available_montages': dict(),
    'data_fields': None,
    'data_pos': None,
    'filters': {
        'highpass': None,
        'lowpass': None,
        'notch': None,
        'N_pass': 6,
        'N_stop': 9, # Use a higher N for bandstop filters.
        'padding': 0,
    },
    'input': None,
    'montage': None,
    'output': None,
}
""" 
Global variables used in these methods.
- `available_montages`: Dictionary of available montages with the montage name as key and list of channels as value.
- `data_fields`: Dictionary of data field names and positions (float32 index) within the input arrays.
- `data_pos`: Starting position (float32 index) of the signal data in input arrays.
- `filters`: Dictionary of default filter params; None for filter types if not set.
- `input`: List of input signals as 1d numpy arrays, or None if not set.
- `montage`: Currently active montage from `available_montages`, or None if not set.
- `output`: List of output signals where processing results should be written, or None if not set.
"""

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
    global biosignal
    from js import name, channels
    montage = [None]*len(channels)
    for idx, chan in enumerate(channels):
        montage[idx] = chan.to_py()
    biosignal['available_montages'][name] = montage
    return { 'success': True }

def biosignal_compute_signals ():
    """
    Compute signals from the `input` using the currently active `montage`.
    Computed signals are set to `output` as a list.

    Parameters
    ----------
    Parameters required to be present from JS side:

    range : float[]
        Starting index and ending index of the signal from input.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    from js import range as sig_range, channels
    input = biosignal['input']
    montage = biosignal['montage']
    output = biosignal['output']
    if input is None or len(input) == 0:
        return {
            'success': False,
            'error': "Cannot compute signals, input has not been set."
        }
    if output is None or len(output) == 0:
        return {
            'success': False,
            'error': "Cannot compute signals, output has not been set."
        }
    if montage is None:
        return {
            'success': False,
            'error': "Cannot compute signals, active montage has not been set."
        }
    if len(channels) != len(output):
        return {
            'success': False,
            'error': "Cannot compute signals, requested channels and output have different lengths."
        }
    try:
        out_idx = 0
        for idx, chan in enumerate(montage):
            if idx not in channels:
                continue
            if out_idx == len(output):
                break
            act = input[chan['active']]
            out = output[out_idx]
            sig_fs = act[biosignal['data_fields']['sampling_rate']]
            start_pos = biosignal['data_pos'] + round(sig_fs*sig_range[0])
            # This is how the array slice is calculated on JS side and it is important that they match.
            end_pos = start_pos + len(out)
            pad_end = 0
            # Check that the input has enough data to fill the requested output buffer.
            if len(act) < end_pos:
                pad_end = end_pos - len(act)
                end_pos = len(act)
            # Add filter paddings, if needed.
            filt_start_samples = 0
            filt_start_zeroes = 0
            filt_end_samples = 0
            filt_end_zeroes = 0
            # TODO: Check that some filter is actually != 0.
            apply_filters = biosignal['filters']['padding'] > 0 and chan['filters']
            if apply_filters:
                filt_samples = round(biosignal['filters']['padding']*sig_fs)
                if (start_pos > biosignal['data_pos'] + filt_samples):
                    filt_start_samples = filt_samples
                else:
                    filt_start_samples = start_pos - biosignal['data_pos']
                    filt_start_zeroes = filt_samples - filt_start_samples
                if len(act) >= end_pos + filt_samples:
                    filt_end_samples = filt_samples
                else:
                    filt_end_samples = len(act) - end_pos
                    filt_end_zeroes = filt_samples - filt_end_samples
                start_pos = start_pos - filt_start_samples
                end_pos = end_pos + filt_end_samples
            sig = np.pad(act[start_pos:end_pos], (filt_start_zeroes, filt_end_zeroes), 'constant')
            ref = np.zeros(len(sig), dtype='f')
            ref_chans = list()
            if len(chan['reference']) == 1:
                ref = np.pad(
                    input[chan['reference'][0]][start_pos:end_pos],
                    (filt_start_zeroes, filt_end_zeroes),
                    'constant'
                )
            elif len(chan['reference']) > 1:
                for ref_ch in chan['reference']:
                    ref_chans.append(
                        np.pad(
                            input[ref_ch][start_pos:end_pos],
                            (filt_start_zeroes, filt_end_zeroes),
                            'constant'
                        )
                    )
                ref = np.mean(ref_chans, axis=0)
            filters = None
            if chan['filters']:
                filters = {
                    'highpass': None,
                    'lowpass': None,
                    'notch': None,
                }
                f = biosignal['filters']
                if chan['filters']['highpass']:
                    filters['highpass'] = {
                        'N': f['highpass']['N'] if f['highpass'] is not None else None,
                        'Wn': chan['filters']['highpass']
                    }
                if chan['filters']['lowpass']:
                    filters['lowpass'] = {
                        'N': f['lowpass']['N'] if f['lowpass'] is not None else None,
                        'Wn': chan['filters']['lowpass']
                    }
                if chan['filters']['notch']:
                    filters['notch'] = {
                        'N': f['notch']['N'] if f['notch'] is not None else None,
                        'Wn': chan['filters']['notch']
                    }
            filtered = biosignal_filter_signal(sig - ref, chan['sampling_rate'], filters)
            if not filtered['success']:
                return {
                    'success': False,
                    'error': ["Cannot compute signals, filtering failed:", filtered['error']]
                }
            # Remove possible filters.
            if apply_filters:
                filt_start_total = filt_start_samples + filt_start_zeroes
                filt_end_total = filt_end_samples + filt_end_zeroes
                filtered['value'] = filtered['value'][filt_start_total:-filt_end_total]
            out.assign(np.pad(filtered['value'], (0, pad_end), 'constant'))
            out_idx += 1
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to compute signals:', str(e)]
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
    global biosignal
    N_pass = biosignal['filters']['N_pass']
    N_stop = biosignal['filters']['N_stop']
    nyq = 1#0.5*fs
    if filters is None:
        filters = biosignal['filters']
    try:
        if filters is not None:
            # Apply each filter individually.
            if filters['highpass'] is not None:
                sos_hp = signal.butter(
                    filters['highpass']['N'] or N_pass,
                    filters['highpass']['Wn']/nyq,
                    'highpass',
                    output='sos',
                    fs=fs
                )
                sig = signal.sosfiltfilt(sos_hp, sig)
            if filters['lowpass'] is not None:
                sos_lp = signal.butter(
                    filters['lowpass']['N'] or N_pass,
                    filters['lowpass']['Wn']/nyq,
                    'lowpass',
                    output='sos',
                    fs=fs
                )
                sig = signal.sosfiltfilt(sos_lp, sig)
            if filters['notch'] is not None:
                sos_notch = signal.butter(
                    filters['notch']['N'] or N_stop,
                    [
                        (filters['notch']['Wn'] - 1)/nyq,
                        (filters['notch']['Wn'] + 1)/nyq,
                    ],
                    'bandstop',
                    output='sos',
                    fs=fs
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

def biosignal_set_filter ():
    """
    Set new filter paramaters.

    Parameters
    ----------
    Parameters required to be present from JS side:

    N : int
        Order of the filter (usually between 3-9).
    btype : str
        Filter type; either 'lowpass', 'highpass' or 'notch'.
    Wn : float
        Critical frequency of the filter.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    global biosignal
    from js import Wn, btype, N
    if btype == 'highpass':
        biosignal['filters']['highpass']['Wn'] = Wn
        if N is not None:
            biosignal['filters']['highpass']['N'] = N
    elif btype == 'lowpass':
        biosignal['filters']['lowpass']['Wn'] = Wn
        if N is not None:
            biosignal['filters']['lowpass']['N'] = N
    elif btype == 'notch':
        biosignal['filters']['notch']['Wn'] = Wn
        if N is not None:
            biosignal['filters']['notch']['N'] = N
    return { 'success': True }

def biosignal_set_filter_padding ():
    """
    Set the amount of padding used when filterin signals.

    Parameters
    ----------
    Parameters required to be present from JS side:

    padding : float
        Padding amount before and after the signal segment to filter, in seconds.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    global biosignal
    from js import padding
    biosignal['filters']['padding'] = padding
    return { 'success': True }

def biosignal_set_input ():
    """
    Set the  `input` buffers where signal data is read from.

    Parameters
    ----------
    Parameters required to be present from JS side:

    buffers : TypedArray[]
        List of views to the shared buffers that hold the input signals.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    global biosignal
    try:
        from js import buffers
        input = [None]*len(buffers)
        for idx, buf in enumerate(buffers):
            input[idx] = np.asarray(buf.to_py(), dtype='f')
        biosignal['input'] = input
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set input buffer:', str(e)]
        }
   
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
    global biosignal
    from js import name
    if name not in biosignal['available_montages']:
        return {
            'success': False,
            'error': "Cannot set montage, '" + name + "' cannot be found."
        }
    biosignal['montage'] = biosignal['available_montages'][name]
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
    global biosignal
    from js import montage, filters
    if montage not in biosignal['available_montages']:
        return {
            'success': False,
            'error': "Cannot set filters for montage, '" + montage + "' cannot be found."
        }
    #try:
    mtg = biosignal['available_montages'][montage]
    flt = filters.to_py()
    for idx, chan in enumerate(mtg):
        chan['filters']['highpass']= flt[idx]['highpass']
        chan['filters']['lowpass'] = flt[idx]['lowpass']
        chan['filters']['notch'] = flt[idx]['notch']
    return { 'success': True }
    #except Exception as e:
    #    return {
    #        'success': False,
    #        'error': ['Failed to set montage filters:', str(e)]
    #    }
 
def biosignal_setup ():
    """
    Set up the biosignal recording used in computations.

    Parameters
    ----------
    Parameters required to be present from JS side:

    data_pos : number
        Starting position of the signal data.
    data_fields : dict
        Names and positions of possible data fields in the data array.
    filter_padding : float
        Amount of padding used when filtering signals, in seconds.
    signals : Float32Array
        Float32Array view to the data containing the signals.

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    global biosignal
    from js import data_pos, data_fields, filter_padding, signals
    biosignal['data_pos'] = data_pos
    biosignal['data_fields'] = data_fields.to_py()
    biosignal['filters']['padding'] = filter_padding
    biosignal['input'] = []
    for arr in signals:
        biosignal['input'].append(np.asarray(arr.to_py(), dtype='f').view())

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
    global biosignal
    try:
        from js import buffers
        output = [None]*len(buffers)
        for idx, buf in enumerate(buffers):
            output[idx] = buf
        biosignal['output'] = output
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set output buffer:', str(e)]
        }