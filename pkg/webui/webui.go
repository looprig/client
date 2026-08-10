// Package webui embeds the client's built single-page app and serves it
// with the standard SPA-router fallback pattern: a request for a real file
// under dist/ (JS, CSS, images, ...) is served as-is; any other request
// falls back to dist/index.html so client-side routes like /sessions/abc123
// still return the app shell.
//
// This is the client module's only exported package. It exists so an
// external consumer (e.g. a future swe binary) can embed the built SPA
// without importing anything from the module's internal BFF/proxy
// machinery — FS and Handler are the entire public surface.
//
// dist/ currently holds a committed placeholder (index.html) because the
// real SvelteKit build doesn't exist yet; //go:embed requires the embedded
// path to exist at compile time, so this keeps `go build`/`go vet`/`go test`
// green with no Node toolchain installed. `make app`'s real build later
// overwrites everything under dist/ except the committed index.html (see
// .gitignore).
package webui

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// FS is the embedded SPA build (currently just the placeholder dist/index.html;
// see the package doc). Exported so external consumers can serve or inspect
// the build directly instead of going through Handler.
//
//go:embed dist
var FS embed.FS

const (
	// root is FS's embedded subtree. Every path served by Handler is
	// confined under this prefix; see assetName.
	root = "dist"
	// indexPath is the SPA shell served for any request that doesn't
	// match a real embedded file.
	indexPath = "dist/index.html"
)

// Handler returns an http.Handler serving the embedded SPA build: a real
// asset under dist/ if the request path names one, otherwise dist/index.html
// (the SPA-router fallback).
//
// Every request path is cleaned and confined to the embedded dist/ root
// before ever being handed to embed.FS.Open — see assetName and
// webui_test.go for the traversal cases this defends against, and the
// package's git history / task notes for what was empirically verified
// about embed.FS's and net/http's own path handling.
func Handler() http.Handler {
	return newHandler(FS)
}

// newHandler builds the handler over an arbitrary fs.FS so the serving and
// traversal-confinement logic can be tested against a small controlled
// fixture (see webui_test.go) without needing a second real //go:embed
// tree.
func newHandler(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := assetName(r.URL.Path)
		if name != indexPath && serveAsset(w, r, fsys, name) {
			return
		}
		serveIndex(w, r, fsys)
	})
}

// assetName maps an inbound request path to a path inside fsys, confined to
// root ("dist/..."). It never returns a path that can escape root:
//
//   - "/" + reqPath forces the path to be rooted before cleaning, so
//     path.Clean's documented behavior — "'..' elements that begin a rooted
//     path are replaced with a no-op", i.e. clamped at '/' rather than
//     walking above it — applies unconditionally, regardless of how many
//     ".." segments reqPath contains.
//   - path.Join(root, clean) then Cleans again, so the result can only ever
//     be root itself or something rooted at "root/".
//   - The HasPrefix check is defense in depth against that clamping
//     behavior ever regressing (e.g. a future refactor swapping path.Clean
//     for something else): any result that isn't root or root+"/" falls
//     back to the index rather than being opened.
//
// io/fs additionally requires (fs.ValidPath) that names passed to Open
// contain no ".." elements and no leading "/" at all, and embed.FS enforces
// that itself — so even a bug in this function that let a "../"-bearing
// name through would still be rejected by fsys.Open, not silently followed.
// This function exists anyway because CLAUDE.md requires paths to be
// cleaned and confinement-checked at the boundary, not because embed.FS's
// own check was found to be insufficient.
func assetName(reqPath string) string {
	clean := path.Clean("/" + reqPath)
	name := path.Join(root, clean)
	if name != root && !strings.HasPrefix(name, root+"/") {
		return indexPath
	}
	return name
}

// serveAsset attempts to serve name as a real file from fsys. It reports
// whether it did; a false return (missing, unreadable, or a directory)
// means the caller should fall back to the SPA index.
func serveAsset(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) bool {
	f, err := fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return false
	}

	rs, ok := f.(io.ReadSeeker)
	if !ok {
		// Every fs.FS this package is used with in practice (embed.FS,
		// fstest.MapFS) returns io.ReadSeeker files. Fall back rather
		// than serve without range/seek support.
		return false
	}

	http.ServeContent(w, r, path.Base(name), info.ModTime(), rs)
	return true
}

// serveIndex serves the SPA shell. It is the fallback for every request
// that doesn't name a real embedded asset, and also the terminal path for a
// missing/unreadable index itself — which is a build-time invariant
// violation (dist/index.html always exists per the package doc), not an
// attacker-reachable state, so it fails with 500 rather than panicking.
func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	f, err := fsys.Open(indexPath)
	if err != nil {
		http.Error(w, "webui: embedded index.html is missing", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "webui: embedded index.html is missing", http.StatusInternalServerError)
		return
	}

	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "webui: embedded index.html is missing", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", info.ModTime(), rs)
}
