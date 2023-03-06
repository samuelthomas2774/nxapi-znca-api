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

        for (const status of [200, 400, 406, 249, 500, 503]) {
            this.total_f_requests.inc({status, type: '1'}, 0);
            this.total_f_requests.inc({status, type: '2'}, 0);
        }
        for (const state of ['validate', 'attach', 'queue', 'init', 'process']) {
            this.total_f_request_duration.inc({status: 200, type: '1', state}, 0);
            this.total_f_request_duration.inc({status: 200, type: '2', state}, 0);
        }
        for (const status of [400, 429]) {
            this.total_f_request_duration.inc({status, type: '1', state: 'validate'}, 0);
            this.total_f_request_duration.inc({status, type: '2', state: 'validate'}, 0);
        }
        for (const status of [406, 500, 503]) {
            for (const state of ['validate', 'queue']) {
                this.total_f_request_duration.inc({status, type: '1', state}, 0);
                this.total_f_request_duration.inc({status, type: '2', state}, 0);
            }
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
        labelNames: ['status', 'type'],
    });

    readonly total_f_request_duration = new Counter({
        name: 'nxapi_znca_api_f_request_duration_seconds_total',
        help: 'Time processing f requests',
        registers: [this.register],
        // state == validate, attach, queue, init, process
        labelNames: ['status', 'type', 'state'],
    });

    incFRequestDuration(
        dur: number, status: number, type: '1' | '2', state: 'validate' | 'attach' | 'queue' | 'init' | 'process',
    ) {
        this.total_f_request_duration.inc({status, type, state}, dur / 1000);
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
