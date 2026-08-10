GO_DIRS := $(shell go list -f '{{.Dir}}' ./...)

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
