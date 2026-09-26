.PHONY: contract contract-check

CORE_VERSION := v0.12.0
CORE_DIR = $(shell cd contract && GOWORK=off GOTOOLCHAIN=go1.26.8 go list -m -f '{{.Dir}}' github.com/looprig/core)

contract:
	rm -rf contract/schema contract/fixtures
	mkdir -p contract/schema contract/fixtures
	cp -R $(CORE_DIR)/sessionwire/v1/schema/. contract/schema/
	cp -R $(CORE_DIR)/sessionwire/v1/testdata/fixtures/. contract/fixtures/
	chmod -R u+w contract/schema contract/fixtures
	@echo "$(CORE_VERSION)" > contract/VERSION

contract-check:
	npm run contract:check
