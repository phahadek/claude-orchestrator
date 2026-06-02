import os

# Passed in via -D flags from build.sh
application = defines.get("app", "build/Claude Orchestrator.app")
appname = os.path.basename(application)

# DMG format: ULFO = lzfse-compressed (macOS 10.11+, best compression)
format = defines.get("format", "ULFO")
size = None

files = [application]
symlinks = {"Applications": "/Applications"}

icon_locations = {
    appname: (140, 160),
    "Applications": (380, 160),
}

background = "builtin-arrow"
window_rect = ((100, 100), (540, 380))
icon_size = 80
text_size = 12
