#!/usr/bin/env node

// Workhorse setup script
//
// Usage:
//   node scripts/setup-workhorse.js <controller-address> [workhorse-name]
//
// Example:
//   node scripts/setup-workhorse.js localhost:7700 "Main-PC"
//   node scripts/setup-workhorse.js 192.168.1.100:7700 "Work-Laptop"

import { hostname, platform } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import config from '../src/common/config.js';

const controllerAddr = process.argv[2];
const workhorseName = process.argv[3] || hostname();

if (!controllerAddr) {
  console.error('Usage: node scripts/setup-workhorse.js <controller-address> [workhorse-name]');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/setup-workhorse.js localhost:7700');
  console.error('  node scripts/setup-workhorse.js 192.168.1.100:7700 "My-PC"');
  process.exit(1);
}

const workhorseId = `wh-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
const serverUrl = controllerAddr.startsWith('ws://') ? controllerAddr : `ws://${controllerAddr}`;

console.log('=== Execkee Workhorse Setup ===');
console.log(`Workhorse ID: ${workhorseId}`);
console.log(`Name: ${workhorseName}`);
console.log(`Platform: ${platform()}`);
console.log(`Server URL: ${serverUrl}`);
console.log(`Data directory: ${config.DATA_DIR}`);
console.log('');

if (!existsSync(config.DATA_DIR)) {
  mkdirSync(config.DATA_DIR, { recursive: true });
}

const workhorseConfig = {
  workhorseId,
  name: workhorseName,
  serverUrl,
  os: platform(),
  createdAt: new Date().toISOString(),
};

const configPath = join(config.DATA_DIR, 'workhorse-config.json');
writeFileSync(configPath, JSON.stringify(workhorseConfig, null, 2), 'utf-8');
console.log(`Config written to: ${configPath}`);

console.log('');
console.log('To start the subcontroller:');
console.log(`  node src/workhorse/index.js ${serverUrl} ${workhorseId} "${workhorseName}"`);
console.log('');
console.log('Setup complete.');
