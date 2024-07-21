"""
Biosignal processing functions.

Only a single set of `input` and `output` channels may be active at a time.
"""

import numpy as np
from scipy import signal

biosignal = {
    'available_montages': dict(),
    'filter_params': None,
    'input': None,
    'montage': None,
    'output': None,
}
""" 
Global variables used in these methods.
- `available_montages`: Dictionary of available montages with the montage name as key and list of channels as value.
- `filter_params`: Dictionary of Butterworth filter params `N`, `Wn`, and `btype`; or None if not set.
- `input`: List of input signals as NDArrays, or none if not set.
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
    True on success, False otherwise.
    """
    global biosignal
    from js import name, channels
    montage = [None]*len(channels)
    for idx, chan in enumerate(channels):
        montage[idx] = chan.to_py()
    biosignal['available_montages'][name] = montage
    return True

def biosignal_compute_signals ():
    """
    Compute signals from the global `input` using the currently active global `montage`.
    Computed signals are set to global `output` list.
    """
    input = biosignal['input']
    montage = biosignal['montage']
    output = biosignal['output']
    if input is None or len(input) == 0:
        print("Cannot filter signal, input has not been set.")
        return False
    if output is None or len(output) == 0:
        print("Cannot filter signal, output has not been set.")
        return False
    if montage is None:
        print("Cannot filter signal, active montage has not been set.")
        return False
    if len(montage) != len(output):
        print("Cannot filter signal, montage and output have different number of channels.")
        return False
    try:
        for idx, chan in enumerate(montage):
            act = input[chan['active']]
            ref = np.zeros(len(act), dtype='f')
            ref_chans = list()
            if len(chan['reference']) == 1:
                ref = input[chan['reference'][0]]
            elif len(chan['reference']) > 1:
                for ref_ch in chan['reference']:
                    ref_chans.append(input[ref_ch])
                ref = np.mean(ref_chans, axis=0)
            filtered = biosignal_filter_signal(act - ref, chan['sampling_rate'])
            output[idx].assign(np.array(filtered, dtype='f'))
        return True
    except Exception as e:
        print('Failed to compute signals:')
        print(e)
        return False

def biosignal_filter_signal (sig, fs):
    """
    Filter the given signal.\\
    Uses a Butterworth filter and forward + backward filtering passes under the hood.

    Parameters
    ----------

    sig : NDArray
        Numpy array containing the signal to filter.
    fs : float
        Signal sampling frequency.

    Returns
    -------
    Filtered signal or None on error.
    """
    global biosignal
    params = biosignal['filter_params']
    try:
        sos = signal.butter(
            params['N'],
            params['Wn'],
            params['btype'],
            output='sos',
            fs=fs
        )
        return signal.sosfiltfilt(sos, sig)
    except Exception as e:
        print('Failed to filter signal:')
        print(e)
        return None

def biosignal_set_filter ():
    """
    Set new filter paramaters.

    Parameters
    ----------
    Parameters required to be present from JS side:

    N : int
        Order of the filter (usually between 3-9).
    btype : str
        Filter type; either 'lowpass', 'highpass', 'bandpass' or 'bandstop'.
    Wn : float/float[]
        Critical frequencies, list of two floats for 'badpass', single float for the others.
    """
    global biosignal
    from js import Wn, btype, N
    biosignal['filter_params'] = {
        'Wn': Wn,
        'btype': btype,
        'N': N,
    }

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
    True on success, False on failure.

    """
    global biosignal
    try:
        from js import buffers
        input = [None]*len(buffers)
        for idx, buf in enumerate(buffers):
            input[idx] = np.asarray(buf.to_py(), dtype='f')
        biosignal['input'] = input
        return True
    except Exception as e:
        print('Failed to set input buffer:')
        print(e)
        return False
    
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
    True on success, False on failure.
    """
    global biosignal
    from js import name
    if name not in biosignal['available_montages']:
        print('Cannot set montage, %s has not been added yet.', name)
        return False
    biosignal['montage'] = biosignal['available_montages'][name]
    return True

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
    True on success, False on failure.

    """
    global biosignal
    try:
        from js import buffers
        output = [None]*len(buffers)
        for idx, buf in enumerate(buffers):
            output[idx] = buf
        biosignal['output'] = output
        return True
    except Exception as e:
        print('Failed to set output buffer:')
        print(e)
        return False