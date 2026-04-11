FROM debian:bookworm-slim

# libreoffice-writer  — headless DOCX re-export (collapses revision history)
# mat2               — metadata anonymisation toolkit
# Both are available in Debian bookworm main; no extra repos needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer \
        mat2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY strip.sh .
RUN chmod +x strip.sh

# The container reads a raw DOCX from stdin and writes a cleaned DOCX to stdout.
#   podman run --rm -i --runtime=runsc metadata-stripper < input.docx > output.docx
ENTRYPOINT ["/app/strip.sh"]
