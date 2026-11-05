'use strict';

// Optional command-line entry point used by local integrations.
// Accepted aliases: toggle, reset, plus60, minus60, start.
require('./launch.cjs').main(process.argv[2] || 'start');
