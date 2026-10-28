import { $, h, fill, renderFooterLegal } from "./common.js";

const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { dateStyle: "long" });

/** Safe markdown & media renderer conforming strictly to CSP without innerHTML */
function renderContent(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const elements = [];
  let inList = null; // 'ul' or 'ol'
  let listItems = [];

  function flushList() {
    if (inList && listItems.length) {
      elements.push(h(inList, {}, listItems));
      inList = null;
      listItems = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      flushList();
      continue;
    }

    // Heading 3
    if (line.startsWith("### ")) {
      flushList();
      elements.push(h("h3", {}, line.slice(4)));
      continue;
    }
    // Heading 2
    if (line.startsWith("## ")) {
      flushList();
      elements.push(h("h2", {}, line.slice(3)));
      continue;
    }
    // Blockquote
    if (line.startsWith("> ")) {
      flushList();
      elements.push(h("blockquote", {}, h("p", {}, line.slice(2))));
      continue;
    }
    // Bullet list
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (inList !== "ul") { flushList(); inList = "ul"; }
      listItems.push(h("li", {}, line.slice(2)));
      continue;
    }
    // Numbered list
    const numMatch = line.match(/^\d+\.\s+(.*)$/);
    if (numMatch) {
      if (inList !== "ol") { flushList(); inList = "ol"; }
      listItems.push(h("li", {}, numMatch[1]));
      continue;
    }

    // Media: YouTube embed
    const ytMatch = line.match(/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:\S*)?$/);
    if (ytMatch) {
      flushList();
      elements.push(h("div", { class: "media-embed ratio-16-9" },
        h("iframe", {
          src: `https://www.youtube-nocookie.com/embed/${ytMatch[1]}`,
          title: "YouTube video player",
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: "true",
          loading: "lazy",
        })
      ));
      continue;
    }

    // Media: Direct Video (.mp4, .webm)
    const vidMatch = line.match(/^(https?:\/\/\S+\.(mp4|webm))$/i);
    if (vidMatch) {
      flushList();
      elements.push(h("video", { controls: true, class: "media-video", playsinline: true },
        h("source", { src: vidMatch[1], type: `video/${vidMatch[2]}` })
      ));
      continue;
    }

    // Media: Image with caption ![caption](url)
    const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imgMatch) {
      flushList();
      const cap = imgMatch[1];
      const src = imgMatch[2];
      const fig = [h("img", { src, alt: cap || "Post image", loading: "lazy" })];
      if (cap) fig.push(h("figcaption", {}, cap));
      elements.push(h("figure", { class: "media-figure" }, fig));
      continue;
    }

    // Regular paragraph (inline links formatted safely)
    flushList();
    elements.push(renderParagraph(line));
  }
  flushList();
  return elements;
}

/** Formats inline links [text](url) and bold text */
function renderParagraph(text) {
  const parts = [];
  const linkRegex = /\[(.*?)\]\((.*?)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(h("a", { href: match[2], target: match[2].startsWith("http") ? "_blank" : undefined, rel: "noopener noreferrer" }, match[1]));
    lastIndex = linkRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return h("p", {}, parts.length ? parts : text);
}

/** Renders a single post card */
function renderPostCard(p) {
  const href = `/blog/${encodeURIComponent(p.slug)}/`;
  const thumbSrc = p.cover_image_url || "/assets/img/og-image.png";
  return h("a", { class: "post-card", href },
    h("img", { class: "post-card-thumb", src: thumbSrc, alt: p.title, loading: "lazy" }),
    h("div", { class: "post-card-body" },
      h("div", { class: "post-card-tag" }, p.topic || "Update"),
      h("time", { datetime: p.published_on }, fmtDate(p.published_on)),
      h("h3", {}, p.title),
      h("p", {}, (p.summary || String(p.body || "")).slice(0, 150) + "…")
    )
  );
}

async function load() {
  const app = $("blogApp");
  // Check slug from either pretty path /blog/post-slug/ or query /blog/?p=slug
  const pathParts = location.pathname.replace(/^\/blog\/?/, "").split("/").filter(Boolean);
  const prettySlug = pathParts[0] && !pathParts[0].endsWith(".html") ? pathParts[0] : null;
  const slug = prettySlug || new URLSearchParams(location.search).get("p");

  try {
    if (slug) {
      // SINGLE POST VIEW
      const r = await fetch("/api/updates?slug=" + encodeURIComponent(slug));
      if (!r.ok) throw new Error("not_found");
      const post = await r.json();

      document.title = `${post.title} | SMARTManatee`;
      const currentUrl = encodeURIComponent(location.href);
      const postTitle = encodeURIComponent(post.title);

      // Related posts (fetch recent, filter current)
      let relatedCards = [];
      try {
        const { posts } = await (await fetch("/api/updates")).json();
        const otherPosts = (posts || []).filter((x) => x.slug !== slug).slice(0, 2);
        if (otherPosts.length) {
          relatedCards = [
            h("section", { class: "related-posts" },
              h("h2", {}, "More from SMARTManatee"),
              h("div", { class: "cards two" }, otherPosts.map(renderPostCard))
            ),
          ];
        }
      } catch {}

      const singleView = h("div", { class: "wrap narrow" },
        // Breadcrumb
        h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" },
          h("a", { href: "/" }, "Home"),
          h("span", { class: "sep" }, "/"),
          h("a", { href: "/blog/" }, "Blog"),
          h("span", { class: "sep" }, "/"),
          h("span", {}, (post.title || "").slice(0, 36) + "…")
        ),
        // Article Header
        h("header", { class: "article-header" },
          h("div", { class: "article-eyebrow" }, post.topic || "Community News"),
          h("h1", { class: "article-headline" }, post.title),
          post.summary ? h("p", { class: "article-lede" }, post.summary) : null,
          h("div", { class: "post-meta-bar" },
            h("span", {}, "By ", h("strong", {}, post.author || "SMARTManatee Team")),
            h("span", {}, "·"),
            h("time", { datetime: post.published_on }, fmtDate(post.published_on)),
            h("span", {}, "·"),
            h("span", {}, post.reading_time || "2 min read")
          )
        ),
        // Hero / Cover photo
        post.cover_image_url ? h("img", { class: "hero-cover", src: post.cover_image_url, alt: post.title }) : null,
        post.caption ? h("figcaption", { class: "figcaption" }, post.caption) : null,
        // Article Body
        h("article", { class: "prose" }, renderContent(post.body)),
        // Social Share Bar
        h("div", { class: "share-bar" },
          h("span", { class: "share-label" }, "Share this update:"),
          h("a", { class: "share-btn", href: `https://www.facebook.com/sharer/sharer.php?u=${currentUrl}`, target: "_blank", rel: "noopener noreferrer" }, "Facebook"),
          h("a", { class: "share-btn", href: `https://nextdoor.com/share/?body=${postTitle}%20${currentUrl}`, target: "_blank", rel: "noopener noreferrer" }, "Nextdoor"),
          h("a", { class: "share-btn", href: `mailto:?subject=${postTitle}&body=Check out this update from SMARTManatee:%20${currentUrl}` }, "Email")
        ),
        // CTA Band
        h("div", { class: "cta-band" },
          h("div", {},
            h("span", { class: "eyebrow" }, "Support Our Community Challenge"),
            h("h3", {}, "Help protect our neighborhood")
          ),
          h("a", { class: "btn sun", href: "/donate/" }, "Make a pledge")
        ),
        // Related posts
        ...relatedCards,
        h("p", { class: "block" }, h("a", { href: "/blog/" }, "← Back to all updates"))
      );

      fill(app, singleView);
      return;
    }

    // BLOG LISTING VIEW (/blog/)
    document.title = "Blog & Updates | SMARTManatee";
    const { posts } = await (await fetch("/api/updates")).json();

    const listingView = h("div", { class: "wrap" },
      h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" },
        h("a", { href: "/" }, "Home"),
        h("span", { class: "sep" }, "/"),
        h("span", {}, "Blog")
      ),
      h("div", { class: "article-header" },
        h("div", { class: "article-eyebrow" }, "BLOG"),
        h("h1", { class: "article-headline" }, "Updates from SMART Manatee"),
        h("p", { class: "article-lede" }, "Dated news and reports from the community team. Follow along as we advocate for responsible development and a future nature park."),
        h("p", { class: "hint" }, h("a", { href: "/api/updates", target: "_blank" }, "Follow by RSS / JSON feed"))
      ),
      posts && posts.length
        ? h("div", { class: "cards three" }, posts.map(renderPostCard))
        : h("p", { class: "empty card" }, "No updates posted yet. Check back soon.")
    );

    fill(app, listingView);
  } catch (err) {
    fill(app, h("div", { class: "wrap narrow card note warn" },
      slug ? "That update could not be found or has been moved." : "Updates are temporarily unavailable. Please check back shortly.",
      h("p", {}, h("a", { href: "/blog/" }, "← View all updates"))
    ));
  }
}

load();
fetch("/api/ledger").then((r) => r.json()).then((d) => renderFooterLegal(d.org)).catch(() => {});
