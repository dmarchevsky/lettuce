/**
 * The globals the render-test preload installs (`dom-preload.ts`).
 *
 * happy-dom's `Document` and `Window` are its own classes, structurally different from the `lib.dom` types
 * `tsc` assumes, so the assignment in the preload is a deliberate cast. Declaring them here keeps that cast in
 * one file instead of spreading `as any` through every render test.
 */
declare global {
  // biome-ignore lint/suspicious/noExplicitAny: the happy-dom window is asserted here once, so tests read it through lib.dom types.
  var document: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

export {};
