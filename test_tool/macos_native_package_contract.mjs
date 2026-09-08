#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const configuration = await readFile(
  "apps/macos/Sources/MathNotesMac/SidecarConfiguration.swift",
  "utf8"
);
const packager = await readFile("test_tool/package_macos_native.mjs", "utf8");
const appLaunchSmoke = await readFile("test_tool/macos_native_app_launch_smoke.swift", "utf8");
const workflow = await readFile(".github/workflows/package-macos-native.yml", "utf8");

assert.equal(
  rootPackage.scripts["package:macos:native"],
  "node test_tool/package_macos_native.mjs"
);
assert.match(rootPackage.scripts["test:macos:app-launch"], /macos-native-app\.png local/);
assert.match(rootPackage.scripts["test:macos:app-launch"], /macos-native-app-remote-error\.png companion/);
assert.match(rootPackage.scripts["test:macos:app-launch"], /macos-native-phone-connection\.png phone/);
assert.match(appLaunchSmoke, /UserDefaults\(suiteName: testBundleID\)/);
assert.match(appLaunchSmoke, /launchPreferences\.set\(workspaceSource, forKey: "mathnotes\.workspace\.source\.v1"\)/);
assert.doesNotMatch(appLaunchSmoke, /launchArguments = \["-mathnotes\.workspace\.source\.v1"/);
assert.match(appLaunchSmoke, /launchArguments\.append\("-mathnotes\.open-phone-connection"\)/);
assert.match(appLaunchSmoke, /sourceMode == "phone" \? 18 : sourceMode == "companion" \? 3 : 0\.5/);
assert.match(appLaunchSmoke, /production supervisor has a 15 second startup deadline/);
assert.match(appLaunchSmoke, /did not present the focused phone connection sheet/);
assert.match(appLaunchSmoke, /server\.listen\(1051, '0\.0\.0\.0'/);
assert.match(appLaunchSmoke, /tailscaleFixtureAddress = "100\.88\.42\.7"/);
assert.match(appLaunchSmoke, /MATHNOTES_TAILSCALE_CLI/);
assert.match(appLaunchSmoke, /owner\.contains\("securityagent"\)/);
assert.match(workflow, /security add-generic-password -U -s com\.mathnotes\.companion-host -a pairing-token/);
assert.match(workflow, /security add-generic-password -U -s com\.mathnotes\.provider-api-key -a recognition:mimo_2_5/);
assert.match(workflow, /defaults write com\.mathnotes\.native mathnotes\.provider\.settings\.v1 -data/);
assert.match(configuration, /Bundle\.main\.resourceURL/);
assert.match(configuration, /MathNotesRuntime/);
assert.match(configuration, /MathNotesPWA/);
assert.match(configuration, /MATHNOTES_PWA_STATIC_ROOT_DIR/);
assert.match(configuration, /MATHNOTES_NODE_EXECUTABLE/);
assert.match(configuration, /CompanionHostTokenStore\(environment: environment\)\.loadOrCreate\(\)/);
assert.match(configuration, /\.posixPermissions: 0o600/);
assert.doesNotMatch(configuration, /CompanionHostCredential|KeychainCredentialStore/);
assert.match(packager, /MACOS_HOST_REQUIRED/);
assert.match(packager, /core-server\.mjs/);
assert.match(packager, /run\("npm", \["run", "build:pwa"\]\)/);
assert.match(packager, /apps", "pwa", "dist/);
assert.match(packager, /MathNotesPWA/);
assert.match(packager, /await cp\(sourcePwa, pwaPath, \{ recursive: true \}\)/);
assert.match(packager, /MathNotesKaTeX/);
assert.match(packager, /katex\.min\.css/);
assert.match(packager, /process\.execPath/);
assert.match(packager, /run\("strip", \["-x", targetExecutable\]\)/);
assert.match(packager, /run\("strip", \["-x", targetNode\]\)/);
assert.match(packager, /run\(targetNode, \["--version"\]\)/);
assert.match(packager, /MACOS_NATIVE_NODE_BYTES_AFTER_STRIP/);
assert.match(packager, /Info\.plist/);
assert.match(packager, /codesign/);
assert.match(packager, /ditto/);
assert.ok(packager.indexOf('"com.mathnotes.runtime.node", targetNode') > packager.indexOf('run("strip", ["-x", targetNode])'));
assert.ok(packager.indexOf('"com.mathnotes.runtime.node", targetNode') < packager.indexOf('run(targetNode, ["--version"])'));
assert.ok(packager.indexOf('await probeSidecar(') > packager.indexOf('["--verify", "--deep", "--strict", appPath]'));
assert.match(packager, /MACOS_PACKAGED_RUNTIME_FAILED/);
assert.match(packager, /100\.64\.0\.0\/10/);
assert.doesNotMatch(packager, /<key>NSAllowsArbitraryLoads/);
assert.match(appLaunchSmoke, /MATHNOTES_PHASE1A_ROOT/);
assert.match(appLaunchSmoke, /MATHNOTES_COMPANION_TOKEN_FILE/);
assert.match(appLaunchSmoke, /-mathnotes\.directory\.notesRoot\.bookmark/);
assert.match(appLaunchSmoke, /plist\["CFBundleIdentifier"\] = testBundleID/);

console.log("MACOS_NATIVE_PACKAGE_CONTRACT_OK");
