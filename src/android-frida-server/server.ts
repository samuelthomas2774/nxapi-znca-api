import * as os from 'node:os';
import createDebug from 'debug';
import { v4 as uuidgen } from 'uuid';
import express from 'express';
import bodyParser from 'body-parser';
import persist from 'node-persist';
import { getJwks, Jwt } from '../util/jwt.js';
import { product } from '../util/product.js';
import { FRequest, FResult, FridaScriptExports, PackageInfo, SystemInfo } from './types.js';
import { CoralJwtPayload, NintendoAccountIdTokenJwtPayload } from '../util/types.js';
import { HttpServer, ResponseError } from '../util/http-server.js';
import { AndroidDeviceConnection, AndroidDevicePool } from './device.js';
import MetricsCollector from './metrics.js';
import { checkUseLimit } from './util.js';

const ZNCA_CLIENT_ID = '71b963c1b7b6d119';

const debug = createDebug('nxapi:znca-api:android-frida-server:api');

export default class Server extends HttpServer {
    validate_tokens = true;
    strict_validate = false;
    reattach: (() => void) | null = null;
    health_ttl = 30 * 1000; // 30 seconds

    readonly app: express.Express;

    ready: Promise<void> | null = null;
    api: FridaScriptExports | null = null;
    package_info: PackageInfo | null = null;
    system_info: SystemInfo | null = null;

    storage: persist.LocalStorage | null = null;
    limits_coral: [requests: number, period_ms: number] | null = null;
    limits_webservice: [requests: number, period_ms: number] | null = null;

    last_result: {
        req: express.Request;
        data?: FRequest;
        result: FResult;
        device?: AndroidDeviceConnection;
        time: Date;
        dv?: number;
        dw?: number;
        da?: number;
    } | null = null;

    constructor(
        readonly devices: AndroidDevicePool | null = null,
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
        app.get('/api/znca/devices', this.createApiRequestHandler((req, res) =>
            this.handleDevicesRequest(req, res)));
        app.get('/api/znca/config', this.createApiRequestHandler((req, res) =>
            this.handleConfigRequest(req, res)));

        if (this.metrics) {
            app.get('/metrics', this.createApiRequestHandler(() => this.metrics!.handleMetricsRequest()));
        }
    }

    setAndroidDeviceHeaders(res: express.Response, device: AndroidDeviceConnection) {
        res.setHeader('X-Device-Id', device.device.id);
        res.setHeader('X-Android-Build-Type', device.system_info.type);
        res.setHeader('X-Android-Release', device.system_info.version.release);
        res.setHeader('X-Android-Platform-Version', device.system_info.version.sdk_int);
        res.setHeader('X-znca-Platform', 'Android');
        res.setHeader('X-znca-Version', device.package_info.version);
        res.setHeader('X-znca-Build', device.package_info.build);
    }

    async handleDevicesRequest(req: express.Request, res: express.Response) {
        return {
            devices: this.devices!.devices.map(device => ({
                id: device.device.id,
                name: device.device.name,
                data: device.data,
                android_build_type: device.system_info.type,
                android_release: device.system_info.version.release,
                android_platform_version: device.system_info.version.sdk_int,
                platform: 'Android',
                znca_version: device.package_info.version,
                znca_build: device.package_info.build,
                busy: !this.devices!.available.includes(device),
            })),
            worker_count: this.devices!.devices.length,
            available_count: this.devices!.available.length,
            queue: this.devices!.waiting.length,
        };
    }

    async handleConfigRequest(req: express.Request, res: express.Response) {
        const android_package_info =
            this.devices ? this.devices.devices.map(d => d.package_info).sort((a, b) => b.build - a.build) :
            this.package_info ? [this.package_info] : null;
        const latest = android_package_info?.[0];
        android_package_info?.reverse();

        if (!latest) {
            throw new ResponseError(500, 'unknown_error', 'No workers available');
        }

        const versions: (PackageInfo & {
            platform: string;
            worker_count: number;
        })[] = [];

        for (const package_info of android_package_info) {
            const version = versions.find(v => v.platform === 'Android' &&
                v.name === package_info.name && v.build === package_info.build);

            if (version) {
                version.worker_count++;
                continue;
            }

            versions.push({
                platform: 'Android',
                ...package_info,
                worker_count: 1,
            });
        }

        return {
            versions,
            // imink API compatibility
            nso_version: latest.version,
        };
    }

    async handleFRequest(req: express.Request, res: express.Response) {
        const start = Date.now();

        if (req.headers['x-znca-platform'] && req.headers['x-znca-platform'] !== 'Android') {
            throw new ResponseError(400, 'unsupported_platform', 'Unsupported X-znca-Platform');
        }
        const requested_version = req.headers['x-znca-version']?.toString() ?? null;
        if (requested_version && !requested_version.match(/^\d+\.\d+\.\d+$/)) {
            throw new ResponseError(400, 'invalid_request', 'Invalid X-znca-Version value');
        }

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
            const status = err instanceof ResponseError ? err.status : 500;
            this.metrics?.total_f_requests.inc({status, type: data.hash_method});
            this.metrics?.incFRequestDuration(Date.now() - start, status, data.hash_method, 'validate');
            throw err;
        }

        const validated = Date.now();

        const timestamp = 'timestamp' in data ? '' + data.timestamp : undefined;
        const request_id = 'request_id' in data ? data.request_id! : uuidgen();

        return this.callWithFridaScript(req, res, async (api, queue, attach, device) => {
            debug('Calling %s', data.hash_method === '2' ? 'genAudioH2' : 'genAudioH',
                device?.device.id, (device?.package_info ?? this.package_info)?.version, requested_version);

            const result = data.hash_method === '2' ?
                await api.genAudioH2(data.token, timestamp, request_id) :
                await api.genAudioH(data.token, timestamp, request_id);

            this.last_result = {
                req, data, result, time: new Date(),
                device: this.devices?.devices.find(d => d.api === api),
                dv: validated - start,
                dw: queue,
                da: attach,
            };

            debug('Returned %s', result);

            const response = {
                f: result.f,
                timestamp: data.timestamp ? undefined : result.timestamp,
                request_id: data.request_id ? undefined : request_id,
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
        }, requested_version).catch(err => {
            const status = err instanceof ResponseError ? err.status : 500;
            this.metrics?.total_f_requests.inc({status, type: data.hash_method});
            this.metrics?.incFRequestDuration(validated - start, status, data.hash_method, 'validate');
            this.metrics?.incFRequestDuration(Date.now() - validated, status, data.hash_method, 'queue');
            throw err;
        });
    }

    async handleHealthRequest(req: express.Request, res: express.Response) {
        if (this.last_result && this.last_result.time.getTime() > (Date.now() - this.health_ttl)) {
            if (this.last_result.device) this.setAndroidDeviceHeaders(res, this.last_result.device);

            res.setHeader('Server-Timing',
                'queue;dur=' + (this.last_result.result.dw + (this.last_result.dw ?? 0)) + ',' +
                'init;dur=' + this.last_result.result.di + ',' +
                'process;dur=' + this.last_result.result.dp);

            return {
                last_result_at: new Date(this.last_result.time).toUTCString(),
                worker_count: this.devices!.devices.length,
                available_count: this.devices!.available.length,
                queue: this.devices!.waiting.length,
            };
        }

        return this.callWithFridaScript(req, res, async (api, queue, attach, device) => {
            debug('Test gen_audio_h', device?.device.id, (device?.package_info ?? this.package_info)?.version);

            const result = await api.genAudioH('id_token', 'timestamp', 'request_id');

            this.last_result = {
                req, result, time: new Date(),
                device: this.devices?.devices.find(d => d.api === api),
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
                worker_count: this.devices!.devices.length,
                available_count: this.devices!.available.length,
                queue: this.devices!.waiting.length,
            };
        }, null, !this.devices?.devices.length ?? false);
    }

    callWithFridaScript<T>(
        req: express.Request, res: express.Response,
        fn: (api: FridaScriptExports, queue?: number, attach?: number, device?: AndroidDeviceConnection) => Promise<T>,
        version: string | null = null, wait = true,
    ) {
        if (this.devices) {
            const controller = new AbortController();

            req.on('close', () => controller.abort(new Error('Request aborted')));

            return this.devices.callWithDevice(async (device, queue) => {
                this.setAndroidDeviceHeaders(res, device);

                return fn.call(null, device.api, queue ?? undefined, undefined, device);
            }, device => !version || device.package_info.version === version,
                wait ? undefined : 0, 1, controller.signal);
        }

        const start = Date.now();

        return this.handleRetryAfterReattach(req, res, async () => {
            const was_connected = !this.ready;
            await this.ready;
            const connected = Date.now();

            return fn.call(null, this.api!, undefined, !was_connected ? connected - start : undefined);
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
        let jwt: Jwt<NintendoAccountIdTokenJwtPayload | CoralJwtPayload> | null = null;

        try {
            let sig: Buffer;
            [jwt, sig] = Jwt.decode<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>(data.token);

            await this.validateToken(req, jwt, sig, hash_method, errors);
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

        if (this.storage) {
            const limits = hash_method === '1' ? this.limits_coral : this.limits_webservice;

            await checkUseLimit(this.storage, 'f_' + hash_method, jwt?.payload.sub.toString() ?? 'null', req,
                !!limits, limits ?? undefined);
        }
    }

    async validateToken(
        req: express.Request, jwt: Jwt<NintendoAccountIdTokenJwtPayload | CoralJwtPayload>, sig: Buffer,
        hash_method: '1' | '2', _errors: {error: string; error_message: string}[],
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
