#!/bin/bash
# Read-only package checks plus a temporary empty-data sidecar probe.
# Does not change Gatekeeper, quarantine, Keychain, networking, or saved notes.
set -u
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
cd -- "$(dirname -- "$0")" || exit 1

echo 'MathNotes Mac 连接诊断（不读取笔记）'
if [ "$(uname -s)" != Darwin ]; then
  echo '请在出现问题的 Mac 上运行。'
  exit 1
fi
app="${1:-}"
if [ -z "$app" ]; then
  app=$(osascript -e 'POSIX path of (choose file with prompt "请选择出现连接问题的 MathNotes.app" of type {"com.apple.application-bundle"})') || exit 1
fi
app="${app%/}"
node="$app/Contents/Resources/MathNotesRuntime/bin/node"
script="$app/Contents/Resources/MathNotesRuntime/core-server.mjs"
if [ ! -f "$node" ] || [ ! -f "$script" ]; then
  echo 'PACKAGE_RUNTIME_MISSING（所选应用缺少本机连接组件）'
  read -r -p '按回车关闭。' _
  exit 1
fi

echo '--- 请复制下面的诊断结果 ---'
echo "macOS=$(sw_vers -productVersion)"
echo "architecture=$(uname -m)"
echo "appVersion=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo unknown)"
echo "appBuild=$(/usr/libexec/PlistBuddy -c 'Print :MathNotesBuildRevision' "$app/Contents/Info.plist" 2>/dev/null || echo not-recorded)"
if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then echo 'bundleSignature=valid'; else echo 'bundleSignature=invalid'; fi
if xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then echo 'appQuarantine=present'; else echo 'appQuarantine=absent'; fi
if [ -x "$node" ]; then echo 'runtimeExecutable=yes'; else echo 'runtimeExecutable=no'; fi
# env -u affects only the diagnostic child, never the user's shell or host setup.
# A killed/blocked embedded Node is useful evidence even if no JS can execute.
env -u NODE_OPTIONS -u NODE_PATH "$node" diagnose_macos_connection.mjs "$app" 2>/dev/null &
probe_pid=$!
remaining=40
while kill -0 "$probe_pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
  sleep 1
  remaining=$((remaining - 1))
done
if [ "$remaining" -eq 0 ] && kill -0 "$probe_pid" 2>/dev/null; then
  kill -TERM "$probe_pid" 2>/dev/null || true
  sleep 1
  kill -KILL "$probe_pid" 2>/dev/null || true
  echo 'diagnosticTimeout=yes'
fi
wait "$probe_pid" 2>/dev/null
echo "runtimeExit=$?"
echo '--- 诊断结束 ---'
echo '把以上文字复制给我即可；无需发送笔记或钥匙串内容。'
read -r -p '按回车关闭。' _
