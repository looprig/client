import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
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
	}
});
