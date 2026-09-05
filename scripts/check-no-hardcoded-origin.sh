#!/usr/bin/env bash
# Guards the domain-portability rule: the deployment's own hostnames must not
# appear anywhere except configuration and documentation.
#
# The domain is deployment configuration, not architecture. Discipline alone
# does not survive months of commits; this check does. Run it in CI.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# The hostname pkviewer itself is served from. That is the one that must stay
# configuration: moving pkviewer to another domain has to be an env change, not
# a rebuild, and an absolute pkviewer URL must never reach the database.
#
# `doughmination.gay` was here while the beta ran on it. It is deliberately NOT
# here now. It is no longer a pkviewer origin -- it is the owner's other sites
# (docs, CDN), which pkviewer links to the same way it links to a repository.
# Linking to a fixed external site is not the thing this rule guards against.
#
# Matched fully qualified, so the bare word stays usable as ordinary data: it is
# a perfectly good SLUG, and slugs are user content, not configuration. The rule
# being enforced is "no deployment hostname in the code", not "never write these
# letters".
PATTERN='pkviewer\.xyz'

# Config and docs are where a deployment origin legitimately appears.
ALLOWED='^(\./)?(\.env(\.example)?|scripts/check-no-hardcoded-origin\.sh|docs/|README\.md)'

files=""
if command -v git >/dev/null 2>&1 && [ -n "$(git ls-files 2>/dev/null)" ]; then
  files="$(git ls-files)"
else
  # Nothing tracked yet: scan the working tree so the check is useful before the
  # first commit.
  files="$(find . -type f \
    ! -path './node_modules/*' ! -path './*/node_modules/*' \
    ! -path './.git/*' ! -path './data/*' ! -path './.next/*' \
    ! -name '*.db' ! -name '*.db-shm' ! -name '*.db-wal' \
    | sed 's|^\./||')"
fi

violations=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue
  if printf '%s' "$file" | grep -qE "$ALLOWED"; then continue; fi
  if grep -qIE "$PATTERN" "$file" 2>/dev/null; then
    violations="${violations}  ${file}
"
  fi
done <<EOF
$files
EOF

if [ -n "$violations" ]; then
  echo "FAIL: a deployment hostname is hardcoded outside config and docs:" >&2
  printf '%s' "$violations" >&2
  echo "pkviewer's own origin belongs in .env, read through apps/api/src/config." >&2
  exit 1
fi

echo "check-no-hardcoded-origin: ok"
