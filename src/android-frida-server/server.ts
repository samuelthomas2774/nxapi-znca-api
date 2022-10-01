import createDebug from 'debug';
import { v4 as uuidgen } from 'uuid';
import express from 'express';
import bodyParser from 'body-parser';
import { getJwks, Jwt } from '../util/jwt.js';
import { product } from '../util/product.js';
import { CoralJwtPayload, FRequest, FResult, FridaScriptExports, NintendoAccountIdTokenJwtPayload, PackageInfo, StartMethod, SystemInfo } from './types.js';

const ZNCA_CLIENT_ID = '71b963c1b7b6d119';

const debug = createDebug('nxapi:znca-api:android-frida-server:api');

export default class Server {
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
        const app = this.app = express();

        app.use('/api/znca', (req, res, next) => {
            console.log('[%s] %s %s HTTP/%s from %s, port %d%s, %s',
                new Date(), req.method, req.path, req.httpVersion,
                req.socket.remoteAddress, req.socket.remotePort,
                req.headers['x-forwarded-for'] ? ' (' + req.headers['x-forwarded-for'] + ')' : '',
                req.headers['user-agent']);

            res.setHeader('Server', product + ' android-frida-server');

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

        app.post('/api/znca/f', bodyParser.json(), (req, res) => this.handleFRequest(req, res));
        app.get('/api/znca/health', (req, res) => this.handleHealthRequest(req, res));
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
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({error: 'invalid_request'}));
            return;
        }

        const timestamp = 'timestamp' in data ? '' + data.timestamp : undefined;
        const request_id = 'request_id' in data ? data.request_id! : uuidgen();

        try {
            await this.validateToken(req, data.token, data.hash_method);

            if (this.strict_validate && 'timestamp' in data) {
                if (!timestamp!.match(/^\d+$/)) {
                    throw new Error('Non-numeric timestamp is not likely to be accepted by the Coral API');
                }

                // For Android the timestamp should be in milliseconds
                const timestamp_ms = parseInt(timestamp!);
                const now_ms = Date.now();

                if (timestamp_ms > now_ms + 10000 || timestamp_ms + 10000 < now_ms) {
                    throw new Error('Timestamp not matching the Android device is not likely to be accepted by the Coral API');
                }
            }

            if (this.strict_validate && 'request_id' in data) {
                // For Android the request_id should be lowercase hex
                if (!request_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
                    throw new Error('Request ID not a valid lowercase-hex v4 UUID is not likely to be accepted by the Coral API');
                }
            }
        } catch (err) {
            debug('Error validating request from %s', req.ip, err);
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Server-Timing', 'validate;dur=' + (Date.now() - start));
            res.end(JSON.stringify({error: 'invalid_request', error_message: (err as Error)?.message}));
            return;
        }

        const validated = Date.now();

        this.handleRetryAfterReattach(req, res, async () => {
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

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Server-Timing',
                'validate;dur=' + (validated - start) + ',' +
                (!was_connected ? 'attach;dur=' + (connected - validated) + ',' : '') +
                'queue;dur=' + result.dw + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);
            res.end(JSON.stringify(response));
        });
    }

    async handleHealthRequest(req: express.Request, res: express.Response) {
        if (this.last_result && this.last_result.time.getTime() > (Date.now() - this.health_ttl)) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Server-Timing',
                'queue;dur=' + this.last_result.result.dw + ',' +
                'init;dur=' + this.last_result.result.di + ',' +
                'process;dur=' + this.last_result.result.dp);
            res.end(JSON.stringify({last_result_at: new Date(this.last_result.time).toUTCString()}));
            return;
        }

        const start = Date.now();

        this.handleRetryAfterReattach(req, res, async () => {
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

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Server-Timing',
                (!was_connected ? 'attach;dur=' + (connected - start) + ',' : '') +
                'queue;dur=' + result.dw + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);
            res.end(JSON.stringify({last_result_at: this.last_result.time.toUTCString()}));
        });
    }

    async handleRetryAfterReattach(req: express.Request, res: express.Response, handle: () => Promise<void>) {
        try {
            await handle();
        } catch (err) {
            if ((err as any)?.message === 'Script is destroyed') {
                debug('Error in request from %s, retrying', req.ip, err);

                this.reattach?.();

                try {
                    await handle();
                } catch (err) {
                    debug('Error in request from %s', req.ip, err);

                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({error: 'unknown'}));

                    if ((err as any)?.message === 'Script is destroyed') {
                        this.reattach?.();
                    }
                }
            } else {
                debug('Error in request from %s', req.ip, err);

                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({error: 'unknown'}));
            }
        }
    }

    async validateToken(req: express.Request, token: string, hash_method: '1' | '2') {
        try {
            const [jwt, sig] = Jwt.decode<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>(token);

            const check_signature = jwt.payload.iss === 'https://accounts.nintendo.com';

            if (hash_method === '1' && jwt.payload.iss !== 'https://accounts.nintendo.com') {
                throw new Error('Invalid token issuer');
            }
            if (hash_method === '1' && jwt.payload.aud !== ZNCA_CLIENT_ID) {
                throw new Error('Invalid token audience');
            }
            if (hash_method === '2' && jwt.payload.iss !== 'api-lp1.znc.srv.nintendo.net') {
                throw new Error('Invalid token issuer');
            }

            if (jwt.payload.exp <= (Date.now() / 1000)) {
                throw new Error('Token expired');
            }

            const jwks = jwt.header.kid &&
                jwt.header.jku?.match(/^https\:\/\/([^/]+\.)?nintendo\.(com|net)(\/|$)/i) ?
                await getJwks(jwt.header.jku) : null;

            if (check_signature && !jwks) {
                throw new Error('Requires signature verification, but trusted JWKS URL and key ID not included in token');
            }

            const jwk = jwks?.keys.find(jwk => jwk.use === 'sig' && jwk.alg === jwt.header.alg &&
                jwk.kid === jwt.header.kid && jwk.x5c?.length);
            const cert = jwk?.x5c?.[0] ? '-----BEGIN CERTIFICATE-----\n' +
                jwk.x5c[0].match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n' : null;

            if (!cert) {
                if (check_signature) throw new Error('Not verifying signature, no JKW found for this token');
                else debug('Not verifying signature, no JKW found for this token');
            }

            const signature_valid = cert && jwt.verify(sig, cert);

            if (check_signature && !signature_valid) {
                throw new Error('Invalid signature');
            }

            if (!check_signature) {
                if (signature_valid) debug('JWT signature is valid');
                else debug('JWT signature is not valid or not checked');
            }
        } catch (err) {
            if (this.validate_tokens) throw err;
            debug('Error validating token from %s, continuing anyway', req.ip, err);
        }
    }
}
