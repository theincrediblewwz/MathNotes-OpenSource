import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultIconPath = path.join(projectRoot, "apps", "windows", "assets", "mathnotes.ico");
const defaultElectronPath = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function parseVersion(version) {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid Windows version: ${version}`);
  }
  return parts;
}

function readExecutableResources(bytes) {
  const executable = NtExecutable.from(bytes);
  const resources = NtExecutableResource.from(executable);
  return { executable, resources };
}

function iconHashesFromExecutable(resources) {
  return resources.entries
    .filter((entry) => entry.type === 3)
    .map((entry) => sha256(entry.bin))
    .sort();
}

function iconHashesFromIco(iconFile) {
  return iconFile.icons.map((icon) => sha256(icon.data.bin)).sort();
}

export async function brandWindowsExecutable(exePath, {
  iconPath = defaultIconPath,
  version,
  companyName = "MathNotes",
  fileDescription = "MathNotes private mathematics notebook"
}) {
  const executableBytes = await readFile(exePath);
  const { executable, resources } = readExecutableResources(executableBytes);
  const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (iconGroups.length !== 1) {
    throw new Error(`Expected one Windows icon group, received ${iconGroups.length}`);
  }
  const iconFile = Data.IconFile.from(await readFile(iconPath));
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroups[0].id,
    iconGroups[0].lang,
    iconFile.icons.map((icon) => icon.data)
  );

  const versionInfo = Resource.VersionInfo.fromEntries(resources.entries);
  if (versionInfo.length !== 1) {
    throw new Error(`Expected one Windows version resource, received ${versionInfo.length}`);
  }
  const languages = versionInfo[0].getAllLanguagesForStringValues();
  if (languages.length !== 1) {
    throw new Error(`Expected one Windows version language, received ${languages.length}`);
  }
  const versionParts = parseVersion(version);
  versionInfo[0].setFileVersion(...versionParts);
  versionInfo[0].setProductVersion(...versionParts);
  versionInfo[0].setStringValues(languages[0], {
    CompanyName: companyName,
    FileDescription: fileDescription,
    FileVersion: version,
    InternalName: "MathNotes",
    OriginalFilename: "MathNotes.exe",
    ProductName: "MathNotes",
    ProductVersion: version
  });
  versionInfo[0].outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  await writeFile(exePath, Buffer.from(executable.generate()));
}

export async function assertWindowsExecutableBrand(exePath, {
  iconPath = defaultIconPath,
  electronPath = defaultElectronPath,
  version
}) {
  const [executableBytes, electronBytes, iconBytes] = await Promise.all([
    readFile(exePath),
    readFile(electronPath),
    readFile(iconPath)
  ]);
  if (sha256(executableBytes) === sha256(electronBytes)) {
    throw new Error("Packaged MathNotes.exe is byte-for-byte identical to electron.exe");
  }
  const { resources } = readExecutableResources(executableBytes);
  const actualIconHashes = iconHashesFromExecutable(resources);
  const expectedIconHashes = iconHashesFromIco(Data.IconFile.from(iconBytes));
  if (actualIconHashes.join(",") !== expectedIconHashes.join(",")) {
    throw new Error(`Packaged icon resources do not match mathnotes.ico (${actualIconHashes.length}/${expectedIconHashes.length})`);
  }
  const versionInfo = Resource.VersionInfo.fromEntries(resources.entries);
  const languages = versionInfo[0]?.getAllLanguagesForStringValues() ?? [];
  if (versionInfo.length !== 1 || languages.length !== 1) {
    throw new Error("Packaged executable has an invalid Windows version resource");
  }
  const values = versionInfo[0].getStringValues(languages[0]);
  const expectedValues = {
    CompanyName: "MathNotes",
    InternalName: "MathNotes",
    OriginalFilename: "MathNotes.exe",
    ProductName: "MathNotes",
    FileVersion: version,
    ProductVersion: version
  };
  for (const [key, expected] of Object.entries(expectedValues)) {
    if (values[key] !== expected) {
      throw new Error(`Unexpected ${key}: ${values[key] ?? "<missing>"}; expected ${expected}`);
    }
  }
  return {
    executableSha256: sha256(executableBytes),
    iconCount: actualIconHashes.length,
    productName: values.ProductName,
    version: values.ProductVersion
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exePath = process.argv[2];
  const version = process.argv[3];
  if (!exePath || !version) {
    throw new Error("Usage: node test_tool/windows_executable_brand.mjs <MathNotes.exe> <version>");
  }
  const result = await assertWindowsExecutableBrand(path.resolve(exePath), { version });
  console.log(`WINDOWS_EXE_BRAND_OK product=${result.productName} version=${result.version} icons=${result.iconCount} sha256=${result.executableSha256}`);
}
