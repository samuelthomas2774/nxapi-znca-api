export interface PackageInfo {
    name: string;
    version: string;
    build: number;
}

export interface FRequest {
    hash_method: '1' | '2';
    token: string;
    timestamp?: string | number;
    request_id?: string;
    na_id?: string;
    coral_user_id?: string;
}

export interface FResult {
    f: string;
    timestamp: string | number;
    /** Queue wait duration */
    dw: number;
    /** Initialisation duration */
    di: number;
    /** Processing duration */
    dp: number;
}
