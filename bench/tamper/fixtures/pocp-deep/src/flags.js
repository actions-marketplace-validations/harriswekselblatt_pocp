// Bench fixture for deep mode: three functions with one mutation site each, and each site is
// caught by exactly one assertion, so weakening one assertion loses exactly one planted bug.
export const isAdult = (age) => age >= 18;
export const isNone = (x) => x === null;
export const both = (a, b) => a && b;
