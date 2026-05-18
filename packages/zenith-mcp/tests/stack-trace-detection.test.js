import { describe, expect, it } from 'vitest';
import { compressString } from 'zenith-toon';

// _isStackTrace is internal to string-codec, so we test it through compressString.
// When _isStackTrace returns true, compressString applies stack-trace compression
// which produces "[N frames omitted]" markers. When it returns false, normal text
// compression is used instead.

function containsFramesOmitted(output) {
  return /\d+\s*frames?\s*omitted/i.test(output) || /\[\d+ frames omitted\]/i.test(output);
}

describe('_isStackTrace detection (tested via compressString)', () => {
  describe('single-line errors should NOT trigger stack compression', () => {
    it('single-line TypeError', () => {
      const input = "TypeError: Cannot read property 'x' of undefined";
      // Budget large enough to not truncate, but small enough that stack compression
      // would activate if detected as stack trace
      const output = compressString(input, 500);
      expect(containsFramesOmitted(output)).toBe(false);
    });

    it('single-line "Invalid input Error: field required"', () => {
      const input = 'Invalid input Error: field required';
      const output = compressString(input, 500);
      expect(containsFramesOmitted(output)).toBe(false);
    });

    it('single-line ReferenceError', () => {
      const input = 'ReferenceError: foo is not defined';
      const output = compressString(input, 500);
      expect(containsFramesOmitted(output)).toBe(false);
    });

    it('error message in a log line', () => {
      const input = '2024-01-15T10:30:00Z ERROR: Connection timeout after 5000ms';
      const output = compressString(input, 500);
      expect(containsFramesOmitted(output)).toBe(false);
    });
  });

  describe('real stack traces SHOULD trigger stack compression', () => {
    it('JavaScript Error with stack frames', () => {
      const input = `TypeError: Cannot read properties of null (reading 'map')
    at processItems (/app/src/utils.js:42:15)
    at handleRequest (/app/src/server.js:108:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:114:3)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/node_modules/express/lib/router/index.js:284:15
    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)`;
      // With a tight budget, stack compression should omit internal frames
      const output = compressString(input, 200);
      expect(containsFramesOmitted(output)).toBe(true);
    });

    it('Python traceback', () => {
      const input = `Traceback (most recent call last):
  File "/app/main.py", line 42, in handle_request
    result = process_data(payload)
  File "/app/processor.py", line 18, in process_data
    validated = schema.validate(data)
  File "/app/schema.py", line 7, in validate
    raise ValidationError("Invalid field")
ValidationError: Invalid field`;
      const output = compressString(input, 200);
      expect(containsFramesOmitted(output)).toBe(true);
    });

    it('JVM chained exceptions', () => {
      const input = `java.lang.RuntimeException: Failed to initialize
    at com.app.Server.start(Server.java:42)
    at com.app.Main.main(Main.java:10)
Caused by: java.sql.SQLException: Connection refused
    at com.mysql.Driver.connect(Driver.java:88)
    at com.app.Database.getConnection(Database.java:33)
    at com.app.Server.initDb(Server.java:38)`;
      const output = compressString(input, 200);
      expect(containsFramesOmitted(output)).toBe(true);
    });
  });

  describe('boundary cases for detection logic', () => {
    it('two header lines with no frames (chained exception pattern) triggers detection', () => {
      const input = `NullPointerException: value was null
Caused by: IllegalStateException: service not initialized
Some additional context message here`;
      // headerCount >= 2 → true
      const output = compressString(input, 100);
      // This should be recognized as a stack trace due to 2+ headers
      expect(containsFramesOmitted(output)).toBe(true);
    });

    it('single header with single frame triggers detection', () => {
      const input = `TypeError: x is not a function
    at Object.<anonymous> (/app/index.js:5:1)`;
      // headerCount >= 1 && frameCount >= 1 → true
      // Budget must be smaller than input length to trigger compression
      const output = compressString(input, 30);
      expect(containsFramesOmitted(output)).toBe(true);
    });

    it('single header with no frames does NOT trigger detection', () => {
      const input = `TypeError: x is not a function
This is just a regular error message with no stack frames.
It has multiple lines but none of them look like frames.`;
      const output = compressString(input, 500);
      expect(containsFramesOmitted(output)).toBe(false);
    });

    it('two frames with no header triggers detection', () => {
      const input = `Something went wrong:
    at processItem (/app/worker.js:15:3)
    at main (/app/index.js:42:7)
Done.`;
      // frameCount >= 2 → true
      const output = compressString(input, 80);
      expect(containsFramesOmitted(output)).toBe(true);
    });
  });
});
