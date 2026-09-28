# Drawer — see PLAN.md for what each phase delivers.
SHELL := /bin/bash
COMPOSE := docker compose --env-file infra/.env -f infra/docker-compose.yml
LAN_IP := $(shell ip route get 1.1.1.1 2>/dev/null | awk '{print $$7; exit}')

.PHONY: help install up down logs ps reset db api mobile prebuild android typecheck test check lan-ip

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## npm install across the workspace
	npm install

up: infra/.env ## Start postgres + garage (S3)
	$(COMPOSE) up -d --wait postgres garage
	@./scripts/garage-init.sh

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

api: ## Run the API with reload
	npm run dev --workspace @drawer/api

mobile: ## Start Metro for the dev build (reachable from the phone over LAN)
	@[ -n "$(LAN_IP)" ] || { echo "no LAN IP detected — a phone cannot reach Metro on localhost" >&2; exit 1; }
	REACT_NATIVE_PACKAGER_HOSTNAME=$(LAN_IP) npm run start --workspace @drawer/mobile

prebuild: ## Generate native projects (required after changing app.json plugins)
	npm run prebuild --workspace @drawer/mobile

android: ## Build + install the dev client on a connected device
	npm run android --workspace @drawer/mobile

typecheck: ## Typecheck every workspace
	npm run typecheck

test: ## Run unit tests
	npm test

check: ## Phase 0 gate — verify the whole local stack end to end
	@./scripts/phase0-check.sh

lan-ip: ## Print the LAN IP to put in S3_PUBLIC_ENDPOINT
	@echo $(LAN_IP)

infra/.env:
	@echo "infra/.env is missing — copy infra/.env.example and fill it in:" >&2
	@echo "    cp infra/.env.example infra/.env" >&2
	@exit 1
