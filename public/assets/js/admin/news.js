// Blog & Updates domain module
import { $, fill, h, emptyRow } from "../common.js";
import { state, note, showToast, setBtnLoading, btn, confirmAct, pager, friendly, today } from "./context.js";

let editingPost = null;
let allNews = [];
let newsPage = 0;
const NEWS_PAGE_SIZE = 10;

const slugify = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80).replace(/^-|-$/g, "");

function showPostEditor(show) {
  if ($("newsListCard")) $("newsListCard").hidden = show;
  if ($("newsEditorCard")) $("newsEditorCard").hidden = !show;
  if (show) {
    $("nHead")?.focus();
  }
}

function renderNewsTable() {
  const q = ($("newsSearch")?.value || "").toLowerCase().trim();
  const filter = $("newsFilter")?.value || "";
  const filtered = allNews.filter((p) => {
    if (filter === "published" && !p.published) return false;
    if (filter === "draft" && p.published) return false;
    if (q && !p.title.toLowerCase().includes(q) && !(p.summary || "").toLowerCase().includes(q)) return false;
    return true;
  });

  const total = filtered.length;
  const maxPage = Math.max(0, Math.ceil(total / NEWS_PAGE_SIZE) - 1);
  if (newsPage > maxPage) newsPage = maxPage;
  const start = newsPage * NEWS_PAGE_SIZE;
  const paged = filtered.slice(start, start + NEWS_PAGE_SIZE);

  fill($("newsRows"), paged.length ? paged.map((p) => h("tr", {},
    h("td", { class: "num" }, p.published_on),
    h("td", {},
      h("strong", {}, p.title),
      p.slug ? h("div", { class: "hint" }, `/blog/${p.slug}/`) : null
    ),
    h("td", {}, h("span", { class: p.published ? "pill ok" : "pill pend" }, p.published ? "Published" : "Draft")),
    h("td", { class: "r" },
      btn("Edit", () => { editPost(p); showPostEditor(true); }),
      p.published ? h("a", { class: "btn small ghost", href: `/blog/${p.slug}/`, target: "_blank", title: "View on public website" }, "View ↗") : null,
      btn("Delete", (e) => confirmAct(e.currentTarget, "Delete this article?", async () => {
        const res = await state.sb.from("posts").delete().eq("id", p.id);
        if (!res.error) showToast("Article deleted", "ok");
        return res;
      }, state.loaders.news))
    )
  )) : emptyRow(4, q || filter ? "No articles match your search." : "No articles yet. Click 'Create Blog Post' to write one."));

  pager($("newsPager"), newsPage, total, (p) => {
    newsPage = p;
    renderNewsTable();
  }, NEWS_PAGE_SIZE);
}

function editPost(p) {
  editingPost = p;
  if ($("nTitle")) $("nTitle").textContent = p ? "Edit blog post" : "New blog post";
  if ($("nHead")) $("nHead").value = p?.title || "";
  if ($("nSlug")) $("nSlug").value = p?.slug || "";
  if ($("nDate")) $("nDate").value = p?.published_on || today();
  if ($("nSummary")) $("nSummary").value = p?.summary || "";
  if ($("nPub")) $("nPub").checked = !!p?.published;
  if ($("nMsg")) $("nMsg").hidden = true;

  let body = p?.body || "";
  let author = "SMARTManatee Team", topic = "Community News", cover = "", caption = "";
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === "cover" || k === "cover_image_url") cover = v;
        if (k === "author") author = v;
        if (k === "topic" || k === "tag") topic = v;
        if (k === "caption") caption = v;
      }
    }
    body = fm[2].trim();
  }
  if ($("nAuthor")) $("nAuthor").value = author;
  if ($("nTopic")) $("nTopic").value = topic;
  if ($("nCover")) $("nCover").value = cover;
  if ($("nCaption")) $("nCaption").value = caption;
  if ($("nBody")) $("nBody").value = body;
}

export function initNews() {
  state.loaders.news = async () => {
    const { data, error } = await state.sb.from("posts").select("*").order("published_on", { ascending: false });
    if (error) return note($("status"), friendly(error), "err");
    allNews = data || [];
    renderNewsTable();
  };

  $("btnCreatePost")?.addEventListener("click", () => {
    editPost(null);
    showPostEditor(true);
  });
  $("btnBackToNews")?.addEventListener("click", () => showPostEditor(false));
  $("btnCancelEdit")?.addEventListener("click", () => showPostEditor(false));
  $("newsSearch")?.addEventListener("input", () => { newsPage = 0; renderNewsTable(); });
  $("newsFilter")?.addEventListener("change", () => { newsPage = 0; renderNewsTable(); });
  $("nNew")?.addEventListener("click", () => editPost(null));
  $("nHead")?.addEventListener("input", () => { if (!editingPost && $("nSlug")) $("nSlug").value = slugify($("nHead").value); });

  // Toolbar buttons for inserting markdown
  document.querySelectorAll(".editor-btn[data-ins]").forEach((b) => {
    b.addEventListener("click", () => {
      const ins = b.dataset.ins;
      const ta = $("nBody");
      if (!ta) return;
      const start = ta.selectionStart, end = ta.selectionEnd;
      const val = ta.value;
      ta.value = val.substring(0, start) + ins + val.substring(end);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + ins.length;
    });
  });

  // Image upload button into Supabase Storage bucket 'blog-media'
  $("nUploadBtn")?.addEventListener("click", () => $("nFile")?.click());
  $("nFile")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const btn = $("nUploadBtn");
    const finish = setBtnLoading(btn, "Uploading...");
    try {
      const ext = file.name.split(".").pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const { error: upErr } = await state.sb.storage.from("blog-media").upload(fileName, file);
      if (upErr) throw upErr;
      const { data: { publicUrl } } = state.sb.storage.from("blog-media").getPublicUrl(fileName);
      if ($("nCover")) $("nCover").value = publicUrl;
      finish(true);
      showToast("Cover image uploaded successfully!", "ok");
    } catch (err) {
      finish(false);
      showToast("Upload failed: " + (err.message || "error"), "err");
    } finally {
      e.target.value = "";
    }
  });

  $("nForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Saving post...");
    const title = $("nHead").value.trim(), slug = slugify($("nSlug").value || title);
    if (title.length < 3) { done(false); return note($("nMsg"), "Give the post a title.", "err"); }
    if (!slug) { done(false); return note($("nMsg"), "Give the post a web address (letters and numbers).", "err"); }

    const author = $("nAuthor")?.value.trim() || "SMARTManatee Team";
    const topic = $("nTopic")?.value.trim() || "Community News";
    const cover = $("nCover")?.value.trim() || "";
    const caption = $("nCaption")?.value.trim() || "";
    const rawBody = $("nBody").value.trim();

    const fmLines = [`author: ${author}`, `topic: ${topic}`];
    if (cover) fmLines.push(`cover: ${cover}`);
    if (caption) fmLines.push(`caption: ${caption}`);
    const formattedBody = `---\n${fmLines.join("\n")}\n---\n\n${rawBody}`;

    const row = {
      title,
      slug,
      published_on: $("nDate").value || today(),
      summary: $("nSummary").value.trim(),
      body: formattedBody,
      published: $("nPub").checked,
      updated_at: new Date().toISOString()
    };
    const { error } = editingPost
      ? await state.sb.from("posts").update(row).eq("id", editingPost.id)
      : await state.sb.from("posts").insert(row);
    if (error) { done(false); return note($("nMsg"), /duplicate|unique/i.test(error.message) ? "Another post already uses that web address." : friendly(error), "err"); }
    done(true);
    showToast(row.published ? "Post published successfully!" : "Post saved as draft", "ok");
    showPostEditor(false);
    editPost(null);
    state.loaders.news?.();
  });
}
