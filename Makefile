################################################################
# Olympia: Makefile for building TypeScript packages
# https://github.com/cliffano/olympia
################################################################

# Olympia info
OLYMPIA_VERSION = 0.9.0-pre.0

UPDATE_GH_ID = cliffano
UPDATE_MAKEFILE = olympia
UPDATE_GENERATOR = node
UPDATE_DOTFILES = .github/. .gitignore eslint.config.js .rtk.json AGENTS.md
UPDATE_PARTIALS = AVATAR BADGES BUILD_REPORTS DEVELOPERS_GUIDE

################################################################
# User configuration variables
# https://github.com/cliffano/olympia#configuration
# Configuration variables should be stored in olympia.yml config file

# PACKAGE_NAME is the name of the node.js package
PACKAGE_NAME=$(shell yq .package_name olympia.yml)

# AUTHOR is the author of the node.js package
AUTHOR ?= $(shell yq .author olympia.yml)

$(info ################################################################)
$(info Building TypeScript package using Olympia with user configurations...)
$(info - Package name = ${PACKAGE_NAME})
$(info - Author = ${AUTHOR})

export PATH := node_modules/.bin:$(PATH)

################################################################
# TypeScript tool configuration

# Paths formatted by Prettier
STYLE_PATHS = lib test test-integration assets bin eslint.config.js

# Functions above this cyclomatic complexity are listed in the complexity report
COMPLEXITY_MAX ?= 10

################################################################
# Base targets

# CI target to be executed by CI/CD tool
all: ci
ci: clean build typecheck style lint test coverage complexity doc package reinstall test-integration

# Ensure stage directory exists
stage:
	mkdir -p stage

# Remove all temporary (staged, generated, cached) files
clean:
	rm -rf .bob/ coverage/ dist/ stage/

################################################################
# Build targets

# Compile TypeScript sources to dist/
build:
	tsc -p tsconfig.build.json

# Type-check sources and tests without emitting files
typecheck:
	tsc -p tsconfig.json --noEmit

################################################################
# Dependencies targets

# Retrieve the Node.js package dependencies
deps:
	$(call deps_extra)
	npm install

deps-extra-apt:
	apt-get update
	apt-get install -y markdownlint
	$(call run_hook,x-post-deps-extra-apt)

deps-upgrade:
	npm-check-updates --upgrade
	npm install

rmdeps:
	rm -rf node_modules/

################################################################
# Formatting targets

style:
	prettier --write $(STYLE_PATHS)
	$(call run_hook,x-post-style)

################################################################
# Testing targets

lint: stage
	eslint .
	mdl -r ~MD013,~MD029 $(shell find . -path ./stage -prune -o -path ./node_modules -prune -o -path ./.bob -prune -o -path ./test/fixtures -prune -o -name "CHANGELOG.md" -prune -o -name "*.md" -print)
	$(call run_hook,x-post-lint)

complexity: stage
	mkdir -p .bob/complexity/eslint/
	eslint lib --rule '{"complexity": ["warn", $(COMPLEXITY_MAX)]}' --format html --output-file .bob/complexity/eslint/index.html

test:
	mocha

test-integration:
	mocha --no-package --node-option import=tsx --extension ts --recursive --timeout 180000 --ignore 'test-integration/helpers/**' 'test-integration/**/*.ts'

test-examples:
	mkdir -p stage/test-examples/
	cd examples && \
	for f in *.sh; do \
	  bash -x "$$f"; \
	done

coverage:
	c8 --include=lib --reports-dir=.bob/coverage/c8 --reporter=text-summary --reporter=lcov --reporter=html mocha

################################################################
# Packaging, installation, and publishing targets

package:
	mkdir -p .bob/package/
	npm pack --pack-destination .bob/package/

install: package
	npm link .

uninstall:
	npm unlink .

reinstall: uninstall install

publish:
	npm publish

################################################################
# Documentation targets

doc: stage
	typedoc --entryPointStrategy expand --tsconfig tsconfig.build.json --out .bob/doc/typedoc lib

################################################################
# MAKE IT SO - Utility Makefile functions and targets
################################################################

define run_hook
	@if [ -f Makefile-extras ] && grep -q "^$(1):" Makefile-extras; then \
		$(MAKE) -f Makefile-extras $(1); \
	fi
endef

define deps_extra
	@if command -v apt-get > /dev/null 2>&1; then \
		if [ "$$(id -u)" = "0" ]; then \
			$(MAKE) deps-extra-apt; \
		else \
			sudo $(MAKE) deps-extra-apt; \
		fi; \
	fi
endef

define update_dotfiles_from_generator
	cd stage/ && \
	  rm -rf generator-$(1)/ && \
	  git clone https://github.com/$(UPDATE_GH_ID)/generator-$(1) && \
	  cd generator-$(1) && \
	  make deps && \
	  node_modules/.bin/plop $(UPDATE_GENERATOR_COMPONENT) -- \
	    --project_id "$(UPDATE_GENERATOR_INPUTS_PROJECT_ID)" \
		--project_name "$(UPDATE_GENERATOR_INPUTS_PROJECT_NAME)" \
		--project_desc "$(UPDATE_GENERATOR_INPUTS_PROJECT_DESC)" \
		--author_name "$(UPDATE_GENERATOR_INPUTS_AUTHOR_NAME)" \
		--author_email "$(UPDATE_GENERATOR_INPUTS_AUTHOR_EMAIL)" \
		--author_url "$(UPDATE_GENERATOR_INPUTS_AUTHOR_URL)" \
		--github_id "$(UPDATE_GENERATOR_INPUTS_GITHUB_ID)" \
		--github_repo "$(UPDATE_GENERATOR_INPUTS_GITHUB_REPO)" \
		--github_token_prefix "$(UPDATE_GENERATOR_INPUTS_GITHUB_TOKEN_PREFIX)"
	cd stage/generator-$(1)/stage/$(UPDATE_GENERATOR_COMPONENT) && \
	  for dotfile in $(2); do \
		cp -R "$$dotfile" ../../../../"$$dotfile"; \
	  done
endef

define update_partials_from_generator
	cd stage/ && \
	  rm -rf generator-$(1)/ && \
	  git clone https://github.com/$(UPDATE_GH_ID)/generator-$(1) && \
	  cd generator-$(1) && \
	  make deps && \
	  node_modules/.bin/plop $(UPDATE_GENERATOR_COMPONENT)-partials -- \
	    --project_id "$(UPDATE_GENERATOR_INPUTS_PROJECT_ID)" \
		--project_name "$(UPDATE_GENERATOR_INPUTS_PROJECT_NAME)" \
		--project_desc "$(UPDATE_GENERATOR_INPUTS_PROJECT_DESC)" \
		--author_name "$(UPDATE_GENERATOR_INPUTS_AUTHOR_NAME)" \
		--author_email "$(UPDATE_GENERATOR_INPUTS_AUTHOR_EMAIL)" \
		--author_url "$(UPDATE_GENERATOR_INPUTS_AUTHOR_URL)" \
		--github_id "$(UPDATE_GENERATOR_INPUTS_GITHUB_ID)" \
		--github_repo "$(UPDATE_GENERATOR_INPUTS_GITHUB_REPO)" \
		--github_token_prefix "$(UPDATE_GENERATOR_INPUTS_GITHUB_TOKEN_PREFIX)"
	for block in $(2); do \
	  partial_file=$$(printf "%s" "$$block" | tr "A-Z" "a-z"); \
	  ex -s \
	    -c "/<!-- BEGIN:$$block -->/+1,/<!-- END:$$block -->/-1d" \
	    -c "/<!-- BEGIN:$$block -->/r stage/generator-$(1)/stage/$(UPDATE_GENERATOR_COMPONENT)-partials/$$partial_file.txt" \
	    -c 'wq' \
	    README.md; \
	done
endef

define set_generator_vars
$(1): UPDATE_GENERATOR_COMPONENT = $$(shell yq .generator.component $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_PROJECT_ID = $$(shell yq .generator.inputs.project_id $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_PROJECT_NAME = $$(shell yq .generator.inputs.project_name $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_PROJECT_DESC = $$(shell yq .generator.inputs.project_desc $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_AUTHOR_NAME = $$(shell yq .generator.inputs.author_name $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_AUTHOR_EMAIL = $$(shell yq .generator.inputs.author_email $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_AUTHOR_URL = $$(shell yq .generator.inputs.author_url $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_GITHUB_ID = $$(shell yq .generator.inputs.github_id $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_GITHUB_REPO = $$(shell yq .generator.inputs.github_repo $(2).yml)
$(1): UPDATE_GENERATOR_INPUTS_GITHUB_TOKEN_PREFIX = $$(shell yq .generator.inputs.github_token_prefix $(2).yml)
endef

# Update Makefile to the latest version tag
update-to-latest: UPDATE_TARGET_VERSION = $(shell curl -s https://api.github.com/repos/$(UPDATE_GH_ID)/$(UPDATE_MAKEFILE)/tags | jq -r '.[0].name')
update-to-latest: update-to-version

# Update Makefile to the main branch
update-to-main:
	curl https://raw.githubusercontent.com/$(UPDATE_GH_ID)/$(UPDATE_MAKEFILE)/main/src/Makefile-$(UPDATE_MAKEFILE) -o Makefile

# Update Makefile to the version defined in UPDATE_TARGET_VERSION parameter
update-to-version:
	curl https://raw.githubusercontent.com/$(UPDATE_GH_ID)/$(UPDATE_MAKEFILE)/$(UPDATE_TARGET_VERSION)/src/Makefile-$(UPDATE_MAKEFILE) -o Makefile

# Update dotfiles using the generator
$(eval $(call set_generator_vars,update-dotfiles,$(UPDATE_MAKEFILE)))
update-dotfiles: stage
	$(call update_dotfiles_from_generator,$(UPDATE_GENERATOR),$(UPDATE_DOTFILES))
	$(call run_hook,x-post-update-dotfiles)

# Update partial snippets using the generator
$(eval $(call set_generator_vars,update-partials,$(UPDATE_MAKEFILE)))
update-partials: stage
	$(call update_partials_from_generator,$(UPDATE_GENERATOR),$(UPDATE_PARTIALS))

release-major:
	rtk release --release-increment-type major

release-minor:
	rtk release --release-increment-type minor

release-patch:
	rtk release --release-increment-type patch

################################################################

.PHONY: $(1) all ci stage clean build typecheck deps deps-extra-apt deps-upgrade rmdeps style lint complexity test test-integration test-examples coverage package install uninstall reinstall publish doc update-to-latest update-to-main update-to-version update-dotfiles update-partials release-major release-minor release-patch