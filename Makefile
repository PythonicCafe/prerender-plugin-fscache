DOCKER_RUN := docker run -it --rm -v $$(pwd):/app node:14-alpine

clean:					## Clear build files
	rm -rf prerender-plugin-fscache-*.tgz

help:					## List all make commands
	@awk 'BEGIN {FS = ":.*##"; printf "\n  Please use `make <target>` where <target> is one of:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo ' '

pack:					## Clean and pack
	$(DOCKER_RUN) /bin/sh -c "cd /app && npm pack"

release: clean pack		## Clean and release
	$(DOCKER_RUN) /bin/sh -c "cd /app && npm login && npm publish"

shell: 					## Get access to container's /bin/sh
	$(DOCKER_RUN) /bin/sh

test-release: clean pack	## Pack and test-release
	$(DOCKER_RUN) /bin/sh -c "cd /app && npm login && npm publish --dry-run"

.PHONY: clean help pack release shell
