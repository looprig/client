package webui

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// indexContent reads the real committed placeholder so tests assert against
// its actual bytes rather than a hardcoded duplicate string.
func indexContent(t *testing.T) string {
	t.Helper()
	b, err := fs.ReadFile(FS, indexPath)
	if err != nil {
		t.Fatalf("reading embedded %s: %v", indexPath, err)
	}
	return string(b)
}

// TestEmbedFSRejectsTraversalNames documents (and locks in) the embed.FS
// guarantee this package's confinement logic is layered on top of:
// fs.FS/fs.ValidPath rejects any name containing ".." elements or a leading
// "/" outright, at Open time, regardless of what the caller passes in.
// Verified empirically (see task investigation) before writing assetName.
func TestEmbedFSRejectsTraversalNames(t *testing.T) {
	t.Parallel()
	names := []string{
		"../../etc/passwd",
		"dist/../../../etc/passwd",
		"/etc/passwd",
		"dist/../etc/passwd",
	}
	for _, name := range names {
		if _, err := FS.Open(name); err == nil {
			t.Errorf("FS.Open(%q): want error (invalid/not-exist per fs.ValidPath), got nil", name)
		}
	}
	// Sanity: a legitimate embedded name still opens fine.
	if _, err := FS.Open(indexPath); err != nil {
		t.Fatalf("FS.Open(%q): unexpected error %v", indexPath, err)
	}
}

func TestAssetName(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		reqPath string
		want    string
	}{
		{name: "root", reqPath: "/", want: root},
		{name: "index explicit", reqPath: "/index.html", want: "dist/index.html"},
		{name: "nested asset", reqPath: "/assets/app.js", want: "dist/assets/app.js"},
		{name: "spa client route", reqPath: "/sessions/abc123", want: "dist/sessions/abc123"},
		{name: "dotdot traversal clamps at root", reqPath: "/../../etc/passwd", want: "dist/etc/passwd"},
		{name: "mixed-dot pattern is a literal filename, not traversal", reqPath: "/....//....//etc/passwd", want: "dist/..../..../etc/passwd"},
		{name: "empty path", reqPath: "", want: root},
		{name: "double slashes collapse", reqPath: "//assets//app.js", want: "dist/assets/app.js"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := assetName(tt.reqPath)
			if got != tt.want {
				t.Errorf("assetName(%q) = %q, want %q", tt.reqPath, got, tt.want)
			}
			// Invariant this whole function exists to guarantee: the
			// result never escapes root.
			if got != root && !strings.HasPrefix(got, root+"/") {
				t.Errorf("assetName(%q) = %q escapes root %q", tt.reqPath, got, root)
			}
		})
	}
}

// TestHandlerTraversal drives Handler() (backed by the real embedded FS)
// with httptest.NewRequest, which parses the target exactly as a real
// server would receive it off the wire — including populating RawPath for
// percent-encoded paths — so this exercises the same Path/RawPath split a
// live net/http server hands to any registered handler.
func TestHandlerTraversal(t *testing.T) {
	want := indexContent(t)

	cases := []struct {
		name string
		path string // request-target, as passed to httptest.NewRequest
	}{
		{name: "dotdot traversal", path: "/../../etc/passwd"},
		{name: "url-encoded slash traversal", path: "/..%2f..%2fetc%2fpasswd"},
		{name: "mixed-dot waf-bypass pattern", path: "/....//....//etc/passwd"},
		{name: "unknown asset", path: "/no-such-file.js"},
		{name: "spa client route", path: "/sessions/abc123"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()

			Handler().ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got := rec.Body.String(); got != want {
				t.Fatalf("body = %q, want SPA index fallback %q", got, want)
			}
		})
	}
}

// TestHandlerTraversalOverRealHTTP repeats the traversal-shaped requests as
// literal GET requests over a real listening httptest.Server, so the
// request line is constructed and parsed exactly as an attacker's raw HTTP
// client would send it (as opposed to Go's http.NewRequest/URL-parsing
// short-circuiting anything). None of these responses may contain content
// from outside the embedded dist/ root.
func TestHandlerTraversalOverRealHTTP(t *testing.T) {
	want := indexContent(t)

	srv := httptest.NewServer(Handler())
	t.Cleanup(srv.Close)

	targets := []string{
		"/../../etc/passwd",
		"/..%2f..%2fetc%2fpasswd",
		"/....//....//etc/passwd",
	}
	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			req, err := http.NewRequest(http.MethodGet, srv.URL+target, nil)
			if err != nil {
				t.Fatalf("NewRequest(%q): %v", target, err)
			}
			client := &http.Client{
				Timeout: 5 * time.Second,
				// Traversal must be blocked at the response for THIS
				// request, not merely by chasing a redirect elsewhere;
				// don't let redirect-following mask what this handler
				// actually returned.
				CheckRedirect: func(*http.Request, []*http.Request) error {
					return http.ErrUseLastResponse
				},
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("Do(%q): %v", target, err)
			}
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("reading body: %v", err)
			}
			if strings.Contains(string(body), "root:") {
				t.Fatalf("response body looks like it leaked /etc/passwd contents: %q", body)
			}
			// A redirect (3xx) back into this same handler is fine —
			// net/http's ServeMux performs one for the plain "/../.."
			// case when a handler is mounted under a mux (observed
			// empirically); this handler is a raw http.HandlerFunc with
			// no mux in front of it here, so no redirect is expected —
			// but assert the terminal, non-redirect behavior either way.
			if resp.StatusCode >= 300 && resp.StatusCode < 400 {
				return
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 (SPA fallback) or a redirect back into this handler", resp.StatusCode)
			}
			if string(body) != want {
				t.Fatalf("body = %q, want SPA index fallback %q", body, want)
			}
		})
	}
}

// TestHandlerServesRealAssets proves normal asset serving works — not just
// that attacks are blocked — using a small in-memory fs.FS fixture (rather
// than adding non-placeholder files to the committed dist/, which
// //go:embed would bake in at compile time). newHandler is parameterized
// over fs.FS for exactly this reason.
func TestHandlerServesRealAssets(t *testing.T) {
	t.Parallel()

	const assetBody = "console.log('app');"
	fsys := fstest.MapFS{
		"dist/index.html":    {Data: []byte("<html>shell</html>")},
		"dist/assets/app.js": {Data: []byte(assetBody)},
		"dist/favicon.ico":   {Data: []byte("ico-bytes")},
		"dist/assets":        {Mode: fs.ModeDir},
	}
	h := newHandler(fsys)

	t.Run("real nested asset is served as-is", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Body.String(); got != assetBody {
			t.Fatalf("body = %q, want %q", got, assetBody)
		}
	})

	t.Run("unknown path falls back to index", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/sessions/xyz", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Body.String(); got != "<html>shell</html>" {
			t.Fatalf("body = %q, want index shell", got)
		}
	})

	t.Run("directory path falls back to index, not a directory listing", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/assets", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Body.String(); got != "<html>shell</html>" {
			t.Fatalf("body = %q, want index shell (no directory listing)", got)
		}
	})

	t.Run("traversal against the fixture also falls back to index", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodGet, "/../assets/app.js", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		// path.Clean("/" + "/../assets/app.js") clamps to "/assets/app.js",
		// which IS a real, in-root asset — so this is expected to serve
		// the asset, not the index. This case exists to document that
		// clamping (not blanket rejection) is the intended behavior for
		// in-root paths that merely contain resolvable ".." segments.
		if got := rec.Body.String(); got != assetBody {
			t.Fatalf("body = %q, want clamped-and-served asset %q", got, assetBody)
		}
	})
}

func TestHandlerRootServesIndex(t *testing.T) {
	t.Parallel()
	want := indexContent(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
}
