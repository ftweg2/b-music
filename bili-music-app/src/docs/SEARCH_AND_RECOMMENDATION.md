# Search and the local music library

Search is explicitly user-triggered. There is no custom music scoring or recommendation engine.

## Online search

- Make one bounded provider request for the requested page. Do not run additional searches for followed creators.
- Deduplicate by BV ID and skip malformed records individually. Stably place followed UP creators first within the returned page; preserve upstream order inside both groups.
- Store only normalized metadata. A sparse response must not erase known artwork, duration, tags or creator information.
- Use provider pagination metadata when supplied, otherwise a full page is only an indication that another page may exist.
- Return the effective page size. Public and kernel searches currently support up to 20 items; pages are capped at 10.
- An empty successful online page remains empty. Provider failure returns an explicit error (502/429), never a local substitute. The UI preserves the last successful page and offers retry or an explicit new local search.
- A new automatic search uses the authenticated kernel when logged in; otherwise it chooses the public provider. Successful results bind the actual provider, page size and login-session fingerprint for all subsequent pages.
- A login change invalidates authenticated pagination; restart from page 1. The fingerprint is cache context, not an authorization token.

## Local search

All whitespace-separated terms must match title, description, creator name, tags or BV ID. SQL wildcard characters entered by users are escaped. Order is followed creators first (scoped to the current owner), then `last_seen_at DESC, id DESC`; a sentinel row determines whether another page exists. Local-only searches never initialize a kernel profile or create a missing direct-link record.

## Direct links

An explicitly entered BV ID or Bilibili video link opens the exact local record, or creates minimal video metadata when online search is enabled. It does not trigger audio preparation or a generic keyword search.

## Saving

Favorites use stable BV IDs and metadata snapshots; they survive candidate-cache deletion. Repeated favorite actions preserve notes and mood unless explicitly supplied. Following is a creator bookmark and a boolean search priority, never a numeric weight. Listing followed creators is local-only and does not fetch profiles in the background.

The former score fields and ranking modules are removed from the runtime model and public responses. Existing databases may retain unused legacy columns for nondestructive compatibility; new databases do not create them.
