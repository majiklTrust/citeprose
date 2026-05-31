#!/bin/bash

function linkdir {(
if [ -z "$dst" ] || [ -z "$src" ];then echo set dst and src to absolute paths before running && exit 1;fi
# links all files in top-level dir
find "$src" -maxdepth 1 -type f -exec ln {} "$dst"/ 2>/dev/null \;

# links all files in subdirs, skips dot‑dirs, and reports actions
find "$src" -mindepth 1 -type f -print0 |
while IFS= read -r -d '' file; do
    rel="${file#$src/}"
    subdir="$(dirname "$rel")"

    # Skip any directory whose basename starts with '.'
    case "$subdir" in
        */.*|.*)
            # echo "Skipping dot-directory: $subdir"
            continue
            ;;
    esac

    # Create destination directory if needed
    if [ ! -d "$dst/$subdir" ]; then
        echo creating subdir $subdir
        mkdir -p "$dst/$subdir"
        
    fi

    # Skip if file already exists
    if [ -e "$dst/$rel" ]; then
        # echo file exists, skipping $(basename $rel)
        continue
    fi

    # Link file
    echo "Linking: $rel"
    ln "$file" "$dst/$rel"
    if [ -r "$dst/$rel" ];then echo linked $rel;else echo no link found $dst/$rel;fi
done
)} # END OF LINKDIR

(
src=$1
dst=$2
linkdir $src $dst
)