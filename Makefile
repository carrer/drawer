# Drawer — see PLAN.md for what each phase delivers.
SHELL := /bin/bash
# PROD=1 layers docker-compose.prod.yml on top: API + Caddy + a tailscale sidecar,
# no host ports. Operator commands then run inside the api container, since the
# database is no longer reachable from the host.
ifdef PROD
COMPOSE := docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.prod.yml
CLI := $(COMPOSE) exec -T api node src/cli.ts
MIGRATE := $(COMPOSE) run --rm --build --no-deps api node src/cli.ts migrate
else
COMPOSE := docker compose --env-file infra/.env -f infra/docker-compose.yml
CLI := npm run --silent cli --workspace @drawer/api --
MIGRATE := $(CLI) migrate
endif
LAN_IP := $(shell ip route get 1.1.1.1 2>/dev/null | awk '{print $$7; exit}')

# Native Android builds. React Native's Gradle toolchain wants JDK 17 — a newer
# system default (e.g. 25) breaks it — and Gradle won't guess the SDK location.
# Either can be overridden from the environment.
ANDROID_HOME ?= $(HOME)/Android/Sdk
JAVA_HOME ?= $(firstword $(wildcard /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/temurin-17-*))
ANDROID_ENV := ANDROID_HOME=$(ANDROID_HOME) JAVA_HOME=$(JAVA_HOME) PATH=$(JAVA_HOME)/bin:$(ANDROID_HOME)/platform-tools:$$PATH

.PHONY: help install up down logs ps reset db migrate enroll-code devices revoke api mobile prebuild android typecheck test test-integration check lan-ip

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## npm install across the workspace
	npm install

up: infra/.env ## Start postgres + garage (S3), apply migrations (PROD=1: the whole stack)
	$(COMPOSE) up -d --wait postgres garage
	@./scripts/garage-init.sh
	@$(MAKE) --no-print-directory migrate
ifdef PROD
	$(COMPOSE) up -d --build --wait
endif

down: ## Stop services (volumes kept)
	$(COMPOSE) down

logs: ## Tail service logs
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps

reset: ## DESTROY all local data and re-apply migrations from scratch
	@read -p "This deletes the local postgres AND garage volumes. Type 'yes': " c; [ "$$c" = yes ]
	$(COMPOSE) down -v
	$(MAKE) up

db: ## psql shell
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-drawer} -d $${POSTGRES_DB:-drawer}

migrate: ## Apply pending migrations (infra/db/migrations)
	@$(MIGRATE)

enroll-code: ## Mint a one-shot code to enroll a device (TTL=minutes, default 15)
	@$(CLI) enroll-code --ttl $(or $(TTL),15)

devices: ## List enrolled devices
	@$(CLI) devices

revoke: ## Revoke a device token: make revoke ID=<device-id>
	@$(CLI) revoke $(ID)

api: ## Run the API with reload
	npm run dev --workspace @drawer/api

mobile: ## Start Metro for the dev build (reachable from the phone over LAN)
	@[ -n "$(LAN_IP)" ] || { echo "no LAN IP detected — a phone cannot reach Metro on localhost" >&2; exit 1; }
	REACT_NATIVE_PACKAGER_HOSTNAME=$(LAN_IP) npm run start --workspace @drawer/mobile

prebuild: ## Generate native projects (required after changing app.json plugins)
	npm run prebuild --workspace @drawer/mobile

android: ## Build + install the dev client on a connected device (USB debugging on)
	@[ -d "$(ANDROID_HOME)" ] || { echo "Android SDK not found at $(ANDROID_HOME) — set ANDROID_HOME" >&2; exit 1; }
	@[ -x "$(JAVA_HOME)/bin/java" ] || { echo "JDK 17 not found — install openjdk-17-jdk or set JAVA_HOME" >&2; exit 1; }
	$(ANDROID_ENV) npm run android --workspace @drawer/mobile

typecheck: ## Typecheck every workspace
	npm run typecheck

test: ## Run unit tests
	npm test

test-integration: ## API integration tests against the running stack (make up first)
	npm run test:integration --workspace @drawer/api

check: ## Phase 0 gate — verify the whole local stack end to end
	@./scripts/phase0-check.sh

lan-ip: ## Print the LAN IP to put in S3_PUBLIC_ENDPOINT
	@echo $(LAN_IP)

infra/.env:
	@echo "infra/.env is missing — copy infra/.env.example and fill it in:" >&2
	@echo "    cp infra/.env.example infra/.env" >&2
	@exit 1
