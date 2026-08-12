const chunkGroups: Array<{ name: string; packages: string[] }> = [
  {
    name: "react-vendor",
    packages: ["/react/", "/react-dom/", "/scheduler/"]
  },
  {
    name: "editor-core",
    packages: [
      "/@codemirror/state/",
      "/@codemirror/view/",
      "/@lezer/common/",
      "/@marijn/find-cluster-break/",
      "/crelt/",
      "/style-mod/",
      "/w3c-keyname/"
    ]
  },
  {
    name: "editor-features",
    packages: [
      "/@codemirror/language/",
      "/@codemirror/lang-css/",
      "/@codemirror/lang-html/",
      "/@codemirror/lang-javascript/",
      "/@codemirror/lang-markdown/",
      "/@codemirror/autocomplete/",
      "/@codemirror/commands/",
      "/@codemirror/lint/",
      "/@codemirror/search/",
      "/@lezer/css/",
      "/@lezer/highlight/",
      "/@lezer/html/",
      "/@lezer/javascript/",
      "/@lezer/lr/",
      "/@lezer/markdown/",
      "/codemirror/"
    ]
  },
  {
    name: "markdown-vendor",
    packages: ["/katex/", "/markdown-it/", "/entities/", "/linkify-it/", "/mdurl/", "/uc.micro/"]
  },
  {
    name: "icon-vendor",
    packages: ["/lucide-react/"]
  }
];

export function windowsVendorChunkName(moduleId: string): string | undefined {
  const normalizedId = moduleId.replace(/\\/g, "/");
  if (!normalizedId.includes("/node_modules/")) return undefined;
  if (normalizedId.includes("/pdfjs-dist/")) return undefined;

  for (const group of chunkGroups) {
    if (group.packages.some((packagePath) => normalizedId.includes(`/node_modules${packagePath}`))) {
      return group.name;
    }
  }
  return "utility-vendor";
}
