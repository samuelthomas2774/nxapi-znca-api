import { JwtPayload } from './jwt.js';

export type FridaScriptExports<T> = {
    [K in keyof T]:
        T[K] extends (...args: infer A) => Promise<infer R> ? T[K] :
        T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> :
        never;
};

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
