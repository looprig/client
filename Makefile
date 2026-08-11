# This module lives outside the parent looprig/go.work workspace. Without GOWORK=off,
# `go` auto-detects go.work by walking up from this directory and resolves modules
# (e.g. github.com/looprig/harness) via the workspace's own checkout instead of this
# module's go.mod replace directive -- silently wrong, not an error. `export` here
# correctly propagates GOWORK=off into recipe shells (e.g. `test`, `vet`), but GNU
# Make does NOT apply it to `$(shell ...)` calls used in immediate (`:=`) variable
# assignments evaluated at parse time -- those need GOWORK=off prefixed directly.
export GOWORK := off

HARNESS_VERSION := v0.24.2
HARNESS_DIR := $(shell GOWORK=off go list -m -f '{{.Dir}}' github.com/looprig/harness)

GO_DIRS := $(shell GOWORK=off go list -f '{{.Dir}}' ./...)

.PHONY: test fmt fmt-check lint vet staticcheck gosec vuln secure contract sdk app build

test:
	go test -race ./...

fmt:
	gofmt -w $(GO_DIRS)

fmt-check:
	@unformatted=$$(gofmt -l $(GO_DIRS)); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed (run 'make fmt'):"; echo "$$unformatted"; exit 1; \
	fi

vet:
	go vet ./...

staticcheck:
	go run honnef.co/go/tools/cmd/staticcheck@latest ./...

gosec:
	go run github.com/securego/gosec/v2/cmd/gosec@latest -quiet ./...

lint: fmt-check vet staticcheck gosec

vuln:
	go mod verify
	go run golang.org/x/vuln/cmd/govulncheck@latest ./...

secure: lint vuln

build:
	CGO_ENABLED=0 go build -trimpath ./cmd/...

contract:
	rm -rf contract/schema contract/fixtures
	mkdir -p contract/schema contract/fixtures
	cp $(HARNESS_DIR)/pkg/serve/testdata/schema/*.json contract/schema/
	cp $(HARNESS_DIR)/pkg/serve/testdata/fixtures/* contract/fixtures/
	@echo "$(HARNESS_VERSION)" > contract/VERSION

sdk:
	npm ci && npm run build -w sdk/core && npm run test -w sdk/core

app:
	npm ci && npm run build -w app
