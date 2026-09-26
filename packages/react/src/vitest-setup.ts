// Importing the default entry (not /pure) registers `page.render` /
// `page.renderHook` and a global `beforeEach(cleanup)`. Cleanup runs BEFORE
// each test rather than after, so the last render stays inspectable in the
// Vitest Browser UI. StrictMode stays off by default (verified in the shipped
// bundle: `const config = { reactStrictMode: false }`), so Task 4.8 opts in
// with a per-test wrapper and no other test is silently double-mounted.
import "vitest-browser-react";
