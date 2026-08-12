## Summary

Describe the problem and the resulting behavior.

## Verification

- [ ] App tests pass (`npm test`)
- [ ] App typecheck passes (`npm run typecheck`)
- [ ] App build passes (`npm run build`)
- [ ] Kernel tests pass (`python -m pytest app/tests`)
- [ ] Compose configuration validates

## Security boundary

- [ ] No cookies, credentials, storage state, signed URLs, profile data, databases, logs, or media are included.
- [ ] App/kernel separation and authorized-use boundaries remain intact.
- [ ] API, environment, and operational documentation is updated when applicable.
