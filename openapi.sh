#!/usr/bin/env bash
#
# Regenerate the Swagger UI page from openapi.yaml.
#
# Two paths. The container builds the whole page and is the reference; the
# local path updates only the embedded spec in the page that is already there.
#
# The fallback exists because yousan/swagger-yaml-to-html publishes an amd64
# image only, so on an arm64 host the container starts, fails to exec, and
# leaves an empty index.html behind — a silent, committed regression in the
# published documentation. Failing over is better than a truncated page, and
# refusing to run at all would leave arm64 developers unable to update the docs
# their route changes require.
set -euo pipefail

TARGET=app/templates/pages/index.html

regenerate_spec_locally() {
  echo "openapi.sh: container path unavailable; updating the embedded spec in place" >&2
  python3 - "$TARGET" <<'SPECEOF'
import json
import re
import sys

import yaml

target = sys.argv[1]
page = open(target).read()
spec = yaml.safe_load(open("openapi.yaml"))

# Matches the assignment the container emits. Byte-for-byte the same
# serialisation, so switching paths does not produce a spurious diff.
pattern = re.compile(r"(\n  var spec = )(\{.*\})(;\n)", re.S)
if not pattern.search(page):
    sys.exit(
        "openapi.sh: no embedded spec found in the page, so there is nothing "
        "to update in place; run the container path to build it from scratch"
    )

serialised = json.dumps(spec, ensure_ascii=False)
# A plain lambda rather than a replacement string: the spec contains backslash
# escapes, which re.sub would interpret as group references and corrupt.
open(target, "w").write(
    pattern.sub(lambda m: m.group(1) + serialised + m.group(3), page, count=1)
)
print(f"openapi.sh: updated {len(spec['paths'])} paths in {target}")
SPECEOF
}

if docker run --rm -i yousan/swagger-yaml-to-html < openapi.yaml > "$TARGET" 2>/dev/null && [ -s "$TARGET" ]; then
  BUILT_FROM_CONTAINER=1
else
  # The failed run truncates the file, so restore it before patching in place.
  git checkout -- "$TARGET" 2>/dev/null || true
  BUILT_FROM_CONTAINER=0
  regenerate_spec_locally
fi

if [ "$BUILT_FROM_CONTAINER" = "0" ]; then
  # The steps below shape a page the container has just produced. The local
  # path edits a page that already carries them, so applying them again would
  # duplicate the meta tags and shift every line the awk offsets depend on.
  exit 0
fi

awk 'NR==6{print "  <meta name=\"robots\" content=\"none\" />"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
awk 'NR==7{print "  <meta name=\"googlebot\" content=\"none\" />"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
sed -i '8d' app/templates/pages/index.html
awk -v TITLE="$(sed -n '3{s/^[[:space:]]*title:[[:space:]]*//;s/[[:space:]]*$//;p;q}' openapi.yaml)" 'NR==8{print "  <title>" TITLE " - Swagger UI</title>"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
# The two values that reach the published page, sourced from `.env` when there
# is one and defaulted when there is not.
#
# There is not one in CI, which is the job that regenerates this page and
# compares it against the committed copy. `. ./.env` under `set -u` left both
# variables unset, so every regeneration outside a developer's machine emptied
# the analytics attributes and the comparison failed — on a page nobody had
# touched. The check that exists to notice the page falling behind the spec was
# instead reporting the absence of a file it was never given.
#
# Defaulted rather than required, and defaulted to what the committed page
# already carries. Neither is a secret: both are served to every visitor of the
# published documentation, and the site identifier is meaningless without the
# analytics account it belongs to.
if [ -f ./.env ]; then
  # shellcheck disable=SC1090
  . <(tr -d '\r' < ./.env)
fi
UMAMI_ID="${UMAMI_ID:-761c60f7-71a2-4681-8da2-cb30d7754a32}"
API_HOST="${API_HOST:-cakradana-api.faizath.com}"

awk -v UMAMI_ID="$UMAMI_ID" -v API_HOST="$API_HOST" 'NR==11{print "  <script defer src=\"https://stat.faizath.com/script.js\" data-website-id=\"" UMAMI_ID "\" data-domains=\"" API_HOST "\"></script>"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
# BEGIN domain-notice
export _DOMAIN_NOTICE=$(cat <<'HTMLEOF'
<div id="domain-notice" style="
  font-family: 'Titillium Web', 'Open Sans', sans-serif;
  background: #fff;
  border: 1px solid #d8dde7;
  border-left: 4px solid #49cc90;
  border-radius: 4px;
  margin: 16px;
  padding: 16px 20px;
  position: relative;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
">
  <button onclick="(function(){document.getElementById('domain-notice').style.display='none';try{localStorage.setItem('ch-domain-notice-dismissed','1')}catch(e){}})()" style="
    position: absolute;
    top: 10px;
    right: 12px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    color: #7d8492;
    padding: 0 4px;
  " aria-label="Dismiss">&times;</button>
  <div style="text-align: center;">
    <p style="margin: 0 0 8px; font-size: 16px; font-weight: 600; color: #3b4151;">📢 Domain &amp; Email Migration Notice</p>
    <p style="margin: 0 0 8px; font-size: 13px; color: #3b4151;">From July 29th, 2026, Cakradana will transition to new domains as <code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:'Source Code Pro',monospace;font-size:12px;">cakradana.org</code> will not be renewed:</p>
    <p style="margin: 0; font-size: 13px; color: #3b4151; line-height: 1.8;">
      🌐 <strong>Website:</strong> <a href="https://cakradana.faizath.com" style="color:#49cc90;">cakradana.faizath.com</a> <span style="color:#7d8492;">(formerly <em>cakradana.org</em>)</span><br>
      ⚙️ <strong>API:</strong> <a href="https://cakradana-api.faizath.com" style="color:#49cc90;">cakradana-api.faizath.com</a> <span style="color:#7d8492;">(formerly <em>api.cakradana.org</em>)</span><br>
      📧 <strong>Email:</strong> <a href="mailto:contact@cakradana.faizath.com" style="color:#49cc90;">contact@cakradana.faizath.com</a> <span style="color:#7d8492;">(formerly <em>contact@cakradana.org</em>)</span><br>
      🛰️ <strong>CDN:</strong> <span style="color:#49cc90;">cakradana-cdn.faizath.com</span> <span style="color:#7d8492;">(formerly <em>cdn.cakradana.org</em>)</span><br>
      📈 <strong>Status Pages:</strong> <a href="https://status.faizath.com/status/cakradana" style="color:#49cc90;">status.faizath.com/status/cakradana</a> <span style="color:#7d8492;">(formerly <em>status.cakradana.org</em>)</span><br>    </p>
  </div>
</div>
<script>
  try { if (localStorage.getItem('ch-domain-notice-dismissed')) document.getElementById('domain-notice').style.display = 'none'; } catch(e) {}
</script>
HTMLEOF
)
python3 - "app/templates/pages/index.html" <<'INJEOF'
import os, sys
block = os.environ['_DOMAIN_NOTICE']
marker = '<div id="swagger-ui">'
path = sys.argv[1]
text = open(path).read()
if marker in text and 'id="domain-notice"' not in text:
    text = text.replace(marker, block + '\n' + marker, 1)
    open(path, 'w').write(text)
INJEOF
# END domain-notice
