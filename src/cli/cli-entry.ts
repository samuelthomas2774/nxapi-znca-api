import createDebug from 'debug';

createDebug.log = console.warn.bind(console);

import('./index.js').then(cli => cli.main.call(null));
