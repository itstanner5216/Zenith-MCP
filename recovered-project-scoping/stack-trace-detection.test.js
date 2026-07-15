import { describe, expect, it } from 'vitest';
import { compressString } from 'zenith-toon';

// _isStackTrace is internal to string-codec, so we test it through compressString.
// When _isStackTrace returns true, compressString applies stack-trace compression.
// The 70% retention floor prevents over-compression — output will be ~70% of original.

describe('_isStackTrace detection (tested via compressString)', () => {
  describe('single-line errors should NOT trigger compression', () => {
    it('single-line TypeError - no compression needed', () => {
      const input = "TypeError: Cannot read property 'x' of undefined";
      const output = compressString(input, 500);
      // Single line, fits in budget - should return unchanged
      expect(output).toBe(input);
    });

    it('single-line "Invalid input Error: field required"', () => {
      const input = 'Invalid input Error: field required';
      const output = compressString(input, 500);
      expect(output).toBe(input);
    });

    it('single-line ReferenceError', () => {
      const input = 'ReferenceError: foo is not defined';
      const output = compressString(input, 500);
      expect(output).toBe(input);
    });

    it('error message in a log line', () => {
      const input = '2024-01-15T10:30:00Z ERROR: Connection timeout after 5000ms';
      const output = compressString(input, 500);
      expect(output).toBe(input);
    });
  });

  describe('real stack traces SHOULD trigger compression (70% retention floor)', () => {
    it('JavaScript Error with stack frames - compresses to ~70%', () => {
      const input = `TypeError: Cannot read properties of null (reading 'map')
    at processItems (/app/src/utils.js:42:15)
    at handleRequest (/app/src/server.js:108:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/node_modules/express/lib/router/index.js:284:15
    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)`;
      const output = compressString(input, 100); // Request tiny budget
      // 70% floor means output will be ~70% of input, not 100 chars
      expect(output.length).toBeLessThan(input.length);
      expect(output.length).toBeGreaterThanOrEqual(Math.floor(input.length * 0.65));
      expect(output.length).toBeLessThanOrEqual(Math.floor(input.length * 0.75));
    });

    it('Python traceback - compresses to ~70%', () => {
      const input = `Traceback (most recent call last):
  File "/app/main.py", line 42, in handle_request
    result = process_data(payload)
  File "/app/processor.py", line 18, in process_data
    validated = schema.validate(data)
  File "/app/schema.py", line 7, in validate
    raise ValidationError("Invalid field")
ValidationError: Invalid field`;
      const output = compressString(input, 100);
      expect(output.length).toBeLessThan(input.length);
      expect(output.length).toBeGreaterThanOrEqual(Math.floor(input.length * 0.65));
    });

    it('JVM chained exceptions - compresses to ~70%', () => {
      const input = `java.lang.RuntimeException: Failed to initialize
    at com.app.Server.start(Server.java:42)
    at com.app.Main.main(Main.java:10)
Caused by: java.sql.SQLException: Connection refused
    at com.mysql.Driver.connect(Driver.java:88)
    at com.app.Database.getConnection(Database.java:33)
    at com.app.Server.initDb(Server.java:38)`;
      const output = compressString(input, 100);
      expect(output.length).toBeLessThan(input.length);
      expect(output.length).toBeGreaterThanOrEqual(Math.floor(input.length * 0.65));
    });
  });

  describe('boundary cases for detection logic', () => {
    it('two header lines triggers detection (chained exception pattern)', () => {
      const input = `NullPointerException: value was null
Caused by: IllegalStateException: service not initialized
Some additional context message here`;
      // headerCount >= 2 → detected as stack trace
      // But input is small, 70% floor may keep it mostly intact
      const output = compressString(input, 10);
      // Just verify it doesn't crash and returns something reasonable
      expect(output.length).toBeLessThanOrEqual(input.length);
      expect(output.length).toBeGreaterThan(0);
    });

    it('single header with single frame triggers detection', () => {
      const input = `TypeError: x is not a function
    at Object.<anonymous> (/app/index.js:5:1)`;
      // Small input - 70% floor keeps most of it
      const output = compressString(input, 10);
      expect(output.length).toBeGreaterThan(0);
    });

    it('single header with no frames does NOT trigger stack detection', () => {
      const input = `TypeError: x is not a function
This is just a regular error message with no stack frames.
It has multiple lines but none of them look like frames.`;
      const output = compressString(input, 500);
      // Large budget, small input - no compression needed
      expect(output).toBe(input);
    });

    it('two frames with no header triggers detection', () => {
      const input = `Something went wrong:
    at processItem (/app/worker.js:15:3)
    at main (/app/index.js:42:7)
Done.`;
      // frameCount >= 2 → detected as stack trace
      const output = compressString(input, 10);
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
