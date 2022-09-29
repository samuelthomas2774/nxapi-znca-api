import { JwtPayload } from "../util/jwt.js";

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
    /** Do not attempt to start the app - if it is not already running the server will fail */
    NONE,
}

export interface FridaScriptExports {
    ping(): Promise<true>;
    getPackageInfo(): Promise<PackageInfo>;
    getSystemInfo(): Promise<SystemInfo>;
    genAudioH(token: string, timestamp: string | number | undefined, request_id: string): Promise<FResult>;
    genAudioH2(token: string, timestamp: string | number | undefined, request_id: string): Promise<FResult>;
}

export interface PackageInfo {
    name: string;
    version: string;
    build: number;
}
export interface SystemInfo {
    board: string;
    bootloader: string;
    brand: string;
    abis: string[];
    device: string;
    display: string;
    fingerprint: string;
    hardware: string;
    host: string;
    id: string;
    manufacturer: string;
    model: string;
    product: string;
    tags: string;
    time: string;
    type: string;
    user: string;

    version: {
        codename: string;
        release: string;
        // release_display: string;
        sdk: string;
        sdk_int: number;
        security_patch: string;
    };
}

export interface FRequest {
    hash_method: '1' | '2' | 1 | 2;
    token: string;
    timestamp?: string | number;
    request_id?: string;
}

export interface FResult {
    f: string;
    timestamp: string;
    /** Queue wait duration */
    dw: number;
    /** Initialisation duration */
    di: number;
    /** Processing duration */
    dp: number;
}

export interface NintendoAccountIdTokenJwtPayload extends JwtPayload {
    /** Subject (Nintendo Account ID) */
    sub: string;
    iat: number;
    exp: number;
    /** Audience (client ID) */
    aud: string;
    iss: 'https://accounts.nintendo.com';
    jti: string;
    at_hash: string; // ??
    typ: 'id_token';
    country: string;
}
export interface CoralJwtPayload extends JwtPayload {
    isChildRestricted: boolean;
    membership: {
        active: boolean;
    };
    aud: string;
    exp: number;
    iat: number;
    iss: 'api-lp1.znc.srv.nintendo.net';
    /** Coral user ID (CurrentUser.id, not CurrentUser.nsaId) */
    sub: number;
    typ: 'id_token';
}
