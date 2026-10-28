// Native ESM exposes Jest's mock API through @jest/globals. Preserve the global
// mock API expected by the existing suites without changing their behavior.
globalThis.jest = require('@jest/globals').jest;
