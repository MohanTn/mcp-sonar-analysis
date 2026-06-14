// File that imports from another fixture file (for dependency graph testing)

import { helperFunction, helperData } from './helper.js';

export function useHelper() {
  const result = helperFunction();
  console.log(`Helper says: ${result}`);
  console.log(`Helper data:`, helperData);
}
