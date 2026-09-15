#!/bin/sh
# EMAIL-CONVENTION section 7. The letterhead is a byte-identical local copy in
# every CIMS repo, never a cross-repo import. Fifteen competing letterheads
# happened because nothing proved the copies had not drifted. This does.
#
# Run it in every repo; all must print the same SHA1.
set -e
f="$(dirname "$0")/../src/cims-mast.js"
printf 'blob %s\0' "$(stat -c%s "$f")" | cat - "$f" | sha1sum
