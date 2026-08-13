.PHONY: check check-full book clean package

check:
	python3 tools/validate_repo.py

check-full: check
	npm run validate

book:
	mdbook build

clean:
	rm -rf book dist

package: check-full
	python3 tools/package_repo.py
