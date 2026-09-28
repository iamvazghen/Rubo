#!/usr/bin/env -S node --import tsx
// Runs under Node, not Bun: Bun on Windows never reports terminal resizes
// (no resize event, stale stdout.columns), so the layout could not follow the window.
import { config } from 'dotenv';
import { runCli } from './cli.js';

// Load environment variables
config({ quiet: true });

await runCli();
