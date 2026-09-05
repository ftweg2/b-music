// Existing metadata/service regressions exercise the explicit legacy-local mode.
// Account-specific tests opt in (and independently verify the production default).
process.env.APP_LIBRARY_MODE = "local";
