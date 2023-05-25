import { FridaScriptExports as ScriptExports } from '../util/types.js';
import type { PackageInfo, SystemInfo, FResult } from './frida-script.cjs';

export enum StartMethod {
    /** Spawn the app process with Frida, even if the app is already running (recommended) */
    SPAWN,
    /** Start the app's main activity using the am command */
    ACTIVITY,
    /**
     * Start a background service using the am command (default)
     * This tricks Android into not killing the app for some reason and allows the process to be started
     * in the background.
     */
    SERVICE,
    /** Same as ACTIVITY, but kill the app first */
    FORCE_ACTIVITY,
    /** Same as SERVICE, but kill the app first */
    FORCE_SERVICE,
    /** Do not attempt to start the app - if it is not already running the server will fail */
    NONE,
}

export type FridaScriptExports = ScriptExports<typeof import('./frida-script.cjs')>;

export interface FRequest {
    hash_method: '1' | '2';
    token: string;
    timestamp?: string | number;
    request_id?: string;
}

export {
    PackageInfo,
    SystemInfo,
    FResult,
}
