/**
 * Pyodide worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

/* eslint-disable */

import type { WorkerMessage } from '@epicurrents/core/dist/types'
import PyodideMontageWorker from '#workers/PyodideMontageWorker'

importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js")

//const SCOPE = "pyodide.worker"

const PYODIDE = new PyodideMontageWorker()

onmessage = async (message: WorkerMessage) => {
    PYODIDE.handlePythonMessage(message)
}
