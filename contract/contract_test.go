package contract_test

import (
	"bytes"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// pinnedCore resolves the core module that go.mod pins: its directory in
// the module cache, and its version. Both come from one `go list -m`, so the
// bytes asserted below and the version asserted against contract/VERSION can
// never describe two different modules.
func pinnedCore(t *testing.T) (dir, version string) {
	t.Helper()
	const sep = "\t"
	const modulePath = "github.com/looprig/core"
	// This module lives inside the parent looprig/go.work workspace. Without
	// GOWORK=off, `go` auto-detects go.work by walking up from this directory and
	// resolves the core module via the workspace's own checkout instead of the
	// version this module's go.mod pins -- silently wrong, not an error. The
	// checkout would also report an empty version, so contract/VERSION could
	// never be asserted at all.
	run := func(args ...string) (string, error) {
		cmd := exec.Command("go", args...) // #nosec G204 -- fixed argv, no external input
		cmd.Env = append(os.Environ(), "GOWORK=off")
		out, err := cmd.Output()
		// TrimRight, never TrimSpace: an EMPTY Dir is the signal that the module is
		// not yet in the cache, and it arrives as a leading tab. TrimSpace would eat
		// it, collapsing "\tv0.7.0\n" to "v0.7.0" so the Cut below reports no pair
		// at all and the download branch never fires.
		return strings.TrimRight(string(out), "\n"), err
	}

	out, err := run("list", "-m", "-f", "{{.Dir}}"+sep+"{{.Version}}", modulePath)
	if err != nil {
		t.Fatalf("locate core module: %v", err)
	}
	dir, version, ok := strings.Cut(out, sep)

	// `go list -m` reports the pinned VERSION without downloading, but leaves Dir
	// EMPTY until the module is actually in the cache. Every local run has a warm
	// cache from `go get`, so this only ever bites on a clean machine -- it is what
	// turned CI red on the first push of this guard. Download and retry rather than
	// skipping: a skipped drift guard is indistinguishable from a passing one, which
	// is the whole failure mode this file exists to prevent.
	if ok && dir == "" && version != "" {
		if _, err := run("mod", "download", modulePath); err != nil {
			t.Fatalf("go mod download %s: %v", modulePath, err)
		}
		if out, err = run("list", "-m", "-f", "{{.Dir}}"+sep+"{{.Version}}", modulePath); err != nil {
			t.Fatalf("go list -m %s after download: %v", modulePath, err)
		}
		dir, version, ok = strings.Cut(out, sep)
	}

	if !ok || dir == "" || version == "" {
		t.Fatalf("`go list -m` gave no dir/version pair: %q", out)
	}
	return dir, version
}

// coreSessionwire is the pinned core version's sessionwire/v1 directory, so
// the assertion is against the exact version go.mod names.
func coreSessionwire(t *testing.T) string {
	t.Helper()
	dir, _ := pinnedCore(t)
	return filepath.Join(dir, "sessionwire", "v1")
}

// TestContractVersionMatchesPinnedCore pins contract/VERSION to the version
// go.mod actually requires. The byte comparison below is the primary guard, but
// it goes quiet whenever two Core releases happen to ship identical artifacts:
// the vendored bytes are then correct while VERSION silently names the wrong
// release, and the next reader trusts a stale provenance record. This is also
// the assertion that catches a `make contract` run whose CORE_VERSION was
// never moved with the go.mod bump.
func TestContractVersionMatchesPinnedCore(t *testing.T) {
	t.Parallel()

	_, want := pinnedCore(t)
	raw, err := os.ReadFile("VERSION")
	if err != nil {
		t.Fatalf("read contract/VERSION (run `make contract`): %v", err)
	}
	if got := strings.TrimSpace(string(raw)); got != want {
		t.Errorf("contract/VERSION = %q, pinned core is %q (update CORE_VERSION in the Makefile and run `make contract`)", got, want)
	}
}

// TestMakefileCoreVersionMatchesPinnedCore keeps the refresh recipe on the same
// published Core version as go.mod. VERSION alone cannot catch a stale
// CORE_VERSION because the drift tests do not execute `make contract`.
func TestMakefileCoreVersionMatchesPinnedCore(t *testing.T) {
	t.Parallel()

	_, want := pinnedCore(t)
	raw, err := os.ReadFile(filepath.Join("..", "Makefile"))
	if err != nil {
		t.Fatalf("read Makefile: %v", err)
	}
	const prefix = "CORE_VERSION := "
	var matches []string
	for _, line := range strings.Split(string(raw), "\n") {
		if version, ok := strings.CutPrefix(line, prefix); ok {
			matches = append(matches, version)
		}
	}
	if len(matches) != 1 {
		t.Fatalf("Makefile contains %d %q assignments, want exactly one", len(matches), strings.TrimSpace(prefix))
	}
	if got := strings.TrimSpace(matches[0]); got != want {
		t.Errorf("Makefile CORE_VERSION = %q, pinned core is %q", got, want)
	}
}

// TestContractMatchesPinnedCore proves contract/ is a verbatim copy of the
// pinned core version's sessionwire/v1 artifacts. This is the drift guard: bumping
// core without re-running `make contract` fails here, and a genuine wire change
// surfaces as a reviewable fixture diff rather than a silent protocol mismatch at
// runtime.
func TestContractMatchesPinnedCore(t *testing.T) {
	t.Parallel()

	upstream := coreSessionwire(t)
	for _, dir := range []string{"schema", "fixtures"} {
		upstreamDir := filepath.Join(upstream, dir)
		if dir == "fixtures" {
			upstreamDir = filepath.Join(upstream, "testdata", dir)
		}
		upstreamFiles := treeFiles(t, upstreamDir)
		localFiles := treeFiles(t, dir)
		if len(upstreamFiles) == 0 {
			t.Fatalf("pinned core %s tree is empty; refusing a vacuous contract comparison", dir)
		}
		for name, want := range upstreamFiles {
			got, ok := localFiles[name]
			if !ok {
				t.Errorf("missing vendored %s/%s (run `make contract`)", dir, name)
				continue
			}
			if !bytes.Equal(got, want) {
				t.Errorf("%s/%s differs from pinned core (run `make contract`)", dir, name)
			}
		}

		// Reverse pass: a vendored path with no upstream counterpart means the
		// file was removed or renamed upstream and contract/ retained a stale copy.
		for name := range localFiles {
			if _, ok := upstreamFiles[name]; !ok {
				t.Errorf("vendored %s/%s no longer exists upstream (removed or renamed; run `make contract`)", dir, name)
			}
		}
	}
}

// treeFiles reads every regular file below root, keyed by its slash-separated
// relative path. Recursing is load-bearing: a new nested Core artifact must not
// disappear merely because the current release happens to use flat trees.
func treeFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := make(map[string][]byte)
	err := fs.WalkDir(os.DirFS(root), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return &fs.PathError{Op: "walk", Path: name, Err: fs.ErrInvalid}
		}
		body, err := fs.ReadFile(os.DirFS(root), name)
		if err != nil {
			return err
		}
		files[name] = body
		return nil
	})
	if err != nil {
		t.Fatalf("read contract tree %s: %v", root, err)
	}
	return files
}
