package contract_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// harnessTestdata resolves the pinned harness module's serve testdata directory from
// the module cache, so the assertion is against the exact version go.mod names.
func harnessTestdata(t *testing.T) string {
	t.Helper()
	cmd := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/looprig/harness")
	// This module lives outside the parent looprig/go.work workspace. Without
	// GOWORK=off, `go` auto-detects go.work by walking up from this directory and
	// resolves the harness module via the workspace's own checkout instead of this
	// module's go.mod replace directive -- silently wrong, not an error.
	cmd.Env = append(os.Environ(), "GOWORK=off")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("locate harness module: %v", err)
	}
	return filepath.Join(strings.TrimSpace(string(out)), "pkg", "serve", "testdata")
}

// TestContractMatchesPinnedHarness proves contract/ is a verbatim copy of the pinned
// harness version's wire artifacts. This is the drift guard: bumping harness without
// re-running `make contract` fails here, and a genuine wire change surfaces as a
// reviewable fixture diff rather than a silent protocol mismatch at runtime.
func TestContractMatchesPinnedHarness(t *testing.T) {
	t.Parallel()

	upstream := harnessTestdata(t)
	for _, dir := range []string{"schema", "fixtures"} {
		entries, err := os.ReadDir(filepath.Join(upstream, dir))
		if err != nil {
			t.Fatalf("read upstream %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			want, err := os.ReadFile(filepath.Join(upstream, dir, e.Name()))
			if err != nil {
				t.Fatalf("read upstream %s/%s: %v", dir, e.Name(), err)
			}
			got, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Errorf("missing vendored %s/%s (run `make contract`): %v", dir, e.Name(), err)
				continue
			}
			if !bytes.Equal(got, want) {
				t.Errorf("%s/%s differs from pinned harness (run `make contract`)", dir, e.Name())
			}
		}
	}
}
