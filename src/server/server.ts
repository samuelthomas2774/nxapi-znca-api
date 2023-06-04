import * as os from 'node:os';
import createDebug from 'debug';
import express from 'express';
import bodyParser from 'body-parser';
import persist from 'node-persist';
import { getJwks, Jwt } from '../util/jwt.js';
import { product } from '../util/product.js';
import { CoralJwtPayload, NintendoAccountIdTokenJwtPayload } from '../util/types.js';
import { HttpServer, ResponseError } from '../util/http-server.js';
import { DeviceConnection, DevicePool } from './devices.js';
import MetricsCollector from './metrics.js';
import { checkUseLimit } from './util.js';
import { FRequest, FResult, PackageInfo } from './types.js';

const ZNCA_CLIENT_ID = '71b963c1b7b6d119';

const debug = createDebug('nxapi:znca-api:server');

const WarningSymbol = Symbol('Warning');

export default class Server extends HttpServer {
    validate_tokens = true;
    strict_validate = false;
    reattach: (() => void) | null = null;
    health_ttl = 30 * 1000; // 30 seconds

    readonly app: express.Express;

    storage: persist.LocalStorage | null = null;
    limits_coral: [requests: number, period_ms: number] | null = null;
    limits_webservice: [requests: number, period_ms: number] | null = null;

    last_result: {
        req: express.Request;
        data?: FRequest;
        result: FResult;
        device?: DeviceConnection;
        time: Date;
        dv?: number;
        dw?: number;
        da?: number;
    } | null = null;

    constructor(
        readonly devices: DevicePool,
        readonly metrics: MetricsCollector | null = null,
    ) {
        super();

        const app = this.app = express();

        app.use('/api/znca', (req, res, next) => {
            console.log('[%s] %s %s HTTP/%s from %s, port %d%s, %s',
                new Date(), req.method, req.path, req.httpVersion,
                req.socket.remoteAddress, req.socket.remotePort,
                req.headers['x-forwarded-for'] ? ' (' + req.headers['x-forwarded-for'] + ')' : '',
                req.headers['user-agent']);

            res.setHeader('Server', product);
            res.setHeader('X-Server', product);
            res.setHeader('X-Served-By', os.hostname());

            next();
        });

        app.post('/api/znca/f', bodyParser.json(), this.createApiRequestHandler((req, res) =>
            this.handleFRequest(req, res)));
        app.get('/api/znca/health', this.createApiRequestHandler((req, res) =>
            this.handleHealthRequest(req, res)));
        app.get('/api/znca/devices', this.createApiRequestHandler((req, res) =>
            this.handleDevicesRequest(req, res)));
        app.get('/api/znca/config', this.createApiRequestHandler((req, res) =>
            this.handleConfigRequest(req, res)));

        if (this.metrics) {
            app.get('/metrics', this.createApiRequestHandler(() => this.metrics!.handleMetricsRequest()));
        }
    }

    setDeviceHeaders(res: express.Response, device: DeviceConnection) {
        res.setHeader('X-Device-Id', device.device.id);
        device.setResponseHeaders(res);
        res.setHeader('X-znca-Platform', device.platform);
        res.setHeader('X-znca-Version', device.znca_version);
        res.setHeader('X-znca-Build', device.znca_build);
    }

    async handleDevicesRequest(req: express.Request, res: express.Response) {
        return {
            devices: this.devices.devices.map(device => ({
                id: device.device.id,
                name: device.device.name,
                data: device.data,
                ...device.debug_info,
                busy: !this.devices!.available.includes(device),
            })),
            worker_count: this.devices.devices.length,
            available_count: this.devices.available.length,
            queue: this.devices.waiting.length,
        };
    }

    async handleConfigRequest(req: express.Request, res: express.Response) {
        const devices = [...this.devices.devices].sort((a, b) => b.znca_build - a.znca_build);
        const latest = devices[0];
        devices.reverse();

        if (!latest) {
            throw new ResponseError(500, 'unknown_error', 'No workers available');
        }

        const versions: (PackageInfo & {
            platform: string;
            build: number;
            worker_count: number;
        })[] = [];

        for (const device of devices) {
            const version = versions.find(v => v.platform === device.platform &&
                v.build === device.znca_build);

            if (version) {
                version.worker_count++;
                continue;
            }

            versions.push({
                platform: device.platform,
                ...(device as any).package_info,
                build: device.znca_build,
                worker_count: 1,
            });
        }

        return {
            versions,
            // imink API compatibility
            nso_version: latest.znca_version,
        };
    }

    async handleFRequest(req: express.Request, res: express.Response) {
        const start = Date.now();

        // if (req.headers['x-znca-platform'] && req.headers['x-znca-platform'] !== 'Android') {
        //     throw new ResponseError(400, 'unsupported_platform', 'Unsupported X-znca-Platform');
        // }
        const requested_platform = req.headers['x-znca-platform']?.toString() ?? null;
        if (requested_platform && requested_platform !== 'Android') {
            throw new ResponseError(400, 'unsupported_platform', 'Unsupported X-znca-Platform');
        }
        const requested_version = req.headers['x-znca-version']?.toString() ?? null;
        if (requested_version && !requested_version.match(/^\d+\.\d+\.\d+$/)) {
            throw new ResponseError(400, 'invalid_request', 'Invalid X-znca-Version value');
        }

        const warnings: {error: string; error_message: string}[] = [];

        if (!requested_version) warnings.push({error: 'request_parameter_not_set', error_message: 'The `X-znca-Platform` and `X-znca-Version` headers were not set'});

        if (req.body && 'type' in req.body) req.body = {
            hash_method:
                req.body.type === 'nso' ? '1' :
                req.body.type === 'app' ? '2' : null!,
            token: req.body.token,
            timestamp: '' + req.body.timestamp,
            request_id: req.body.uuid,
        };

        const data: FRequest = req.body;

        if (data && typeof data.hash_method === 'number') {
            data.hash_method = '' + data.hash_method as '1' | '2';
        }

        try {
            await this.validateFRequest(req, data, this.strict_validate, warnings);
        } catch (err) {
            debug('Error validating request from %s', req.ip, err);
            res.setHeader('Server-Timing', 'validate;dur=' + (Date.now() - start));
            const status = err instanceof ResponseError ? err.status : 500;
            this.metrics?.total_f_requests.inc({status, type: data.hash_method});
            this.metrics?.incFRequestDuration(Date.now() - start, status, data.hash_method, 'validate');
            throw err;
        }

        const validated = Date.now();

        return this.callWithFridaScript(req, res, async (device, queue, attach) => {
            debug('Calling %s', data.hash_method === '2' ? 'genAudioH2' : 'genAudioH',
                device.device.id, device.znca_version, requested_version);

            const timestamp = 'timestamp' in data ? '' + data.timestamp : undefined;
            const request_id = 'request_id' in data ? data.request_id! : device.generateRequestId();

            let na_id = data.na_id ?? '';
            let coral_user_id = data.coral_user_id ?? '';

            try {
                if (data.hash_method === '1' && !na_id) {
                    debug('na_id not set, reading from token');
                    const [jwt, sig] = Jwt.decode(data.token);
                    na_id = '' + jwt.payload.sub;
                }
                if (data.hash_method === '2' && !na_id) {
                    debug('na_id not set, using empty string');
                }
                if (data.hash_method === '2' && !coral_user_id) {
                    debug('coral_user_id not set, reading from token');
                    const [jwt, sig] = Jwt.decode(data.token);
                    coral_user_id = '' + jwt.payload.sub;
                }
            } catch (err) {}

            const result = data.hash_method === '2' ?
                await device.genAudioH2(data.token, timestamp, request_id,
                    {na_id, coral_user_id, coral_token: data.token}) :
                await device.genAudioH(data.token, timestamp, request_id,
                    {na_id, na_id_token: data.token});

            this.last_result = {
                req, data, result, time: new Date(),
                device,
                dv: validated - start,
                dw: queue,
                da: attach,
            };

            debug('Returned %s', result);

            const response = {
                f: result.f,
                timestamp: data.timestamp ? undefined : result.timestamp,
                request_id: data.request_id ? undefined : request_id,

                warnings: warnings.length ? warnings : undefined,
            };

            res.setHeader('Server-Timing',
                'validate;dur=' + (validated - start) + ',' +
                (typeof attach === 'number' ? 'attach;dur=' + attach + ',' : '') +
                'queue;dur=' + (result.dw + (queue ?? 0)) + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);

            this.metrics?.total_f_requests.inc({status: 200, type: data.hash_method});
            this.metrics?.incFRequestDuration(validated - start, 200, data.hash_method, 'validate');
            this.metrics?.incFRequestDuration(attach ?? 0, 200, data.hash_method, 'attach');
            this.metrics?.incFRequestDuration(result.dw + (queue ?? 0), 200, data.hash_method, 'queue');
            this.metrics?.incFRequestDuration(result.di, 200, data.hash_method, 'init');
            this.metrics?.incFRequestDuration(result.dp, 200, data.hash_method, 'process');

            return response;
        }, null, requested_version).catch(err => {
            const status = err instanceof ResponseError ? err.status : 500;
            this.metrics?.total_f_requests.inc({status, type: data.hash_method});
            this.metrics?.incFRequestDuration(validated - start, status, data.hash_method, 'validate');
            this.metrics?.incFRequestDuration(Date.now() - validated, status, data.hash_method, 'queue');
            throw err;
        });
    }

    async handleHealthRequest(req: express.Request, res: express.Response) {
        if (this.last_result && this.last_result.time.getTime() > (Date.now() - this.health_ttl)) {
            if (this.last_result.device) this.setDeviceHeaders(res, this.last_result.device);

            res.setHeader('Server-Timing',
                'queue;dur=' + (this.last_result.result.dw + (this.last_result.dw ?? 0)) + ',' +
                'init;dur=' + this.last_result.result.di + ',' +
                'process;dur=' + this.last_result.result.dp);

            return {
                last_result_at: new Date(this.last_result.time).toUTCString(),
                worker_count: this.devices.devices.length,
                available_count: this.devices.available.length,
                queue: this.devices.waiting.length,
            };
        }

        return this.callWithFridaScript(req, res, async (device, queue, attach) => {
            debug('Test gen_audio_h', device.device.id, device.znca_version);

            const result = await device.genAudioH('id_token', 'timestamp', 'request_id');

            this.last_result = {
                req, result, time: new Date(),
                device,
                dw: queue,
                da: attach,
            };

            debug('Test returned %s', result);

            res.setHeader('Server-Timing',
                (typeof attach === 'number' ? 'attach;dur=' + attach + ',' : '') +
                'queue;dur=' + (result.dw + (queue ?? 0)) + ',' +
                'init;dur=' + result.di + ',' +
                'process;dur=' + result.dp);

            return {
                last_result_at: this.last_result.time.toUTCString(),
                worker_count: this.devices.devices.length,
                available_count: this.devices.available.length,
                queue: this.devices.waiting.length,
            };
        }, null, null, !this.devices.devices.length ?? false);
    }

    callWithFridaScript<T>(
        req: express.Request, res: express.Response,
        fn: (api: DeviceConnection, queue?: number, attach?: number, device?: DeviceConnection) => Promise<T>,
        platform: string | null = null, version: string | null = null, wait = true,
    ) {
        const controller = new AbortController();

        req.on('close', () => controller.abort(new Error('Request aborted')));

        return this.devices.callWithDevice(async (device, queue) => {
            this.setDeviceHeaders(res, device);

            return fn.call(null, device, queue ?? undefined, undefined);
        }, device => {
            if (platform && device.platform !== platform) return false;
            if (version && device.znca_version !== version) return false;
            return true;
        }, wait ? undefined : 0, 1, controller.signal);
    }

    async validateFRequest(
        req: express.Request, data: FRequest, strict = false,
        warnings?: {error: string; error_message: string}[],
    ) {
        const errors: {error: string; error_message: string; [WarningSymbol]?: boolean}[] = [];

        if (!data || typeof data !== 'object') {
            throw new ResponseError(415, 'invalid_request');
        }

        if ('hash_method' in data) {
            if (data.hash_method !== '1' && data.hash_method !== '2') {
                errors.push({error: 'invalid_hash_method', error_message: '`hash_method` must be "1" or "2"'});
            }
        } else {
            errors.push({error: 'request_parameter_not_set', error_message: 'The `hash_method` parameter is required'});
        }

        let jwt: Jwt<NintendoAccountIdTokenJwtPayload | CoralJwtPayload> | null = null;

        if ('token' in data) {
            if (typeof data.token !== 'string') {
                errors.push({error: 'invalid_token', error_message: '`token` must be a string'});
            } else {
                try {
                    let sig: Buffer;
                    [jwt, sig] = Jwt.decode<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>(data.token);

                    await this.validateToken(req, jwt, sig, data.hash_method, errors, warnings);
                } catch (err) {
                    debug('Error validating token from %s', req.ip, err);
                    errors.push({error: 'invalid_token', error_message: (err as Error).message, [WarningSymbol]: !this.validate_tokens});
                }
            }
        } else {
            errors.push({error: 'request_parameter_not_set', error_message: 'The `token` parameter is required'});
        }

        if ('timestamp' in data) {
            if (typeof data.timestamp !== 'string' && typeof data.timestamp !== 'number') {
                errors.push({error: 'invalid_timestamp', error_message: '`timestamp` must be a string or number'});
            } else if (!/^\d+$/.test('' + data.timestamp)) {
                errors.push({error: 'invalid_timestamp', error_message: 'Non-numeric timestamp is not likely to be accepted by the Coral API', [WarningSymbol]: !strict});
            } else {
                // For Android the timestamp should be in milliseconds
                const timestamp_ms = parseInt('' + data.timestamp);
                const now_ms = Date.now();

                if (timestamp_ms > now_ms + 10000 || timestamp_ms + 10000 < now_ms) {
                    errors.push({error: 'invalid_timestamp', error_message: 'Timestamp not matching the Android device is not likely to be accepted by the Coral API', [WarningSymbol]: !strict});
                } else {
                    errors.push({error: 'invalid_timestamp', error_message: 'Timestamp sent by the client may not exactly match the Android device and is not likely to be accepted by the Coral API', [WarningSymbol]: true});
                }
            }
        }

        if ('request_id' in data) {
            if (typeof data.request_id !== 'string') {
                errors.push({error: 'invalid_request_id', error_message: '`request_id` must be a string'});
            } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test('' + data.request_id)) {
                // For Android the request_id should be lowercase hex
                errors.push({error: 'invalid_request_id', error_message: 'Request ID not a valid lowercase-hex v4 UUID is not likely to be accepted by the Coral API', [WarningSymbol]: !strict});
            }
        }

        if ('na_id' in data) {
            if (typeof data.na_id !== 'string') {
                errors.push({error: 'invalid_na_id', error_message: '`na_id` must be a string'});
            } else if (data.hash_method === '1' && data.na_id !== jwt?.payload.sub.toString()) {
                errors.push({error: 'invalid_na_id', error_message: 'Nintendo Account ID not matching the token subject is not likely to be accepted by the Coral API', [WarningSymbol]: !strict});
            }
        } else {
            if (data.hash_method === '1') {
                errors.push({error: 'request_parameter_not_set', error_message: 'The `na_id` parameter was not set', [WarningSymbol]: true});
            }
            if (data.hash_method === '2') {
                errors.push({error: 'request_parameter_not_set', error_message: 'The `na_id` parameter was not set, this may cause invalid tokens', [WarningSymbol]: !strict});
            }
        }

        // coral_user_id is not required for hash method 1
        if ('coral_user_id' in data) {
            if (typeof data.coral_user_id !== 'string') {
                errors.push({error: 'invalid_coral_user_id', error_message: '`coral_user_id` must be a string'});
            } else if (!data.coral_user_id.match(/^\d+$/)) {
                errors.push({error: 'invalid_coral_user_id', error_message: '`coral_user_id` must be a numeric string'});
            } else if (data.hash_method === '2' && data.coral_user_id !== jwt?.payload.sub.toString()) {
                errors.push({error: 'invalid_coral_user_id', error_message: 'Coral user ID not matching the token subject is not likely to be accepted by the Coral API', [WarningSymbol]: !strict});
            }
        } else {
            if (data.hash_method === '2') {
                errors.push({error: 'request_parameter_not_set', error_message: 'The `coral_user_id` parameter was not set', [WarningSymbol]: true});
            }
        }

        let index;
        while ((index = errors.findIndex(e => e[WarningSymbol])) >= 0) {
            warnings?.push(errors[index]);
            errors.splice(index, 1);
        }

        if (errors.length) {
            const error = new ResponseError(400, 'invalid_request',
                errors.length + ' error' + (errors.length === 1 ? '' : 's') + ' validating request');
            error.data.errors = errors;
            error.data.warnings = warnings;
            throw error;
        }

        if (this.storage) {
            const limits = data.hash_method === '1' ? this.limits_coral : this.limits_webservice;

            await checkUseLimit(this.storage, 'f_' + data.hash_method, jwt?.payload.sub.toString() ?? 'null', req,
                !!limits, limits ?? undefined);
        }
    }

    async validateToken(
        req: express.Request, jwt: Jwt<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>, sig: Buffer,
        hash_method: '1' | '2', _errors: {error: string; error_message: string}[],
        warnings?: {error: string; error_message: string}[],
    ) {
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
            warnings?.push({error: 'invalid_token', error_message: 'Token expired'});
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
