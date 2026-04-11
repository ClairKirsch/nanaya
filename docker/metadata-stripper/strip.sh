#!/bin/bash
# Reads a DOCX from stdin, strips metadata, writes cleaned DOCX to stdout.
#
# Pipeline:
#   1. LibreOffice (headless) re-exports the file, collapsing tracked changes
#      and internal revision/version history stored in the OXF XML.
#   2. mat2 removes any remaining embedded metadata (author, title, comments,
#      custom properties, RSID tables, etc.).
set -euo pipefail

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

INPUT_DIR="$WORKDIR/in"
OUTPUT_DIR="$WORKDIR/out"
LO_HOME="$WORKDIR/lo-home"
mkdir -p "$INPUT_DIR" "$OUTPUT_DIR" "$LO_HOME"

# Receive the DOCX from stdin
cat > "$INPUT_DIR/document.docx"

# --- Step 1: LibreOffice re-export ---
# Passing through LibreOffice's OOXML writer collapses revision history,
# strips embedded version snapshots, and flattens tracked-change markup.
export HOME="$LO_HOME"
libreoffice \
    --headless \
    --norestore \
    --convert-to docx \
    --outdir "$OUTPUT_DIR" \
    "$INPUT_DIR/document.docx" \
    > /dev/null 2>&1

# --- Step 2: mat2 metadata removal ---
# mat2 removes author/title/subject/keywords, custom XML properties,
# RSID tables, and other embedded metadata; it writes <name>.cleaned.docx.
mat2 "$OUTPUT_DIR/document.docx" > /dev/null 2>&1

# Send the cleaned file to stdout
cat "$OUTPUT_DIR/document.cleaned.docx"
