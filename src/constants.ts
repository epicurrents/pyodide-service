/**
 * Shared constants for the Pyodide service, used by both the worker layer and the main-thread runner.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 *
 * Pyodide is licenced under MPL-2.0. Source: https://github.com/pyodide/pyodide/
 */

/**
 * Default upstream Pyodide location, used when no ``indexURL`` is configured. This is the single source of
 * truth for the pinned Pyodide version — both the worker (`loadPyodideRuntime`) and the main-thread
 * `PyodideRunner` fall back to it, so a version bump happens in exactly one place.
 */
export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/'
