import * as os from 'node:os';
import createDebug from 'debug';
import { v4 as uuidgen } from 'uuid';
import express from 'express';
import bodyParser from 'body-parser';
import { getJwks, Jwt } from '../util/jwt.js';
import { product } from '../util/product.js';
import { FRequest, FResult, FridaScriptExports, PackageInfo, StartMethod, SystemInfo } from './types.js';
import { CoralJwtPayload, NintendoAccountIdTokenJwtPayload } from '../util/types.js';
import { HttpServer, ResponseError } from '../util/http-server.js';

const ZNCA_CLIENT_ID = '71b963c1b7b6d119';

const debug = createDebug('nxapi:znca-api:android-frida-server:api');

export default class Server extends HttpServer {
    start_method = StartMethod.SPAWN;
    validate_tokens = true;
    strict_validate = false;
    reattach: (() => void) | null = null;
    health_ttl = 30 * 1000; // 30 seconds

    readonly app: express.Express;

    ready: Promise<void> | null = null;
    api: FridaScriptExports | null = null;
    package_info: PackageInfo | null = null;
    system_info: SystemInfo | null = null;

    last_result: {
        req: express.Request;
        data?: FRequest;
        result: FResult;
        time: Date;
        dv?: number;
        da?: number;
    } | null = null;

    constructor() {
        super();

        const app = this.app = express();

        app.use('/api/znca', (req, res, next) => {
            console.log('[%s] %s %s HTTP/%s from %s, port %d%s, %s',
                new Date(), req.method, req.path, req.httpVersion,
                req.socket.remoteAddress, req.socket.remotePort,
                req.headers['x-forwarded-for'] ? ' (' + req.headers['x-forwarded-for'] + ')' : '',
                req.headers['user-agent']);

            res.setHeader('Server', product + ' android-frida-server');
            res.setHeader('X-Server', product + ' android-frida-server');
            res.setHeader('X-Served-By', os.hostname());

            if (this.package_info && this.system_info) {
                res.setHeader('X-Android-Build-Type', this.system_info.type);
                res.setHeader('X-Android-Release', this.system_info.version.release);
                res.setHeader('X-Android-Platform-Version', this.system_info.version.sdk_int);
                res.setHeader('X-znca-Platform', 'Android');
                res.setHeader('X-znca-Version', this.package_info.version);
                res.setHeader('X-znca-Build', this.package_info.build);
            }

            next();
        });

        app.post('/api/znca/f', bodyParser.json(), this.createApiRequestHandler((req, res) =>
            this.handleFRequest(req, res)));
        app.get('/api/znca/health', this.createApiRequestHandler((req, res) =>
            this.handleHealthRequest(req, res)));
    }

    async handleFRequest(req: express.Request, res: express.Response) {
        const start = Date.now();

        if (req.body && 'type' in req.body) req.body = {
            hash_method:
                req.body.type === 'nso' ? '1' :
                req.body.type === 'app' ? '2' : null!,
            token: req.body.token,
            timestamp: '' + req.body.timestamp,
            request_id: req.body.uuid,
        };

        if (req.body && typeof req.body.hash_method === 'number') req.body.hash_method = '' + req.body.hash_method;

        const data: FRequest = req.body;

        if (
            !data ||
            typeof data !== 'object' ||
            (data.hash_method !== '1' && data.hash_method !== '2') ||
            typeof data.token !== 'string' ||
            (data.timestamp && typeof data.timestamp !== 'string' && typeof data.timestamp !== 'number') ||
            (data.request_id && typeof data.request_id !== 'string')
        ) {
            throw new ResponseError(400, 'invalid_request');
        }

        try {
            await this.validateFRequest(req, data);
        } catch (err) {
            debug('Error validating request from %s', req.ip, err);
            res.setHeader('Server-Timing', 'validate;dur=' + (Date.now() - start));
            throw err;
        }

        const validated = Date.now();

        const timestamp = 'timestamp' in data ? '' + data.timestamp : undefined;
        const request_id = 'request_id' in data ? data.request_id! : uuidgen();

        return this.handleRetryAfterReattach(req, res, async () => {
            const was_connected = !this.ready;
            await this.ready;
            const connected = Date.now();

            debug('Calling %s', data.hash_method === '2' ? 'genAudioH2' : 'genAudioH');

            const result = data.hash_method === '2' ?
                await this.api!.genAudioH2(data.token, timestamp, request_id) :
                await this.api!.genAudioH(data.token, timestamp, request_id);

            this.last_result = {
                req, data, result, time: new Date(),
                dv: validated - start,
                da: !was_connected ? connected - validated : undefined,
            };

            debug('Returned %s', result);

            const response = {
                f: result.f,
                timestamp: data.timestamp ? undefined : result.timestamp,
                request_id: data.request_id ? undefined : request_id,
            };

            res.setHeader('Server-Timing',
                'validate;dur=' + (validated - start) + ',' +
                (!was_connected ? 'attach;dur=' + (connected - validated) + ',' : '') +
                'queue;dur=' + result.dw + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);
            return response;
        });
    }

    async handleHealthRequest(req: express.Request, res: express.Response) {
        if (this.last_result && this.last_result.time.getTime() > (Date.now() - this.health_ttl)) {
            res.setHeader('Server-Timing',
                'queue;dur=' + this.last_result.result.dw + ',' +
                'init;dur=' + this.last_result.result.di + ',' +
                'process;dur=' + this.last_result.result.dp);
            return {last_result_at: new Date(this.last_result.time).toUTCString()};
        }

        const start = Date.now();

        return this.handleRetryAfterReattach(req, res, async () => {
            const was_connected = !this.ready;
            await this.ready;
            const connected = Date.now();

            debug('Test gen_audio_h');

            const result = await this.api!.genAudioH('id_token', 'timestamp', 'request_id');

            this.last_result = {
                req, result, time: new Date(),
                da: !was_connected ? connected - start : undefined,
            };

            debug('Test returned %s', result);

            res.setHeader('Server-Timing',
                (!was_connected ? 'attach;dur=' + (connected - start) + ',' : '') +
                'queue;dur=' + result.dw + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);
            return {last_result_at: this.last_result.time.toUTCString()};
        });
    }

    async handleRetryAfterReattach<T>(
        req: express.Request, res: express.Response,
        handle: () => Promise<T>,
        /** @internal */ _attempts = 0
    ): Promise<T> {
        try {
            return await handle();
        } catch (err) {
            if ((err as any)?.message === 'Script is destroyed' && this.reattach) {
                this.reattach?.();

                if (!_attempts) {
                    debug('Error in request from %s, retrying', req.ip, err);
                    return this.handleRetryAfterReattach(req, res, handle, _attempts + 1);
                }
            }

            debug('Error in request from %s', req.ip, err);

            throw new ResponseError(500, 'unknown');
        }
    }

    async validateFRequest(req: express.Request, data: FRequest) {
        const errors: {error: string; error_message: string}[] = [];

        const hash_method = '' + data.hash_method as '1' | '2';

        try {
            await this.validateToken(req, data.token, hash_method, errors);
        } catch (err) {
            if (this.validate_tokens) errors.push({error: 'invalid_token', error_message: (err as Error).message});
            debug('Error validating token from %s, continuing anyway', req.ip, err);
        }

        if (this.strict_validate && 'timestamp' in data) {
            if (!/^\d+$/.test('' + data.timestamp)) {
                errors.push({error: 'invalid_timestamp', error_message: 'Non-numeric timestamp is not likely to be accepted by the Coral API'});
            } else {
                // For Android the timestamp should be in milliseconds
                const timestamp_ms = parseInt('' + data.timestamp);
                const now_ms = Date.now();

                if (timestamp_ms > now_ms + 10000 || timestamp_ms + 10000 < now_ms) {
                    errors.push({error: 'invalid_timestamp', error_message: 'Timestamp not matching the Android device is not likely to be accepted by the Coral API'});
                }
            }
        }

        if (this.strict_validate && 'request_id' in data) {
            // For Android the request_id should be lowercase hex
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test('' + data.request_id)) {
                errors.push({error: 'invalid_request_id', error_message: 'Request ID not a valid lowercase-hex v4 UUID is not likely to be accepted by the Coral API'});
            }
        }

        if (errors.length) {
            const error = new ResponseError(400, 'invalid_request',
                errors.length + ' error' + (errors.length === 1 ? '' : 's') + ' validating request');
            error.data.errors = errors;
            throw error;
        }
    }

    async validateToken(
        req: express.Request, token: string, hash_method: '1' | '2',
        _errors: {error: string; error_message: string}[]
    ) {
        const [jwt, sig] = Jwt.decode<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>(token);

        const check_signature = jwt.payload.iss === 'https://accounts.nintendo.com';

        if (hash_method === '1' && jwt.payload.iss !== 'https://accounts.nintendo.com') {
            throw new ResponseError(400, 'invalid_request', 'Invalid token issuer');
        }
        if (hash_method === '1' && jwt.payload.aud !== ZNCA_CLIENT_ID) {
            throw new ResponseError(400, 'invalid_request', 'Invalid token audience');
        }
        if (hash_method === '2' && jwt.payload.iss !== 'api-lp1.znc.srv.nintendo.net') {
            throw new ResponseError(400, 'invalid_request', 'Invalid token issuer');
        }

        if (jwt.payload.exp <= (Date.now() / 1000)) {
            // throw new Error('Token expired');
            debug('Token from %s expired', req.ip);
        }

        const jwks = jwt.header.kid &&
            jwt.header.jku?.match(/^https\:\/\/([^/]+\.)?nintendo\.(com|net)(\/|$)/i) ?
            await getJwks(jwt.header.jku) : null;

        if (check_signature && !jwks) {
            throw new ResponseError(400, 'invalid_request', 'Requires signature verification, but trusted JWKS URL and key ID not included in token');
        }

        const jwk = jwks?.keys.find(jwk => jwk.use === 'sig' && jwk.alg === jwt.header.alg &&
            jwk.kid === jwt.header.kid && jwk.x5c?.length);
        const cert = jwk?.x5c?.[0] ? '-----BEGIN CERTIFICATE-----\n' +
            jwk.x5c[0].match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n' : null;

        if (!cert) {
            if (check_signature) throw new ResponseError(400, 'invalid_request', 'Not verifying signature, no JKW found for this token');
            else debug('Not verifying signature, no JKW found for this token');
        }

        const signature_valid = cert && jwt.verify(sig, cert);

        if (check_signature && !signature_valid) {
            throw new ResponseError(400, 'invalid_request', 'Invalid signature');
        }

        if (!check_signature) {
            if (signature_valid) debug('JWT signature is valid');
            else debug('JWT signature is not valid or not checked');
        }
    }
}
