import { defineConfig } from "vitepress";

const BRAND_NAME = "überPrompt";
const BRAND_HTML = '<span class="u-pink">über</span>Prompt';

export default defineConfig({
  title: BRAND_NAME,
  description:
    "Prompt dependency graph & semantic sync for production AI systems",
  head: [
    [
      "link",
      {
        rel: "icon",
        href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%C3%BC</text></svg>",
      },
    ],
  ],
  transformPageData(pageData) {
    pageData.frontmatter.brand = BRAND_NAME;
    pageData.frontmatter.brandHtml = BRAND_HTML;
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "CLI Reference", link: "/cli/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
        ],
      },
      {
        text: "CLI Reference",
        items: [
          { text: "Overview", link: "/cli/" },
          { text: "graph", link: "/cli/graph" },
          { text: "affected", link: "/cli/affected" },
          { text: "infer", link: "/cli/infer" },
          { text: "init", link: "/cli/init" },
          { text: "collect", link: "/cli/collect" },
          { text: "tail", link: "/cli/tail" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/getclera/-berprompt" },
    ],
  },
});
