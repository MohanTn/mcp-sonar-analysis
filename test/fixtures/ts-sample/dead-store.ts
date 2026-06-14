// File with S1854 violation: dead store (unused assignment)
// A variable is assigned a value that is never read before being reassigned or going out of scope.

export function processData() {
  let x = 1; // S1854: this assignment is a dead store because x is reassigned before being read
  x = 2;
  console.log(x);
}

export function anotherExample() {
  let unused = 'first'; // S1854: assigned but then immediately reassigned without reading
  unused = 'second';
  return unused;
}
