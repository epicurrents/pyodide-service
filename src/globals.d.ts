/**
 * Global property type declarations.
 * @package    @epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/* eslint-disable */
/**
 * Epicurrents properties available in the global scope.
 */
type EpicurrentsGlobal = {
    /**
     * Runtime state manager of the initiated application (must be initiated before creating resources).
     */
    RUNTIME: import('@epicurrents/core/dist/types/application').StateManager
}
type OpenDirectoryOptions = {
    /**
     * By specifying an ID, the browser can remember different directories for different IDs. If the same ID is used
     * for another picker, the picker opens in the same directory.
     */
    id?: string
    /**
     * A string that defaults to "read" for read-only access or "readwrite" for read and write access to the directory.
     */
    mode?: 'read' | 'readwrite'
    /**
     * A FileSystemHandle or a well known directory ("desktop", "documents", "downloads", "music", "pictures", or
     * "videos") to open the dialog in.
     */
    startIn?: FileSystemHandle | string
}
declare global {
    /** Path where WebPack serves its public assets (js) from. */
    let __webpack_public_path__: string
    interface Window {
        /**
         * Runtime state manager of the initiated application. Having the runtime accessible in the window object is a
         * workaround for cases, where different modules may implement different versions of the core package and thus
         * the imported `SETTINGS` may not point to the same object.
         *
         * If the `core` dependency of all the modules point to the same package at the time of compilation, the
         * imported runtime `state` will also point to the same object and stay synchronized between the modules.
         * See documentation for more details.
         */
        __EPICURRENTS__: EpicurrentsGlobal
        /**
         * Experimental FileSystemAPI directory picker. May not be available in the user's browser.
         * @param options - Options for the picker; optional.
         * @returns Promise of a FileSystemDirectoryHandle.
         */
        showDirectoryPicker: (options?: OpenDirectoryOptions) => Promise<FileSystemDirectoryHandle>
    }
}
export {} // Guarantees the global declaration to work.
