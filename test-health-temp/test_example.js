// Test file with skipped test
test.skip('should do something', () => {
  console.log('no assertions');
});

// Test with assertion
test('should work', () => {
  expect(1).toBe(1);
});

// Unsandboxed reference
const gpu = require('gpuLease');
