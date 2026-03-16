// Suppress Node.js punycode deprecation warning (DEP0040)
// triggered by axios transitive dependency.
// Usage: node --require ./scripts/suppress-warnings.cjs src/index.js

'use strict';

const originalEmitWarning = process.emitWarning;

process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('punycode')) return;
  if (warning?.name === 'DeprecationWarning' && warning?.message?.includes('punycode')) return;
  return originalEmitWarning.call(process, warning, ...args);
};
