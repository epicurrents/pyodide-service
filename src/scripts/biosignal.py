"""
Biosignal processing functions.
"""

import numpy as np
from scipy import signal
from time import sleep

biosignal = {
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
    is_common_ref : boolean
        

    Returns
    -------
    { 'success': bool, 'error': str / str[] (if an error occurred) }
    """
    global biosignal
    from js import channels, output
    input_sigs = biosignal['input']
    if input_sigs is None or len(input_sigs) == 0:
        return {
            'success': False,
            'error': "Cannot calculate signals, input has not been set."
        }
    biosignal_update_input()
    # Cache common ref values (speeds up average reference calculations).
    common_ref = {}
    # Cache filter coefficients by sampling rate and filter frequency.
    hp_coeffs = {}
    lp_coeffs = {}
    notch_coeffs = {}
    for idx, channel in enumerate(channels):
        chan = channel.to_py()
        if 'active' not in chan:
            # Empty channel.
            continue
        act = input_sigs[chan['active']]
        act_len = len(act) - biosignal['data_pos']
        sig_fs = act[biosignal['data_fields']['sampling_rate']]
        # Store possibly needed pad amounts for range that exceeds imput signal range.
        pad_start = 0
        if chan['start'] < 0:
            pad_start = -1*chan['start']
        pad_end = 0
        if chan['end'] > act_len:
            pad_end = chan['end'] - act_len
        start_pos = biosignal['data_pos'] + chan['start'] + pad_start
        if act[biosignal['data_fields']['updated_start']] > start_pos or act[biosignal['data_fields']['updated_start']] == biosignal['empty_field']:
            # Signals have not been loaded yet.
            return {
                'success': False,
                'error': "Requested signals have not been loaded yet."
            }
        end_pos = biosignal['data_pos'] + chan['end'] - pad_end
        if act[biosignal['data_fields']['updated_end']] < act_len and act[biosignal['data_fields']['updated_end']] < end_pos:
            return {
                'success': False,
                'error': "Requested signals have not been loaded yet."
            }
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
            # Default filters are not used at the moment.
            #elif biosignal['filters']['highpass'] is not None:
            #    filt_hp = biosignal_get_filter_coefficients(
            #        'highpass', biosignal['filters']['highpass']['Wn'], sig_fs
            #    )
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
        # Remove possible filter paddings from start and end.
        if chan['filter_len'] > 0:
            sig = sig[chan['trim_start']:chan['trim_end']]
        # Fit the signal part into available output buffer by removing extra elements from the end.
        if len(sig) > len(output[idx]):
            end_pos = -1*(len(sig) - len(output[idx]))
            sig = sig[:end_pos]
        # Filtering breaks contiguity, so make sure the result can be assigned.
        output[idx].assign(np.ascontiguousarray(sig, dtype='f'))
    return {
        'success': True
    }
    #except Exception as e:
    #    print(e)
    #    return {
    #        'success': False,
    #        'error': ['Failed to compute signals:', str(e)]
    #    }

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
    if filters is None:
        filters = biosignal['filters']
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
    N_pass = biosignal['filters']['N_pass']
    N_stop = biosignal['filters']['N_stop']
    if btype == 'highpass':
        return signal.butter(N or N_pass, Wn, 'highpass', output='sos', fs=fs)
    if btype == 'lowpass':
        return signal.butter(N or N_pass, Wn, 'lowpass', output='sos', fs=fs)
    if btype == 'notch':
        return signal.butter(N or N_stop, [(Wn - 1), (Wn + 1)], 'bandstop', output='sos', fs=fs)
    return None

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
    global biosignal
    try:
        from js import buffers
        biosignal['buffers'] = buffers
        biosignal['input'] = [None]*len(biosignal['buffers'])
        for idx, buf in enumerate(biosignal['buffers']):
            biosignal['input'][idx] = np.asarray(buf.to_py(), dtype='f')
        return { 'success': True }
    except Exception as e:
        return {
            'success': False,
            'error': ['Failed to set input buffer:', str(e)]
        }

def biosignal_set_default_filters ():
    """
    Set new default filter paramaters. Precomputing coefficients for commonly used filters saves computing time
    when signals need to be filtered.

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
    global biosignal
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
                biosignal['filters']['highpass'] = highpass
            else:
                biosignal['filters']['highpass'] = None
        if 'lowpass' in params:
            lowpass = params['lowpass']
            if lowpass is not None:
                if 'Wn' not in lowpass:
                    return { 'success': False, 'error': "Lowpass filter is missing parameter 'Wn'." }
                if 'N' not in lowpass:
                    lowpass['N'] = None
                biosignal['filters']['lowpass'] = lowpass
            else:
                biosignal['filters']['lowpass'] = None
        if 'notch' in params:
            notch = params['notch']
            if notch is not None:
                if 'Wn' not in notch:
                    return { 'success': False, 'error': "Notch filter is missing parameter 'Wn'." }
                if 'N' not in notch:
                    notch['N'] = None
                biosignal['filters']['notch'] = notch
            else:
                biosignal['filters']['notch'] = None
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
    global biosignal
    try:
        from js import Wn, btype, N
        if btype not in biosignal['filters']:
            return { 'success': False, 'error': "Uknown filter type '" + str(btype) + "'." }
        biosignal['filters'][btype] = {
            'Wn': Wn,
            'N': N or None,
        }
        return { 'success': True }
    except Exception as e:
        return { 'success': False, 'error': str(e) }

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

def biosignal_update_input ():
    """
    Update `input` to the data contained in `buffers`

    Returns
    -------
    True on success, False on error.
    """
    global biosignal
    if biosignal['input'] is None:
        return False
    try:
        for idx, buf in enumerate(biosignal['buffers']):
            buf.assign_to(biosignal['input'][idx])
        return True
    except Exception as e:
        False