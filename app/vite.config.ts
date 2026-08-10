import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter({
				// Build output lands directly in pkg/webui/dist, which pkg/webui
				// embeds via //go:embed dist (see ../pkg/webui/webui.go). Both
				// pages and assets point at the same directory: this is a pure
				// SPA, there's no separate prerendered-pages vs. static-assets
				// split to make.
				pages: '../pkg/webui/dist',
				assets: '../pkg/webui/dist',
				// SPA fallback, not per-route prerendering: routes like
				// /sessions/{sid} must work for arbitrary session IDs that can't
				// be enumerated at build time, so every request that isn't a
				// real asset needs to fall through to one shell and let
				// client-side routing take over from there (see root
				// +layout.ts's `ssr = false`). Naming the fallback "index.html"
				// also matches pkg/webui's own SPA-fallback path
				// (dist/index.html) exactly, so no extra wiring is needed on
				// the Go side.
				fallback: 'index.html'
			})
		})
	],
	server: {
		proxy: {
			// internal/config.DefaultAddr (the BFF's default bind address) is
			// 127.0.0.1:8080; proxy /api there in dev so the SPA can call the
			// BFF without CORS while vite dev serves the app itself.
			'/api': 'http://127.0.0.1:8080'
		}
	},
	test: {
		// Svelte 5 component tests need a real browser DOM (not jsdom) to
		// mount `.svelte` files — this is `sv add vitest=usages:component`'s
		// current (verified empirically 2026-08-10, shadcn-svelte/sv CLI
		// v0.17.0) scaffold: `vitest-browser-svelte`'s `render()` +
		// `@vitest/browser-playwright` driving a real headless Chromium via
		// Playwright, not `@testing-library/svelte` + jsdom (the task brief's
		// suggested "common current approach" is out of date for Svelte 5 —
		// flagged in the task report). This, `@vitest/browser-playwright`,
		// and `playwright` itself (a real browser binary, fetched once via
		// `npx playwright install chromium`, not just an npm package) are new
		// dependencies this task adds and are NOT yet in CLAUDE.md's approved
		// npm list — flagged for sign-off, same pattern Task 18 used for
		// `vite-plugin-svelte`.
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
