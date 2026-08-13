# Maintainers and governance

## Maintainers

- [@ftweg2](https://github.com/ftweg2) — project lead and release maintainer.

## Decision process

B-Music currently uses a lightweight maintainer model. Routine fixes and documentation changes are decided through pull-request review. Changes to trust boundaries, stored data, HTTP contracts, extraction strategy behavior, or project scope should begin with an issue and require approval from the project lead.

Security and authorization boundaries take precedence over convenience or feature breadth. The project will not accept CAPTCHA, DRM/EME, membership, region, anti-bot, credential, or access-control bypass features.

## Releases

The project follows Semantic Versioning. A release requires passing App, kernel, container-configuration, and security checks; an annotated `vMAJOR.MINOR.PATCH` tag; an updated changelog; and generated release checksums. Security fixes are supported on the latest release only.

As the maintainer group grows, this file should be updated with review ownership, succession, and conflict-resolution rules.
