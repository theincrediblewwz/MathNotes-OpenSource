import { describe, expect, it } from "vitest";
import { renderPortableMarkdown } from "./portableMarkdown.js";

describe("renderPortableMarkdown", () => {
  it("emits KaTeX HTML fallback for multi-line cases instead of relying on native MathML", async () => {
    const html = await renderPortableMarkdown({
      markdown: String.raw`
$$
\begin{cases}
\partial_t V + V \cdot \nabla V = 0, \\
\nabla \cdot V = 0.
\end{cases}
$$
`
    });

    expect(html).toContain("katex-mathml");
    expect(html).toContain("katex-html");
    expect(html).toContain("delimsizing");
    expect(html).not.toContain("math-error");
  });

  it("keeps adjacent Navier-Stokes display blocks distinct without leaking delimiters", async () => {
    const html = await renderPortableMarkdown({
      markdown: String.raw`
# Mathematical model

$$
\begin{cases}
\partial_t V + V \cdot \nabla V + \nabla P - \nu \Delta V = 0, \\
\nabla \cdot V = 0.
\end{cases}
$$

In the vorticity formulation
$$
\begin{cases}
\partial_t W + V \cdot \nabla W - \nu \Delta W = 0, \\
V = \nabla^\perp \Phi = \nabla^\perp \Delta^{-1} W, \\
V(x, \pm 1) = 0.
\end{cases}
$$

Special solution. Shear flows
$$
V_{\text{shear}} = (u_{\text{sh}}(t,y),0)
$$
$$
\partial_t u_{\text{sh}}(t,y)-\nu\partial_{yy}u_{\text{sh}}(t,y)=0
$$
`
    });

    expect(html.match(/class="math-display"/g)).toHaveLength(4);
    expect(html).not.toContain("math-error");
    expect(html).not.toMatch(/<p>\s*\$\$\s*<\/p>/);
  });

  it("keeps malformed display math readable instead of producing partial HTML", async () => {
    const html = await renderPortableMarkdown({
      markdown: String.raw`Before
$$
\begin{cases}
x=1
After`
    });

    expect(html).toContain('class="math-error"');
    expect(html).toContain("\\begin{cases}");
  });
});
