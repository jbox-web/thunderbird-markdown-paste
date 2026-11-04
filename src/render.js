/*
 * Markdown to e-mail HTML. Pure: it never touches the compose document.
 *
 * Everything the recipient must see is written as inline styles, because a
 * stylesheet injected in the compose window does not travel with the message.
 */
(() => {
  "use strict";

  const MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  const BORDER = "1px solid #d0d7de";

  const ELEMENT_STYLES = {
    h1: `font-size: 2em; font-weight: 600; margin: 24px 0 16px; padding-bottom: 0.3em; border-bottom: ${BORDER};`,
    h2: `font-size: 1.5em; font-weight: 600; margin: 24px 0 16px; padding-bottom: 0.3em; border-bottom: ${BORDER};`,
    h3: "font-size: 1.25em; font-weight: 600; margin: 24px 0 16px;",
    h4: "font-size: 1em; font-weight: 600; margin: 24px 0 16px;",
    h5: "font-size: 0.875em; font-weight: 600; margin: 24px 0 16px;",
    h6: "font-size: 0.85em; font-weight: 600; margin: 24px 0 16px; color: #57606a;",
    p: "margin: 0 0 16px;",
    ul: "margin: 0 0 16px; padding-left: 2em;",
    ol: "margin: 0 0 16px; padding-left: 2em;",
    blockquote: "margin: 0 0 16px; padding: 0 1em; color: #57606a; border-left: 4px solid #d0d7de;",
    table: "margin: 0 0 16px; border-collapse: collapse;",
    th: `padding: 6px 13px; border: ${BORDER}; font-weight: 600;`,
    td: `padding: 6px 13px; border: ${BORDER};`,
    pre: "margin: 0 0 16px; padding: 16px; background-color: #f6f8fa; border-radius: 6px; line-height: 1.45; white-space: pre; overflow: auto;",
    code: `font-family: ${MONOSPACE}; font-size: 85%; padding: 0.2em 0.4em; background-color: #eff1f3; border-radius: 6px;`,
    hr: "height: 4px; margin: 24px 0; padding: 0; border: 0; background-color: #d0d7de;",
    a: "color: #0969da;",
    del: "color: #57606a;",
    img: "max-width: 100%;",
  };

  const CODE_BLOCK_STYLE = `font-family: ${MONOSPACE}; font-size: 85%;`;

  // highlight.js token classes, with the colours of its "github" theme.
  const TOKEN_COLORS = [
    ["#d73a49", ["keyword", "doctag", "template-tag", "template-variable", "type", "variable_language_"]],
    ["#6f42c1", ["title", "title_class_", "title_function_"]],
    ["#005cc5", ["attr", "attribute", "literal", "meta", "number", "operator", "selector-attr", "selector-class", "selector-id", "variable"]],
    ["#032f62", ["regexp", "string"]],
    ["#e36209", ["built_in", "symbol"]],
    ["#6a737d", ["comment", "code", "formula"]],
    ["#22863a", ["name", "quote", "selector-pseudo", "selector-tag"]],
  ];
  const TOKEN_COLOR_BY_CLASS = new Map(
    TOKEN_COLORS.flatMap(([color, names]) => names.map((name) => [`hljs-${name}`, color])),
  );

  // Tags that only describe how copied text looked: code editors and terminals
  // put these on the clipboard next to the Markdown source.
  const PRESENTATION_ONLY_TAGS = new Set([
    "HTML", "HEAD", "BODY", "META", "TITLE", "STYLE", "DIV", "SPAN", "BR", "PRE", "FONT",
  ]);
  const SOURCE_TEXT_LAYOUT = /white-space:\s*pre|<pre[\s>]/i;

  // Parsing is quadratic on some inputs and runs on the editor's thread.
  const MAX_MARKDOWN_LENGTH = 50000;

  const BLOCK_ELEMENTS = new Set([
    "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE",
    "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
  ]);

  const BLOCK_MARKDOWN = new Set(["heading", "list", "blockquote", "table", "hr"]);
  const INLINE_MARKDOWN = new Set(["codespan", "del", "image"]);

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        // A grammar failure must not lose the code: fall through to plain text.
      }
    }
    return escapeHtml(code);
  }

  const markdown = new marked.Marked({
    gfm: true,
    breaks: true,
    renderer: {
      code({ text, lang }) {
        const language = (lang || "").trim().split(/\s+/)[0];
        return `<pre><code>${highlight(text, language)}</code></pre>\n`;
      },
      // Pasted markup is content the user wants to show, not markup to execute.
      html({ text, block }) {
        return block ? `<p>${escapeHtml(text)}</p>\n` : escapeHtml(text);
      },
      // After a raw tag, marked stops escaping text and trusts it as markup.
      text(token) {
        return token.escaped && !token.tokens ? escapeHtml(token.text) : false;
      },
      // Mail clients strip form controls, so tasks are written as characters.
      checkbox({ checked }) {
        return checked ? "☑ " : "☐ ";
      },
    },
  });

  function hasInlineMarkdown(tokens = []) {
    return tokens.some((token, index) => {
      if (INLINE_MARKDOWN.has(token.type)) {
        return true;
      }
      if (token.type === "link") {
        // A bare URL or address is autolinked, but nobody wrote Markdown for it.
        const written = token.raw.replace(/^<|>$/g, "");
        return written !== token.text && written !== token.href;
      }
      if (token.type === "em" || token.type === "strong") {
        // "2*3*4" and "2**3**4" are arithmetic, "__init__(" is a Python name.
        const before = tokens[index - 1]?.raw ?? "";
        const after = tokens[index + 1]?.raw ?? "";
        const isDunderCall = token.raw.startsWith("__") && after.startsWith("(");
        return !/\w$/.test(before) && !/^\w/.test(after) && !isDunderCall;
      }
      return false;
    });
  }

  function isMarkdownBlock(token) {
    if (token.type === "heading") {
      // "Regards\n--\nName" is a signature, not a heading.
      return !/\n-{1,2}\s*$/.test(token.raw);
    }
    if (token.type === "list") {
      // "2024. was a good year" is a sentence, not a list.
      return !(token.ordered && token.items.length === 1 && token.start > 1);
    }
    return BLOCK_MARKDOWN.has(token.type);
  }

  function rendersToNothing(text) {
    const { body } = new DOMParser().parseFromString(render(text), "text/html");
    return !body.textContent.trim() && !body.querySelector("img");
  }

  function looksLikeMarkdown(text) {
    if (text.length > MAX_MARKDOWN_LENGTH) {
      return false;
    }
    const written = markdown.lexer(text).some((token) => {
      if (isMarkdownBlock(token)) {
        return true;
      }
      if (token.type === "code") {
        return token.codeBlockStyle !== "indented";
      }
      return token.type === "paragraph" && hasInlineMarkdown(token.tokens);
    });
    return written && !rendersToNothing(text);
  }

  function isRichHtml(html) {
    if (!html) {
      return false;
    }
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const onlyPresentation = [...parsed.querySelectorAll("*")].every((el) => PRESENTATION_ONLY_TAGS.has(el.tagName));
    // Code editors and terminals lay source text out verbatim; anything else
    // that was styled was styled on purpose.
    return !(onlyPresentation && SOURCE_TEXT_LAYOUT.test(html));
  }

  function shouldRenderPaste({ plain, html, hasFiles }) {
    return !hasFiles && !isRichHtml(html) && looksLikeMarkdown(plain);
  }

  // The HTML serializers put newlines between blocks. In the editor they are
  // real text nodes: a click between two blocks puts the caret inside one, on a
  // line that does not exist, and Delete then acts on the wrong content.
  function removeBlankTextBetweenBlocks(body) {
    const isBlockOrEdge = (node) => !node || BLOCK_ELEMENTS.has(node.nodeName);
    const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const blank = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        !node.nodeValue.trim() &&
        !node.parentElement.closest("pre, code") &&
        isBlockOrEdge(node.previousSibling) &&
        isBlockOrEdge(node.nextSibling)
      ) {
        blank.push(node);
      }
    }
    blank.forEach((node) => node.remove());
  }

  function applyInlineStyles(body) {
    for (const el of body.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      const inPre = tag === "code" && el.parentElement?.tagName === "PRE";
      const style = inPre ? CODE_BLOCK_STYLE : ELEMENT_STYLES[tag];
      const color = [...el.classList].map((name) => TOKEN_COLOR_BY_CLASS.get(name)).find(Boolean);
      if (style || color) {
        el.setAttribute("style", style ?? `color: ${color};`);
      }
      el.removeAttribute("class");
    }
  }

  // A definition nothing refers to would vanish from the message with its URL.
  function keepUnusedDefinitions(tokens, text) {
    return tokens.map((token) => {
      if (token.type !== "def") {
        return token;
      }
      const elsewhere = text.replace(token.raw, "").toLowerCase();
      const used = elsewhere.includes(`[${token.tag.toLowerCase()}]`);
      return used ? token : { type: "html", block: true, raw: token.raw, text: token.raw.trim() };
    });
  }

  function render(text) {
    const tokens = keepUnusedDefinitions(
      markdown.lexer(text).filter((token) => token.type !== "space"),
      text,
    );
    const inline = tokens.length === 1 && tokens[0].type === "paragraph";
    const raw = inline ? markdown.parseInline(text.trim()) : markdown.parser(tokens);
    const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["align"] });
    const parsed = new DOMParser().parseFromString(clean, "text/html");
    removeBlankTextBetweenBlocks(parsed.body);
    applyInlineStyles(parsed.body);
    return parsed.body.innerHTML;
  }

  globalThis.MarkdownPaste = { render, rendersToNothing, looksLikeMarkdown, shouldRenderPaste, MAX_MARKDOWN_LENGTH };
})();
