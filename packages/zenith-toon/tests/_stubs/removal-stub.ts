// Test-only passthrough for the not-yet-built ./removal.js (the one intentional
// build red). Aliased in by vitest.config.ts ONLY while src/removal.ts is absent,
// so the constraint suite can EXERCISE engines that statically import the removal
// handoff — e.g. the BMX+ knee, which runs and writes metadata.bmx BEFORE bmxEngine
// calls removalEngine. This is NOT the removal engine; it ranks/drops nothing, just
// returns the payload so module load succeeds. No src file is created; tsc ignores
// this, so the package build stays red on ./removal.js exactly as designed.
export function removalEngine(payload: unknown): unknown {
  return payload;
}
