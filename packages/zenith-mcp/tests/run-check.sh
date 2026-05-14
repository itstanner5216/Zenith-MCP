#!/bin/bash
cd /home/tanner/Projects/Zenith-MCP
echo "=== Running npm run build ==="
npm run build 2>&1
BUILD_EXIT=$?
echo "Build exit code: $BUILD_EXIT"

echo ""
echo "=== Running source-backed-parity test ==="
npx vitest run tests/migration-gates/source-backed-parity.test.js 2>&1
TEST_EXIT=$?

echo ""
echo "=== Running npm test ==="
npm test 2>&1
FULL_TEST_EXIT=$?

echo ""
echo "=== Summary ==="
echo "Build: $BUILD_EXIT"
echo "Source-backed-parity: $TEST_EXIT"  
echo "npm test: $FULL_TEST_EXIT"
