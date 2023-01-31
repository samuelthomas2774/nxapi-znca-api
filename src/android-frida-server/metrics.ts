import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { TextResponse } from '../util/http-server.js';
import { git, version } from '../util/product.js';

export default class MetricsCollector {
    readonly register = new Registry();

    constructor() {
        collectDefaultMetrics({
            register: this.register,
        });

        this.version.set({version, revision: git?.revision}, 1);

        for (const status of [200, 400, 500]) {
            this.total_f_requests.inc({status}, 0);
        }
        for (const state of ['validate', 'attach', 'queue', 'init', 'process']) {
            this.total_f_request_duration.inc({status: 200, state}, 0);
        }
        this.total_f_request_duration.inc({status: 400, state: 'validate'}, 0);
        for (const state of ['validate', 'queue']) {
            this.total_f_request_duration.inc({status: 500, state}, 0);
        }
    }

    readonly version = new Gauge({
        name: 'nxapi_znca_api_version_info',
        help: 'nxapi-znca-api version',
        registers: [this.register],
        labelNames: ['version', 'revision'],
    });

    readonly total_f_requests = new Counter({
        name: 'nxapi_znca_api_f_requests_total',
        help: 'Total number of f requests',
        registers: [this.register],
        labelNames: ['status'],
    });

    readonly total_f_request_duration = new Counter({
        name: 'nxapi_znca_api_f_request_duration_seconds_total',
        help: 'Time processing f requests',
        registers: [this.register],
        // state == validate, attach, queue, init, process
        labelNames: ['status', 'state'],
    });

    incFRequestDuration(dur: number, status: number, state: 'validate' | 'attach' | 'queue' | 'init' | 'process') {
        this.total_f_request_duration.inc({status, state}, dur / 1000);
    }

    readonly total_devices = new Gauge({
        name: 'nxapi_znca_api_devices_total',
        help: 'Total number of connected worker devices',
        registers: [this.register],
        labelNames: ['platform', 'znca_version', 'znca_build', 'android_release', 'android_platform_version'],
    });

    async handleMetricsRequest() {
        return new TextResponse(await this.register.metrics(), this.register.contentType);
    }
}
