# WTM — Worktree Runtime Manager
#
# Every routine action has a target here; `make` on its own lists them.
# The targets are thin wrappers: each one names the underlying command it runs,
# so nothing here hides behaviour that `bun run` does not already provide.

BUN ?= bun
# A user-owned prefix keeps installation free of sudo; override for a shared one.
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
BINARY := dist/sea/wtm
INSTALLED := $(BINDIR)/wtm
# Where `wtm` keeps a user's data, resolved the same way the product resolves it. This was a
# single macOS path, so on Linux `make purge` announced it had removed a directory that had never
# existed and left the real state and configuration in place -- a cleanup command that reports
# success and cleans nothing is worse than one that is missing.
#
# macOS keeps the config file inside the data root but the logs outside it; Linux keeps the logs
# inside the data root but the config outside it. So neither platform is one directory, and the
# macOS half was quietly leaving ~/Library/Logs/WTM behind before Linux existed at all.
#
# The two roots are separate variables rather than one whitespace-separated list, because
# `Application Support` contains a space: any make construct that iterates a list splits it into
# `.../Library/Application` and `Support/WTM`, and this recipe passes what it iterates to `rm -rf`.
# Quoting happens in the shell, where the expansion is one word.
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
STATE_ROOT := $(HOME)/Library/Application Support/WTM
CONFIG_ROOT := $(HOME)/Library/Logs/WTM
else
STATE_ROOT := $(if $(XDG_STATE_HOME),$(XDG_STATE_HOME),$(HOME)/.local/state)/wtm
CONFIG_ROOT := $(if $(XDG_CONFIG_HOME),$(XDG_CONFIG_HOME),$(HOME)/.config)/wtm
endif
# Installing registers the user service, so supervised tasks work straight away.
# Set WITH_DAEMON=0 for an install that touches nothing outside the prefix.
WITH_DAEMON ?= 1

.DEFAULT_GOAL := help
.PHONY: help setup build binary install uninstall reinstall purge where \
	lint typecheck test e2e perf check package smoke verify \
	dist gate formula daemon-install daemon-status daemon-uninstall \
	clean distclean

help:
	@printf 'WTM — Worktree Runtime Manager\n'
	@awk 'BEGIN {FS = ":.*##"} \
	  /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} \
	  /^[a-zA-Z0-9_-]+:.*##/ {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '\nInstall prefix: %s\n' '$(BINDIR)'
	@printf 'Override it with e.g. `sudo make install PREFIX=/usr/local`.\n'

##@ Build

setup: ## Install dependencies exactly as the lockfile pins them
	$(BUN) install --frozen-lockfile

build: ## Bundle the TypeScript packages into dist/
	$(BUN) run build

binary: ## Build the standalone executable at dist/sea/wtm
	$(BUN) run build:binary

##@ Install

install: binary ## Build and install the executable, and register the daemon
	@mkdir -p '$(BINDIR)'
	install -m 0755 '$(BINARY)' '$(INSTALLED)'
	@[ '$(WITH_DAEMON)' = '0' ] || '$(INSTALLED)' daemon install
	@printf 'installed %s (' '$(INSTALLED)'
	@'$(INSTALLED)' --version | head -1 | tr -d '\n'
	@printf ')\n'
	@command -v wtm >/dev/null 2>&1 || printf 'note: %s is not on your PATH yet.\n' '$(BINDIR)'
	@[ '$(WITH_DAEMON)' = '0' ] || '$(INSTALLED)' daemon status

uninstall: ## Unregister the daemon and remove the installed executable
	@[ ! -x '$(INSTALLED)' ] || '$(INSTALLED)' daemon uninstall
	rm -f '$(INSTALLED)'

reinstall: uninstall install ## Remove, rebuild, and install again

purge: uninstall ## Uninstall, then delete this user's WTM state, logs, and configuration
	@for directory in '$(STATE_ROOT)' '$(CONFIG_ROOT)'; do printf 'removing %s\n' "$$directory"; rm -rf "$$directory"; done

where: ## Report which wtm PATH resolves to, its version, and the daemon
	@command -v wtm && wtm --version | head -1 || printf 'wtm is not on PATH\n'
	@command -v wtm >/dev/null 2>&1 && wtm daemon status || true

##@ Checks

lint: ## Enforce the repository's import and test-layout rules
	$(BUN) run lint

typecheck: ## Typecheck every package
	$(BUN) run typecheck

test: ## Run the unit and integration suites serially
	$(BUN) run test --timeout 30000

e2e: ## Run the end-to-end workflow suite
	$(BUN) run test:e2e

perf: ## Run the performance suites and print the report
	$(BUN) run test:perf

package: ## Prove the npm tarball carries only what it should
	$(BUN) run package:verify

smoke: ## Build the executable and exercise it with no runtime on PATH
	$(BUN) run binary:verify

check: lint typecheck test ## Fast gate: lint, typecheck, and the unit suites

verify: ## Full release gate — every check, the bundles, and the artifacts
	$(BUN) run release:verify

##@ Release

dist: binary ## Produce the release archive and SHA256SUMS under dist/release
	$(BUN) run release:artifacts

gate: ## Check a tag and its artifacts before publishing (make gate REF=refs/tags/v1.2.3)
	$(BUN) run release:gate $(REF)

formula: ## Render the Homebrew formula from the real checksums
	$(BUN) run formula:render

##@ Daemon

daemon-install: ## Register the WTM user service (launchd or systemd) for the current user
	wtm daemon install

daemon-status: ## Report whether the daemon is registered and reachable
	wtm daemon status

daemon-uninstall: ## Remove the WTM user service (launchd or systemd)
	wtm daemon uninstall

##@ Housekeeping

clean: ## Remove build output and rendered artifacts
	rm -rf dist artifacts

distclean: clean ## Also remove installed dependencies
	rm -rf node_modules
