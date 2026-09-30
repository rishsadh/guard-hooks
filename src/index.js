export { analyzeChange, inspectFile, fingerprint, compareFingerprints } from './compare.js';
export { findMojibake, countMojibake } from './mojibake.js';
export { lintShell } from './shell.js';
export { LEVELS, classifyCommand, classifyTool, decide, rankOf } from './levels.js';
export { preTool, postTool, gate, checkWrite } from './hook.js';
export { checkStaged } from './git.js';
export { settingsSnippet } from './init.js';
export { loadConfig, DEFAULTS } from './config.js';
