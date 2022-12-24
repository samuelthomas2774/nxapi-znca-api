import createDebug from 'debug';
import { NextFunction, Request, RequestHandler, Response } from 'express';

const debug = createDebug('nxapi:util:http-server');

export class HttpServer {
    protected createApiRequestHandler(callback: (req: Request, res: Response) => Promise<{} | void>, auth = false) {
        return async (req: Request, res: Response) => {
            try {
                const result = await callback.call(null, req, res);

                if (result) this.sendJsonResponse(res, result);
                else res.end();
            } catch (err) {
                this.handleRequestError(req, res, err);
            }
        };
    }

    protected createApiMiddleware(
        callback: (req: Request, res: Response) => Promise<void>
    ): RequestHandler {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                await callback.call(null, req, res);

                next();
            } catch (err) {
                this.handleRequestError(req, res, err);
            }
        };
    }

    protected sendJsonResponse(res: Response, data: {}, status?: number) {
        if (status) res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(this.encodeJsonForResponse(data, res.req.headers['accept']?.match(/\/html\b/i) ? 4 : 0));
    }

    protected encodeJsonForResponse(data: unknown, space?: number) {
        return JSON.stringify(data, null, space);
    }

    protected handleRequestError(req: Request, res: Response, err: unknown) {
        debug('Error in request %s %s', req.method, req.url, err);

        if (err && typeof err === 'object' && 'type' in err && 'code' in err && (err as any).type === 'system') {
            const code: string = (err as any).code;

            if (code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                res.setHeader('Retry-After', '60');
            }
        }

        if (err instanceof ResponseError) {
            err.sendResponse(req, res);
        } else {
            this.sendJsonResponse(res, {
                error: err,
                error_message: (err as Error).message,
            }, 500);
        }
    }
}

export class ResponseError extends Error {
    data: any = {};

    constructor(readonly status: number, readonly code: string, message?: string) {
        super(message);
    }

    sendResponse(req: Request, res: Response) {
        const data = {
            error: this.code,
            error_message: this.message,
            ...this.data,
        };

        res.statusCode = this.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(req.headers['accept']?.match(/\/html\b/i) ?
            JSON.stringify(data, null, 4) : JSON.stringify(data));
    }
}
