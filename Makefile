.PHONY: help install build check targets show-dr-repo show-letta-workspace show-dr-repo-instructions show-letta-workspace-instructions validate-dr-repo validate-letta-workspace print-dr-repo-launch debug-dr-repo-sandbox doom-loop-dr-repo show-aicoder-opencode show-aicoder-opencode-instructions validate-aicoder-opencode self-check openportal-start openportal-stop openportal-status openportal-list openportal-clean opencode-db-maintenance-start opencode-db-maintenance-status opencode-db-checkpoint-now opencode-db-backup-now opencode-db-vacuum

# Prefer bun when installed, fall back to npm/npx.
RUNNER := $(shell command -v bun >/dev/null 2>&1 && echo "bun" || echo "npm")
NPX_CMD := $(shell command -v bunx >/dev/null 2>&1 && echo "bunx" || echo "npx")

help:
	@echo "aicoder-opencode"
	@echo "  make install               - Install TypeScript dependencies"
	@echo "  make build                 - Build the TypeScript control plane"
	@echo "  make check                 - Typecheck/build the control plane"
	@echo "  make targets               - List configured targets"
	@echo "  make show-dr-repo          - Show dr-repo target config"
	@echo "  make show-letta-workspace  - Show letta-workspace target config"
	@echo "  make show-dr-repo-instructions         - Show dr-repo target instructions"
	@echo "  make show-letta-workspace-instructions - Show letta-workspace target instructions"
	@echo "  make validate-dr-repo                  - Validate dr-repo target paths"
	@echo "  make validate-letta-workspace          - Validate letta-workspace target paths"
	@echo "  make print-dr-repo-launch              - Print the sandboxed dr-repo product launcher"
	@echo "  make debug-dr-repo-sandbox             - Verify hidden maintenance paths in dr-repo sandbox"
	@echo "  make doom-loop-dr-repo                 - Check whether dr-repo has stalled without durable state change"
	@echo "  make show-aicoder-opencode              - Show aicoder-opencode target config"
	@echo "  make show-aicoder-opencode-instructions - Show aicoder-opencode instruction doc"
	@echo "  make validate-aicoder-opencode          - Validate aicoder-opencode target paths"
	@echo "  make self-check                         - Run build + tests on the control plane"
	@echo "  make openportal-start                  - Start the control-plane OpenPortal instance"
	@echo "  make openportal-stop                   - Stop the control-plane OpenPortal instance"
	@echo "  make openportal-status                 - Show control-plane OpenPortal instance status"
	@echo "  make openportal-list                   - List OpenPortal instances"
	@echo "  make openportal-clean                  - Clean stale OpenPortal entries"
	@echo "  make opencode-db-maintenance-start     - Enable OpenCode SQLite checkpoint/backup timers"
	@echo "  make opencode-db-maintenance-status    - Show OpenCode SQLite maintenance timers"
	@echo "  make opencode-db-checkpoint-now        - Run one OpenCode SQLite checkpoint pass now"
	@echo "  make opencode-db-backup-now            - Run one OpenCode SQLite backup pass now"
	@echo "  make opencode-db-vacuum                - Run manual OpenCode SQLite VACUUM"

install:
	$(RUNNER) install

build:
	$(RUNNER) run build

check:
	$(RUNNER) run check

targets:
	@$(NPX_CMD) tsx src/cli.ts list-targets

show-dr-repo:
	@$(NPX_CMD) tsx src/cli.ts show-target dr-repo

show-letta-workspace:
	@$(NPX_CMD) tsx src/cli.ts show-target letta-workspace

show-dr-repo-instructions:
	@$(NPX_CMD) tsx src/cli.ts show-target-instructions dr-repo

show-letta-workspace-instructions:
	@$(NPX_CMD) tsx src/cli.ts show-target-instructions letta-workspace

validate-dr-repo:
	@$(NPX_CMD) tsx src/cli.ts validate-target dr-repo

validate-letta-workspace:
	@$(NPX_CMD) tsx src/cli.ts validate-target letta-workspace

print-dr-repo-launch:
	@$(NPX_CMD) tsx src/cli.ts print-product-launch dr-repo -- --help

debug-dr-repo-sandbox:
	@$(NPX_CMD) tsx src/cli.ts debug-product-sandbox dr-repo -- /usr/bin/env bash -lc 'pwd; for path_name in .opencode .agents .maintenance; do echo ===$${path_name}===; find "$${path_name}" -mindepth 1 -maxdepth 2 | head -20; done'

doom-loop-dr-repo:
	@$(NPX_CMD) tsx src/cli.ts check-doom-loop dr-repo

show-aicoder-opencode:
	@$(NPX_CMD) tsx src/cli.ts show-target aicoder-opencode

show-aicoder-opencode-instructions:
	@$(NPX_CMD) tsx src/cli.ts show-target-instructions aicoder-opencode

validate-aicoder-opencode:
	@$(NPX_CMD) tsx src/cli.ts validate-target aicoder-opencode

self-check:
	@$(RUNNER) run check

openportal-start:
	@AICODER_OPENPORTAL_PORT=3091 AICODER_OPENPORTAL_OPENCODE_PORT=4091 ./bin/aicoder-opencode-openportal-service start

openportal-stop:
	@./bin/aicoder-opencode-openportal-service stop

openportal-status:
	@./bin/aicoder-opencode-openportal-service status

openportal-list:
	@./bin/aicoder-opencode-openportal list

openportal-clean:
	@./bin/aicoder-opencode-openportal clean

opencode-db-maintenance-start:
	@./bin/aicoder-opencode-opencode-database-maintenance-service start

opencode-db-maintenance-status:
	@./bin/aicoder-opencode-opencode-database-maintenance-service status

opencode-db-checkpoint-now:
	@./bin/aicoder-opencode-opencode-database-maintenance-service checkpoint-now

opencode-db-backup-now:
	@./bin/aicoder-opencode-opencode-database-maintenance-service backup-now

opencode-db-vacuum:
	@./bin/aicoder-opencode opencode-database-maintenance vacuum
