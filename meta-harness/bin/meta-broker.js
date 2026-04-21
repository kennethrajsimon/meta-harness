#!/usr/bin/env node
const { main } = require('../src/broker/main');
main().catch(e => { console.error('[broker] fatal:', e); process.exit(1); });
