// File with S2589 violation: condition is always true or always false
// This condition is always the same, making the conditional logic unreachable or redundant.

export function alwaysTrueCheck() {
  const x = 5;
  if (x === 5 || x !== 5) {
    // S2589: This condition is always true because x is either equal to 5 OR not equal to 5
    console.log('This always runs');
  }
}

export function alwaysFalse() {
  const y = 10;
  if (y > 20 && y < 5) {
    // S2589: This condition is always false - a number cannot be both > 20 and < 5
    console.log('This never runs');
  }
}

export function literalTrueCondition() {
  if (true) {
    // S2589: Literal true condition
    console.log('Redundant condition');
  }
}
