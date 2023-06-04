import * as fs from 'node:fs/promises';
import createDebug from 'debug';
import persist from 'node-persist';
import express from 'express';
import { ResponseError } from '../util/http-server.js';

const debug = createDebug('nxapi:znca-api:server:util');

const wrapper = [
    'const module = {exports: {}}; (function (module, exports) { ',
    '\n})(module, module.exports);',
];

const init_script = `
for (const key of Object.keys(module.exports)) {
    if (typeof module.exports[key] === 'function') {
        rpc.exports[key] = module.exports[key];
    }
}
`;

export async function getFridaScript(script_path: string | URL) {
    const script_cjs = await fs.readFile(script_path, 'utf-8');
    const script = wrapper[0] + script_cjs + wrapper[1] + init_script;

    return script;
}

export const LIMIT_REQUESTS = 4;
export const LIMIT_PERIOD = 60 * 60 * 1000; // 60 minutes

type RateLimitAttempts = number[];

export async function checkUseLimit(
    storage: persist.LocalStorage,
    key: string, user: string, req: express.Request,
    /** Set to false to count the attempt but ignore the limit */ ratelimit = true,
    limits: [requests: number, period_ms: number] = [LIMIT_REQUESTS, LIMIT_PERIOD],
) {
    let attempts: RateLimitAttempts = await storage.getItem('RateLimitAttempts-' + key + '.' + user) ?? [];
    attempts = attempts.filter(a => a >= Date.now() - limits[1]);

    if (ratelimit && attempts.length >= limits[0]) {
        debug('User %s from %s (%s) exceeded rate limit', user, req.ips, req.headers['user-agent'], key, attempts);
        throw new ResponseError(429, 'rate_limit', 'Too many attempts to authenticate');
    }

    attempts.unshift(Date.now());
    await storage.setItem('RateLimitAttempts-' + key + '.' + user, attempts);

    debug('rate limit', key, user, req.ips, attempts);
}
