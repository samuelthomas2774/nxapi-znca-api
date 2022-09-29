import process from 'node:process';
import createDebug from 'debug';
import Yargs from 'yargs';
import getPaths from 'env-paths';
import * as commands from './commands.js';
import { YargsArguments } from '../util/yargs.js';

const debug = createDebug('cli');

const paths = getPaths('nxapi');

export function createYargs(argv: string[]) {
    const yargs = Yargs(argv).option('data-path', {
        describe: 'Data storage path',
        type: 'string',
        default: process.env.NXAPI_DATA_PATH || paths.data,
    });

    for (const command of Object.values(commands)) {
        // @ts-ignore
        yargs.command(command);
    }

    yargs
        .scriptName('nxapi-znca-api')
        .demandCommand()
        .help()
        // .version(false)
        .showHelpOnFail(false, 'Specify --help for available options');

    return yargs;
}

export type Arguments = YargsArguments<ReturnType<typeof createYargs>>;

export async function main(argv = process.argv.slice(2)) {
    const yargs = createYargs(argv);

    yargs.argv;
}
