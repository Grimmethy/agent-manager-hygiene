'use strict';

// nextCandidateFulfillmentTask - behavior preservation validator
// Used by param-count-fix and similar hygiene tasks to verify that refactored code
// maintains existing behavior when function signatures change.

/**
 * Verify behavior preservation between original and proposed function.
 * 
 * @param {string} originalSignature - The original function signature (e.g., "function foo(a, b, c)")
 * @param {string} proposedFix - The proposed fix/refactored code
 * @returns {object} Verification results with pass/fail status and details
 */
function nextCandidateFulfillmentTask(originalSignature, proposedFix) {
  const results = {
    preserved: true,
    issues: [],
    checks: {
      functionName: false,
      parameterCount: false,
      returnStatement: false,
      sideEffects: false,
      parameterNames: false
    }
  };

  // Extract function name from original signature
  const functionNameMatch = originalSignature.match(/function\s+(\w+)/);
  const originalFunctionName = functionNameMatch ? functionNameMatch[1] : null;

  // Extract parameter count from original signature
  const paramsMatch = originalSignature.match(/\(([^)]*)\)/);
  const originalParams = paramsMatch ? paramsMatch[1].split(',').map(p => p.trim()).filter(p => p) : [];
  const originalParamCount = originalParams.length;

  // Check 1: Function name preservation
  if (originalFunctionName) {
    const proposedFunctionNameMatch = proposedFix.match(/function\s+(\w+)/);
    const proposedFunctionName = proposedFunctionNameMatch ? proposedFunctionNameMatch[1] : null;
    
    if (proposedFunctionName === originalFunctionName) {
      results.checks.functionName = true;
    } else {
      results.preserved = false;
      results.issues.push(`Function name changed: "${originalFunctionName}" → "${proposedFunctionName}"`);
    }
  }

  // Check 2: Parameter count preservation
  const proposedParamsMatch = proposedFix.match(/\(([^)]*)\)/);
  const proposedParams = proposedParamsMatch ? proposedParamsMatch[1].split(',').map(p => p.trim()).filter(p => p) : [];
  const proposedParamCount = proposedParams.length;

  if (proposedParamCount === originalParamCount) {
    results.checks.parameterCount = true;
  } else {
    results.preserved = false;
    results.issues.push(`Parameter count changed: ${originalParamCount} → ${proposedParamCount}`);
  }

  // Check 3: Return statement preservation
  const hasReturnOriginal = /\breturn\s/.test(originalSignature);
  const hasReturnProposed = /\breturn\s/.test(proposedFix);
  
  if (hasReturnOriginal === hasReturnProposed) {
    results.checks.returnStatement = true;
  } else if (hasReturnOriginal && !hasReturnProposed) {
    results.preserved = false;
    results.issues.push('Return statement removed in proposed fix');
  }

  // Check 4: Side effect detection (simplified - looks for common patterns)
  const sideEffectPatterns = [
    /\bconsole\.\w+\s*\(/,
    /\bfs\.\w+\s*\(/,
    /\brequire\s*\(/,
    /\bimport\s+/,
    /\bdelete\s+/,
    /\b\.push\s*\(/,
    /\b\.pop\s*\(/,
    /\b\.shift\s*\(/,
    /\b\.unshift\s*\(/
  ];

  const hasSideEffectsOriginal = sideEffectPatterns.some(pattern => pattern.test(originalSignature));
  const hasSideEffectsProposed = sideEffectPatterns.some(pattern => pattern.test(proposedFix));

  if (hasSideEffectsOriginal === hasSideEffectsProposed) {
    results.checks.sideEffects = true;
  } else if (!hasSideEffectsOriginal && hasSideEffectsProposed) {
    results.preserved = false;
    results.issues.push('New side effects detected in proposed fix');
  }

  // Check 5: Parameter name preservation (if parameter count unchanged)
  if (originalParamCount === proposedParamCount && originalParams.length > 0) {
    const allParamsPreserved = originalParams.every((param, index) => {
      const paramName = param.split('=')[0].trim().split(':')[0].trim();
      const proposedParamName = proposedParams[index].split('=')[0].trim().split(':')[0].trim();
      return paramName === proposedParamName;
    });

    if (allParamsPreserved) {
      results.checks.parameterNames = true;
    } else {
      results.issues.push('Parameter names changed');
    }
  }

  return results;
}

module.exports = { nextCandidateFulfillmentTask };
